# Run n8n on a Linux server

Fork tooling (not in upstream n8n). This folder runs the fork on one Linux server with Docker
Compose. It does not depend on a cloud provider: use a virtual machine on Azure, Google Cloud,
AWS, Hetzner or another provider, or your own hardware. To move to another provider, make a new
server and restore a backup.

```mermaid
flowchart LR
  users["Browsers and webhooks"] -- "HTTPS (443)" --> caddy["Caddy"]
  caddy --> n8n["n8n"]
  n8n -- "Code node scripts" --> runners["Task runners"]
  n8n --> postgres[("PostgreSQL")]
  postgres -- "backup.sh" --> backups[("backups/")]
```

| Service | Purpose |
|---|---|
| `caddy` | Gets and renews the HTTPS certificate for your domain, and sends the traffic to n8n |
| `n8n` | The fork's n8n image |
| `runners` | Runs the JavaScript and Python code of the Code nodes, apart from n8n |
| `postgres` | All n8n data, including the files from workflows |

Only Caddy is reachable from outside. n8n, the runners and PostgreSQL have no open ports.

## What you need

- A Linux virtual machine with an x86-64 (amd64) processor, 2 CPUs, 4 GB of memory and a 30 GB
  disk. Ubuntu 24.04 LTS is a good choice. The images are for x86-64 only.
- A domain name for n8n, for example `n8n.example.com`.
- Open ports 22 (SSH), 80 and 443 in the firewall of the provider.
- The n8n image and the runners image in a registry, and a token that can read them.
  `scripts/build-images.sh --push` in the repository builds the two images and pushes them to
  GitHub Container Registry.

## Install

1. Point the DNS record (type A) of the domain at the public IP address of the server.
2. Install Docker Engine with the Compose plugin. Follow
   <https://docs.docker.com/engine/install/> for your Linux distribution.
3. Copy this folder to the server, for example to `/opt/n8n`:

   ```bash
   scp -r deploy you@your-server:/opt/n8n
   ```

4. On the server, make the settings file and set the values in it. Make each secret with
   `openssl rand -hex 32`.

   ```bash
   cd /opt/n8n
   cp .env.example .env
   chmod 600 .env
   ```

5. Save `N8N_ENCRYPTION_KEY` in a password manager. A restore needs it.
6. Log in to the registry. For GitHub Container Registry, use a personal access token (classic)
   with the `read:packages` scope. Type the token at the prompt, not in the command.

   ```bash
   docker login ghcr.io -u your-github-user
   ```

7. Start n8n:

   ```bash
   docker compose up -d
   ```

8. Open `https://<your domain>` and make the owner account. n8n then asks you to set up
   two-factor authentication for it.

`docker compose ps` shows the four services. `docker compose logs -f n8n` shows the n8n log.

## Back up

- `backup.sh` writes a database backup to `backups/`. It removes backups that are older than
  14 days (set `KEEP_DAYS` to change this).
- Run it every night with cron (`sudo crontab -e`):

  ```text
  0 3 * * * /opt/n8n/backup.sh >> /opt/n8n/backups/backup.log 2>&1
  ```

- Copy `backups/` to storage outside the server, for example a storage bucket at another
  provider. A backup on the same disk is lost with the server.
- Do a test restore from time to time.

## Restore, or move to another server

