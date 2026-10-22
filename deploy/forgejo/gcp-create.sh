#!/usr/bin/env bash
# Makes the Google Cloud resources of the Forgejo VM with the Google Cloud CLI. Run it on your
# computer or in Cloud Shell, not on the VM. It skips each resource that exists, so you can run it
# again. DRY_RUN=1 shows the commands and runs nothing. See README.md.
#
# Required:
#   PROJECT             The project ID.
#   REGION, ZONE        For example asia-southeast1 and asia-southeast1-b.
#   DOMAIN              The internal name of Forgejo, for example git.corp.internal. It must be
#                       the same as FORGEJO_DOMAIN in .env.
#   N8N_SOURCE_RANGES   The internal IP addresses of the n8n servers as ranges, separated by
#                       commas, for example 10.10.0.5/32,10.10.0.6/32. Only these ranges reach
#                       Forgejo.
#   BACKUP_BUCKET       A new bucket name for the backups, without gs://.
#
# Optional (default):
#   NETWORK (default), SUBNET (default), VM_NAME (forgejo), MACHINE_TYPE (e2-small),
#   DISK_SIZE (20GB), IMAGE_FAMILY (ubuntu-2404-lts-amd64), IMAGE_PROJECT (ubuntu-os-cloud),
#   CREATE_NAT (yes: a Cloud Router with Cloud NAT, so the VM can download updates and images
#   without a public IP address), DNS_ZONE (the name of a private zone for the parent domain;
#   the script makes it when it does not exist), SNAPSHOT_DAYS (14), BACKUP_DAYS (30).
set -euo pipefail

