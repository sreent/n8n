# FORK.md

This repository is `sreent/n8n`, a private fork of `n8n-io/n8n`. This file is for agents and
people who work on the fork. Where it differs from `AGENTS.md`, this file wins.

## What the fork adds

- **Git sync** and **Send a copy**: backend modules in `packages/cli/src/modules/git-sync` and
  `packages/cli/src/modules/send-copy`, and frontend modules in
  `packages/modules/git-sync/frontend` and `packages/modules/send-copy/frontend`. Their READMEs
  describe them.
- `deploy/`: runs the fork on a Linux server with Docker Compose.
- `scripts/container-ci.sh`, `scripts/sync-upstream.sh` and `scripts/cloud-install.sh`: CI,
  upstream updates, and installs in cloud sessions.

## Rules

- **Clean room.** Do not open, read, edit or search the contents of enterprise files
  (`*.ee.*` files and `*.ee/` folders). Exclude them from searches, for example
  `rg --glob '!*.ee.*' --glob '!**/*.ee/**'`. Do not add permission scopes, and do not change
  or go around licence checks.
- Keep the changes to upstream files small. Each upstream update must merge them again.
- Open pull requests as ready for review, not as drafts.

## Cloud sessions

- The repository needs Node 24 and pnpm 12. The environment setup script installs them in
  `/opt/node24`. Put `/opt/node24/bin` first on the `PATH`.
- Install the dependencies with `scripts/cloud-install.sh`, not with `pnpm install`. In a cloud
  session, a plain install fails on `@vscode/ripgrep`.
- GitHub Actions is off in this fork. Run `scripts/container-ci.sh` before you push. Use
  `--plan` to see which tests it selects.

## Upstream updates

- `scripts/sync-upstream.sh master` merges the newest upstream code into the current branch.
  Then run `scripts/container-ci.sh --fork`, and open a pull request.
- `scripts/sync-upstream.base` holds the upstream commit that the fork matches. Only
  `scripts/sync-upstream.sh` changes it.
