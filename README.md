# sreent/n8n

Our organisation's fork of [n8n](https://github.com/n8n-io/n8n), the workflow automation
platform. It is a modified version of n8n for internal business use only.

- The fork has no enterprise code of n8n. It has its own versions of the enterprise features, and
  they are on by default.
- It adds features of its own: Git sync, Send a copy, an audit log, Gateway credits on our own
  accounts with the AI providers, a publish check for open triggers, and more.
- It runs on a Linux server with Docker Compose, on Google Cloud Run, on Amazon ECS, on Azure
  Container Apps or on Kubernetes.

The fork is in a feature freeze. It gets only security fixes and updates from upstream n8n. New
work goes to a7c (`sreent/a7c`).

## Run it

The images are `ghcr.io/sreent/n8n` and `ghcr.io/sreent/n8n-runners`. Each image has the tag
`<n8n version>-<commit>` of each build from `master`, and `latest`.

| Where | Guide |
|---|---|
| A Linux server with Docker Compose | [deploy/README.md](deploy/README.md) |
| Google Cloud Run | [deploy/cloud-run/README.md](deploy/cloud-run/README.md) |
| Amazon ECS | [deploy/ecs/README.md](deploy/ecs/README.md) |
| Azure Container Apps | [deploy/container-apps/README.md](deploy/container-apps/README.md) |
| Kubernetes | [deploy/kubernetes/README.md](deploy/kubernetes/README.md) |

Four more guides help a platform team:

- [deploy/platform-setup-checklist.md](deploy/platform-setup-checklist.md): the steps that set up
  n8n for the users, from the server and the sign-in to the checks of each tier.
- [deploy/forgejo/README.md](deploy/forgejo/README.md): Forgejo, a private Git server for the Git
  features of n8n.
- [deploy/platform/README.md](deploy/platform/README.md): the setup tool, which makes the team
  projects, the SSO group rules and the team credentials from one config file.
- [deploy/ai-gateway-checks.md](deploy/ai-gateway-checks.md): the checks of Gateway credits.

## Features

### The enterprise features of n8n

The fork rebuilt these features as its own code:

- Sharing, team projects, the project roles, the admin role and custom roles.
- Sign-in with OIDC, SAML or LDAP, with role provisioning.
- External secrets from HashiCorp Vault, Infisical, 1Password, AWS, Azure and Google Cloud.
- Source control with Git, and Git connections that move work between instances.
- Workflow reviews before a publish.
- Variables, execution annotations and evaluations.
- Log streaming to webhook, syslog and Sentry destinations.
- Binary data and execution data in Amazon S3 or Azure Blob Storage.
- Multiple main instances, the worker view and worker pools.
- Dynamic credentials.

The fork also turns on the other licensed features of n8n: folders, debug in editor, workflow
diffs and named versions, insights without a limit of history, data redaction, node type policies,
API key scopes, MFA enforcement, the personal space policy, token exchange and a private registry
of community nodes.

One switch, `N8N_FORK_FEATURES_ENABLED`, turns all of them off. [FORK-ADOPTION.md](FORK-ADOPTION.md)
tells how this works, who sets up each feature, and an order to adopt them.
[FORK-FEATURES.md](FORK-FEATURES.md) tells the status of each feature.

### The features of the fork

- **Git sync**: connects a project to a branch of a Git repository, to push and pull its
  workflows.
- **Send a copy**: sends an independent copy of a workflow to colleagues. Each copy is a new
  workflow in the personal space of the colleague.
- **Audit log**: keeps the audit events for 90 days, on the page Settings > Audit log and in the
  public API.
- **Gateway credits**: users run AI nodes without an API key of their own. The gateway uses the
  credentials of an admin, records the cost of each call and stops the calls when a budget is
  spent.
- **Open triggers**: finds the webhooks, forms, public chats and MCP servers without
  authentication, and can stop a publish until a workflow review approves it.
- **Google Cloud**: binary data and execution data in Google Cloud Storage, and the node Google
  Cloud OCR, which reads text with the Cloud Vision API and Document AI.
- **Public API routes for reviews**: the insights of each workflow, an inventory of the workflows
  and of the open triggers, the API keys of all users, and the last activity of each user.

[FORK.md](FORK.md#what-the-fork-adds) links to the document of each feature.

### What the fork does not have

- The chat of the AI assistant and of the AI builder, and AI credits. They need a service of n8n.
- The registration of the Community Edition, enterprise trials and licence keys.
- In `deploy/`: the telemetry, the "What's new" notes and the update notices of n8n.

## The repository

Most of the repository is upstream n8n. The fork adds or changes these parts:

| Path | What it holds |
|---|---|
| `packages/cli/src/modules/` | The backend modules, with the fork modules (for example `git-sync`, `audit-log`, `ai-gateway`, `open-triggers`, `ldap`, `source-control`) |
| `packages/modules/*/frontend/` | The frontend modules of the fork features |
| `packages/` (other folders) | The rebuilt enterprise code. A `FORK.md` in a folder describes the fork code in it |
| `deploy/` | The deployment of the fork |
| `scripts/` | Container CI, upstream updates, installs in cloud sessions, and the Docker images |
| `vendor/` | The wa-sqlite package of the editor |

## Work on the fork

1. Read [FORK.md](FORK.md) first. It has the rules: the feature freeze, the clean room, the
   licence checks and the uniformity with core n8n. [AGENTS.md](AGENTS.md) has the conventions of
   n8n.
2. Use Node 24 and pnpm 12. Install with `pnpm install`, or with `scripts/cloud-install.sh` in a
   Claude Code cloud session.
3. Build with `pnpm build > build.log 2>&1`.
4. GitHub Actions is off. Run `scripts/container-ci.sh` before you push.
5. After a merge to `master`, build the images with `scripts/build-images.sh --push`.
6. To update from upstream n8n, run `scripts/sync-upstream.sh master`, and follow
   [FORK-UPSTREAM.md](FORK-UPSTREAM.md).

## Documents

| Document | What it tells |
|---|---|
| [FORK.md](FORK.md) | The rules of the fork, what it adds, the fork switch, and how to update from upstream |
| [FORK-FEATURES.md](FORK-FEATURES.md) | Each enterprise feature of n8n, its status in the fork, and the history of the fork |
| [FORK-UPSTREAM.md](FORK-UPSTREAM.md) | The checklist for an upstream update |
| [FORK-MAP.md](FORK-MAP.md) | The layers of the repository, the areas of fork code, and how each layer changes |
| [FORK-ADOPTION.md](FORK-ADOPTION.md) | How the enterprise features work for users, and how to adopt them |
| [deploy/README.md](deploy/README.md) | How to run the fork |
| A `README.md` or `FORK.md` in a module or folder | The design of that part |

## Licence

n8n is under the [Sustainable Use License](LICENSE.md) and the
[n8n Enterprise License](LICENSE_EE.md). This repository is a modified version of n8n.
[FORK.md](FORK.md) describes the changes. Use it for internal business use only.
