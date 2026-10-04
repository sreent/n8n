# FORK.md

This repository is `sreent/n8n`, a private fork of `n8n-io/n8n`. This file is for agents and
people who work on the fork. Where it differs from `AGENTS.md`, this file wins.

## What the fork adds

- **Git sync** and **Send a copy**: backend modules in `packages/cli/src/modules/git-sync` and
  `packages/cli/src/modules/send-copy`, and frontend modules in
  `packages/modules/git-sync/frontend` and `packages/modules/send-copy/frontend`. Their READMEs
  describe them.
- `deploy/`: runs the fork on a Linux server with Docker Compose.
- `vendor/`: the wa-sqlite package that the editor app installs. Upstream installs it from
  GitHub, which a cloud session cannot do. `scripts/vendor-wa-sqlite.sh` packs it from the
  upstream commit and gives the same file again.
- `scripts/container-ci.sh`, `scripts/sync-upstream.sh`, `scripts/cloud-install.sh` and
  `scripts/build-images.sh`: CI, upstream updates, installs in cloud sessions, and the Docker
  images.

## Rules

- **Clean room.** Do not open, read, edit or search the contents of enterprise files
  (`*.ee.*` files and `*.ee/` folders). Exclude them from searches, for example
  `rg --glob '!*.ee.*' --glob '!**/*.ee/**'`. Do not add permission scopes, and do not change
  or go around licence checks.
- Keep the changes to upstream files small. Each upstream update must merge them again.
- Open pull requests as ready for review, not as drafts.

## Cloud sessions

- The repository needs Node 24 and pnpm 12. The scripts in `scripts/` install them in
  `/opt/node24` when they are missing (`scripts/cloud-node.sh`), so the environment needs no
  setup script. Put `/opt/node24/bin` first on the `PATH`.
- Install the dependencies with `scripts/cloud-install.sh`, not with `pnpm install`. In a cloud
  session, a plain install fails on `@vscode/ripgrep`. The script also stops with a clear error
  when a repository that it downloads from is not attached.
- GitHub Actions is off in this fork. Run `scripts/container-ci.sh` before you push. Use
  `--plan` to see which tests it selects.

## Docker images

- `scripts/build-images.sh` builds the n8n image and the task runners image that `deploy/` runs.
  The tags are `<n8n version>-<commit>` and `latest`. Build from `master`, after the merge.
- `scripts/build-images.sh --push` also pushes the images to `ghcr.io/sreent`. It reads
  `REGISTRY_USERNAME` and `REGISTRY_PASSWORD` (a personal access token (classic) with the
  `write:packages` scope) from the environment. Set them in the environment settings. Do not put
  the token in a chat or a command.
- In a cloud session, start the Docker daemon (`dockerd`) in the background first. The script
  handles the session proxy and the pull limits of Docker Hub.

## Upstream updates

- `scripts/sync-upstream.sh master` merges the newest upstream code into the current branch.
  Then run `scripts/container-ci.sh --fork`, and open a pull request.
- `scripts/sync-upstream.base` holds the upstream commit that the fork matches. Only
  `scripts/sync-upstream.sh` changes it.
- When an upstream update changes the wa-sqlite commit in
  `packages/frontend/editor-ui/package.json`, keep the upstream line. Then run
  `scripts/vendor-wa-sqlite.sh`.