1. On the new server, do steps 1 to 7 of [Install](#install). Use the same `.env`, so that
   `N8N_ENCRYPTION_KEY` is the same.
2. Copy the backup file to the server.
3. Restore it. The script asks for a confirmation, stops n8n, restores the database, and starts
   n8n again.

   ```bash
   ./restore.sh backups/n8n-<time>.dump
   ```

4. Point the DNS record at the new server.

## Update n8n

1. Make a backup. A new version can change the database.

   ```bash
   ./backup.sh
   ```

2. Get the new images and start them:

   ```bash
   docker compose pull
   docker compose up -d
   ```

To run a specific version, set its tag in `N8N_IMAGE` and in `N8N_RUNNERS_IMAGE`. Use the same
tag for the two images. A tag has the n8n version and the commit, for example
`2.42.0-fb1b129d21`. `latest` is the newest push.

## Development and production

Use two servers, one for development and one for production. Each server has its own domain and
its own `.env`. Connect both to the same Git branch in **Settings > Git sync**: push in
development, and pull in production. See the
[Git sync README](../packages/cli/src/modules/git-sync/README.md).

For the Git repository, you can run Forgejo, a private Git server, on its own VM in Google Cloud.
Each n8n instance then connects with its own token, and the users of n8n do not use Git. See
[forgejo/README.md](forgejo/README.md).

On the development server, set `NON_PRODUCTION_BANNER=true` in `.env`. Each page then shows a
banner that tells that the instance is not for production, so that users do not mix up the two
servers.

## End-user credentials

The fork turns on end-user credentials (dynamic credentials). Each user connects their own account
to an end-user credential, for example with the OAuth flow, and a run of that user uses it. For
webhooks of apps, an admin adds a credential resolver at **Settings > Credential resolvers**: an
OAuth2 server or a Slack app then identifies the user of each request. An app that calls the
endpoints of dynamic credentials sets `DYNAMIC_CREDENTIALS_CORS_ORIGIN` and
`DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN` in `.env`. See the
[README of the module](../packages/cli/src/modules/dynamic-credentials/README.md).

## AI gateway

The fork has its own AI gateway for Gateway credits. Users run AI nodes (OpenAI, Anthropic, Google
Gemini, Ollama and other providers) without an API key of their own. To set it up, an admin:

1. Creates a credential for each provider, with the API key of the organization. An Azure OpenAI
   credential can serve the OpenAI nodes, and a Google service account can serve the Gemini nodes
   and the open models of Vertex AI (for example Llama and DeepSeek) through Vertex AI. The fork
   node Google Cloud OCR reads text with the Cloud Vision API and Document AI through the gateway
   too.
2. Opens **Settings > AI gateway**, picks the credential of each provider, sets the monthly
   budget, and turns on the gateway.

Users then pick **Use Gateway credits** on a supported node. The gateway records the cost of each
call and stops the calls when a budget is spent. An admin adds top-ups and sets the prices on the
same page. This stack runs the nodes in the n8n container, so the gateway needs no setting in
`.env`. See the [README of the module](../packages/cli/src/modules/ai-gateway/README.md).

## Limits

- The scripts of the Code node can import only some modules: `crypto` and `moment` in
  JavaScript, and no modules in Python. To add modules, build an image from the runners image.
  See [Task runners](https://docs.n8n.io/hosting/configuration/task-runners/) in the n8n
  documentation.
- This setup runs one n8n instance on one server. The nightly backup is the protection against
  the loss of the server.
- This setup keeps the files of workflows in PostgreSQL. To keep them in a bucket of S3, Azure
  Blob or Google Cloud Storage, add the variables of
  [the FORK.md of the blob storage](../packages/@n8n/blob-storage/FORK.md#set-up) to the `n8n`
  service in a `docker-compose.override.yml`. The database backup then does not contain the
  files: back up the bucket too.
- This setup does not use queue mode. Queue mode with workers needs Redis and more containers. The
  fork then also gives the worker view (Settings > Workers), worker pools
  (`N8N_WORKER_POOLS_ENABLED=true`) and multiple main instances
  (`N8N_MULTI_MAIN_SETUP_ENABLED=true`). See
  [Queue mode](https://docs.n8n.io/hosting/scaling/queue-mode/) in the n8n documentation and
  [the FORK.md of the scaling code](../packages/cli/src/scaling/FORK.md).

## Safer defaults

This setup is for an organisation in which many people build workflows. It starts with these
defaults. Each line of `.env.example` tells how to change one of them.

| Default | What users notice | Change it in `.env` |
|---|---|---|
| SSRF protection | A node cannot call private, loopback or link-local addresses, also not the metadata server of the cloud. The error tells the user to ask an admin. | Open each internal host that workflows need: `SSRF_ALLOWED_HOSTNAMES`, `SSRF_ALLOWED_IP_RANGES`. `SSRF_PROTECTION=false` turns it off. |
| Sessions of 12 hours, not renewed | Users sign in again each day. With SSO, that is one click. | `SESSION_HOURS`, `SESSION_RENEWAL_HOURS` |
| Two-factor authentication | A user who signs in with a password (email or LDAP) sets up two-factor authentication first. OIDC and SAML users do not see it: their identity provider handles the second factor. | `MFA_ENFORCED` |
| No publishing and sharing from personal spaces | Users build and test in their personal spaces. They publish and share in team projects. The owner and the admins are not limited. | `PERSONAL_SPACE_PUBLISHING`, `PERSONAL_SPACE_SHARING` |
| Workflow reviews on | A user can send a workflow version to a reviewer. The approval publishes it. | `WORKFLOW_REVIEWS` |
| Limits for webhooks and forms | None until you set the IP ranges. Then other addresses get 403 for webhooks, chats and MCP servers, or for forms. | `WEBHOOK_ALLOWED_RANGES`, `FORM_ALLOWED_RANGES` |

- **The security policy comes from `.env`.** At each start, n8n sets two-factor enforcement, the
  personal space rules, workflow reviews and the redaction floor (`REDACTION_FLOOR`) from `.env`.
  Settings > Security & policies shows them read-only, so an admin account cannot loosen them.
  `SECURITY_POLICY_FROM_ENV=false` gives the page back to the admins.
- **The AI gateway stays open.** The AI nodes call the gateway of the fork on `127.0.0.1`, so SSRF
  protection always allows that address.
- **The IP limits use the address that Caddy sees.** When a load balancer or another proxy is in
  front of Caddy, set its ranges in the `trusted_proxies` option of the `Caddyfile`, else Caddy sees
  only the address of the proxy.
- **An existing server gets the defaults with its next update.** A `.env` without these lines uses
  the defaults of `docker-compose.yml`. Add the lines to `.env` before the update to keep the old
  behaviour.

## Security

- Keep the server up to date. On Ubuntu, `unattended-upgrades` installs the security updates.
- Open only ports 22, 80 and 443.
- `.env` holds the secrets. Only root must be able to read it.
- The scripts of the Code nodes run in the `runners` container, not in the n8n container. That
  container gets no database password and no encryption key. It connects to n8n with
  `N8N_RUNNERS_AUTH_TOKEN`.

## Governance

The owner and the admins see all workflows, also the workflows that users build in their personal
spaces. A user cannot hide a workflow from them.

- **See what users build.** The Overview page lists all workflows, and each card shows the owner.
  The filter **Owner** shows the workflows of one user. An admin can open each workflow, its
  executions and its versions.
- **The public API.** With an API key of the owner or an admin, `GET /api/v1/workflows` lists all
  workflows, `GET /api/v1/projects` lists all projects (also the personal projects),
  `GET /api/v1/users` lists the users and their roles, and `GET /api/v1/executions` lists the
  executions. `GET /api/v1/insights/by-workflow` gives the executions, the failures, the run time
  and the time saved of each workflow (scope `insights:read`). Give an API key only the scopes that
  it needs.
- **Reviews.** `GET /api/v1/inventory/workflows` gives each workflow in one call: its status, home
  project, owner, shares, node types, credentials, triggers and newest executions (scopes
  `workflow:list` and `execution:list`). `GET /api/v1/api-keys` lists the API keys of all users,
  with the scopes, the expiry and the last use, but not the values of the keys (scope
  `apiKey:manage`). `GET /api/v1/users` gives `lastActiveAt`, the day of the last request of each
  user: an old day or null shows an unused account. See
  [packages/cli/src/governance/README.md](../packages/cli/src/governance/README.md).
- **A weekly report.** The workflow `workflows/governance-report.json` uses these routes. Each
  Monday at 08:00 (in the time zone `TIMEZONE` of `.env`), it sends an email with the published
  workflows in personal spaces, the published workflows with failed executions or unpublished
  changes, the expired and unused API keys, the inactive users and the old invitations. To use
  it, open a new workflow and select **⋯ > Import > From file**. The note on the workflow tells
  how to set it up.
- **The audit log.** Settings > Audit log shows who created, changed, published, archived or deleted
  a workflow, and each execution, for 90 days. Each event keeps its project, so the filter
  **Project: Personal spaces** shows what users did in their personal spaces. An API key with the
  scope `auditLogs:manage` reads the same events with `GET /api/v1/audit-log/events` and
  `GET /api/v1/audit-log/export` (filter `projectType=personal`). Log streaming sends the same
  events to your log system.
- **Rules for personal spaces.** By default, users cannot publish or share the workflows of their
  personal spaces, and no execution data is hidden (`PERSONAL_SPACE_PUBLISHING`,
  `PERSONAL_SPACE_SHARING` and `REDACTION_FLOOR` in `.env`, see [Safer defaults](#safer-defaults)).
  With `SECURITY_POLICY_FROM_ENV=false`, an admin sets these rules on Settings > Security & policies
  instead.
- **Node types.** Node type policies limit the node types and the credential types of a project or
  of the instance. Write the rules with the public API (`/api/v1/node-type-policies` and
  `/api/v1/credential-type-policies`). The editor shows a lock on a blocked node type.
- **Two-factor sign-in.** By default, all users who sign in with a password (email or LDAP) must use
  two-factor authentication (2FA): a user without 2FA sets it up before they can work
  (`MFA_ENFORCED` in `.env`). OIDC and SAML users sign in through your identity provider, which
  handles their second factor. With `SECURITY_POLICY_FROM_ENV=false`, an admin who uses 2FA sets the rule
  on Settings > Security & policies instead.
- **Workflow history.** n8n keeps each saved version of a workflow. The workflow history shows who
  saved each version, compares two versions, and can give a version a name. By default, n8n keeps
  all versions. `WORKFLOW_HISTORY_PRUNE_TIME` in `.env` sets the hours that n8n keeps old
  versions.
- **Community nodes from your own registry.** To install community nodes only from a registry
  that you control, for example AWS CodeArtifact, Azure Artifacts or Google Artifact Registry, set
  `COMMUNITY_PACKAGES_REGISTRY` and `COMMUNITY_PACKAGES_AUTH_TOKEN` in `.env`.
- **Team projects for users.** By default, only the owner and the admins can create team projects.
  To let some users create them, add a role on Settings > Roles > Instance roles with the
  permission **Projects: Create**, and give the role to these users. With SSO, a role mapping rule
  can give the role to a group. The user who creates a team project becomes its admin.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | The four services |
| `Caddyfile` | The HTTPS proxy, with the IP limits for webhooks and forms |
| `.env.example` | The settings. Copy it to `.env` |
| `backup.sh` | Makes a database backup |
| `restore.sh` | Restores a backup |
| `workflows/governance-report.json` | A workflow that sends a weekly governance report by email |
| `forgejo/` | Forgejo, a private Git server for the Git features, on its own VM in Google Cloud |
