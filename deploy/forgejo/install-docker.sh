#!/usr/bin/env bash
# Installs Docker Engine with the Compose plugin from the apt repository of Docker, on Ubuntu or
# Debian, as https://docs.docker.com/engine/install/ tells. Run it once on the new VM with sudo.
set -euo pipefail

[ "$(id -u)" = 0 ] || {
	echo "Run it with sudo." >&2
	exit 1
}
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
	echo "Docker with the Compose plugin is installed."
	exit 0
fi

. /etc/os-release
case $ID in
ubuntu | debian) ;;
*)
	echo "This script supports Ubuntu and Debian only. See https://docs.docker.com/engine/install/." >&2
	exit 1
	;;
esac
codename=${UBUNTU_CODENAME:-$VERSION_CODENAME}

apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $codename
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker compose version