: "${PROJECT:?Set PROJECT}" "${REGION:?Set REGION}" "${ZONE:?Set ZONE}" "${DOMAIN:?Set DOMAIN}"
: "${N8N_SOURCE_RANGES:?Set N8N_SOURCE_RANGES}" "${BACKUP_BUCKET:?Set BACKUP_BUCKET}"
NETWORK=${NETWORK:-default}
SUBNET=${SUBNET:-default}
VM_NAME=${VM_NAME:-forgejo}
MACHINE_TYPE=${MACHINE_TYPE:-e2-small}
DISK_SIZE=${DISK_SIZE:-20GB}
IMAGE_FAMILY=${IMAGE_FAMILY:-ubuntu-2404-lts-amd64}
IMAGE_PROJECT=${IMAGE_PROJECT:-ubuntu-os-cloud}
CREATE_NAT=${CREATE_NAT:-yes}
PARENT_DOMAIN=${DOMAIN#*.}
DNS_ZONE=${DNS_ZONE:-${PARENT_DOMAIN//./-}}
SNAPSHOT_DAYS=${SNAPSHOT_DAYS:-14}
BACKUP_DAYS=${BACKUP_DAYS:-30}
SERVICE_ACCOUNT="$VM_NAME-vm@$PROJECT.iam.gserviceaccount.com"
# The IP range of Identity-Aware Proxy, for SSH and for the tunnel to the web interface.
IAP_RANGE=35.235.240.0/20

[[ $DOMAIN == *.* ]] || {
	echo "DOMAIN needs a parent domain, for example git.corp.internal." >&2
	exit 1
}

run() {
	echo "+ $*"
	[ -n "${DRY_RUN:-}" ] || "$@"
}

# True when the resource exists. In a dry run, no resource exists.
exists() {
	[ -z "${DRY_RUN:-}" ] && "$@" >/dev/null 2>&1
}

g() {
	gcloud --project="$PROJECT" --quiet "$@"
}

echo "== APIs"
run g services enable compute.googleapis.com dns.googleapis.com iap.googleapis.com \
	storage.googleapis.com

echo "== Service account of the VM"
if ! exists g iam service-accounts describe "$SERVICE_ACCOUNT"; then
	run g iam service-accounts create "$VM_NAME-vm" --display-name="Forgejo VM"
fi

echo "== Bucket for the backups"
if ! exists g storage buckets describe "gs://$BACKUP_BUCKET"; then
	run g storage buckets create "gs://$BACKUP_BUCKET" --location="$REGION" \
		--uniform-bucket-level-access --public-access-prevention
fi
lifecycle=$(mktemp)
trap 'rm -f "$lifecycle"' EXIT
printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":%s}}]}\n' "$BACKUP_DAYS" >"$lifecycle"
run g storage buckets update "gs://$BACKUP_BUCKET" --lifecycle-file="$lifecycle"
# The VM can add backups and read them for a restore. It cannot delete or replace them.
for role in roles/storage.objectCreator roles/storage.objectViewer; do
	run g storage buckets add-iam-policy-binding "gs://$BACKUP_BUCKET" \
		--member="serviceAccount:$SERVICE_ACCOUNT" --role="$role"
done

echo "== Internal IP address"
if ! exists g compute addresses describe "$VM_NAME-ip" --region="$REGION"; then
	run g compute addresses create "$VM_NAME-ip" --region="$REGION" --subnet="$SUBNET"
fi
if [ -n "${DRY_RUN:-}" ]; then
	ADDRESS="<internal address>"
else
	ADDRESS=$(g compute addresses describe "$VM_NAME-ip" --region="$REGION" --format='value(address)')
fi
echo "Internal address: $ADDRESS"

echo "== Firewall"
if ! exists g compute firewall-rules describe "$VM_NAME-allow-n8n"; then
	run g compute firewall-rules create "$VM_NAME-allow-n8n" --network="$NETWORK" \
		--direction=INGRESS --action=ALLOW --rules=tcp:443 \
		--source-ranges="$N8N_SOURCE_RANGES" --target-tags="$VM_NAME"
fi
if ! exists g compute firewall-rules describe "$VM_NAME-allow-iap"; then
	run g compute firewall-rules create "$VM_NAME-allow-iap" --network="$NETWORK" \
		--direction=INGRESS --action=ALLOW --rules=tcp:22,tcp:443 \
		--source-ranges="$IAP_RANGE" --target-tags="$VM_NAME"
fi

if [ "$CREATE_NAT" = yes ]; then
	echo "== Cloud NAT"
	if ! exists g compute routers describe "$NETWORK-router" --region="$REGION"; then
		run g compute routers create "$NETWORK-router" --network="$NETWORK" --region="$REGION"
	fi
	if ! exists g compute routers nats describe "$NETWORK-nat" --router="$NETWORK-router" --region="$REGION"; then
		run g compute routers nats create "$NETWORK-nat" --router="$NETWORK-router" \
			--region="$REGION" --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges
	fi
fi

echo "== VM"
if ! exists g compute instances describe "$VM_NAME" --zone="$ZONE"; then
	run g compute instances create "$VM_NAME" --zone="$ZONE" --machine-type="$MACHINE_TYPE" \
		--subnet="$SUBNET" --private-network-ip="$ADDRESS" --no-address \
		--image-family="$IMAGE_FAMILY" --image-project="$IMAGE_PROJECT" \
		--boot-disk-size="$DISK_SIZE" --boot-disk-type=pd-balanced \
		--service-account="$SERVICE_ACCOUNT" --scopes=cloud-platform --tags="$VM_NAME" \
		--shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
		--metadata=enable-oslogin=TRUE --deletion-protection
fi

echo "== Daily snapshots of the disk"
if ! exists g compute resource-policies describe "$VM_NAME-daily" --region="$REGION"; then
	run g compute resource-policies create snapshot-schedule "$VM_NAME-daily" --region="$REGION" \
		--daily-schedule --start-time=04:00 --max-retention-days="$SNAPSHOT_DAYS" \
		--on-source-disk-delete=keep-auto-snapshots
fi
policies=""
if [ -z "${DRY_RUN:-}" ]; then
	policies=$(g compute disks describe "$VM_NAME" --zone="$ZONE" --format='value(resourcePolicies)')
fi
if [[ $policies != *"/$VM_NAME-daily"* ]]; then
	run g compute disks add-resource-policies "$VM_NAME" --zone="$ZONE" \
		--resource-policies="$VM_NAME-daily"
fi

echo "== Internal name"
if ! exists g dns managed-zones describe "$DNS_ZONE"; then
	run g dns managed-zones create "$DNS_ZONE" --dns-name="$PARENT_DOMAIN." --visibility=private \
		--networks="$NETWORK" --description="Internal names"
fi
if ! exists g dns record-sets describe "$DOMAIN." --type=A --zone="$DNS_ZONE"; then
	run g dns record-sets create "$DOMAIN." --zone="$DNS_ZONE" --type=A --ttl=300 \
		--rrdatas="$ADDRESS"
fi

cat <<EOF

The resources are ready. Next steps (README.md, "Install"):
  gcloud compute scp --recurse --tunnel-through-iap --zone=$ZONE --project=$PROJECT deploy/forgejo $VM_NAME:~/
  gcloud compute ssh $VM_NAME --tunnel-through-iap --zone=$ZONE --project=$PROJECT
EOF
