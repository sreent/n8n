# Source control (fork module)

This module is fork code (not in upstream n8n). It connects an instance to a branch of a Git
repository. Users push workflows and other resources from the instance to the branch, and pull
them from the branch into the instance. Each instance of an environment (for example development
and production) connects to its own branch. The module replaces the enterprise module
`source-control.ee`, which the fork removed. It behaves as the original: the golden tests of
`packages/cli/test/integration/source-control` were recorded against the original module, and
this module gives the same snapshots.

The feature turns on with the licence value `feat:sourceControl`. The fork switch gives it
(`packages/cli/src/fork-features.ts`, step 5 of `FORK.md`). With
`N8N_FORK_FEATURES_ENABLED=false`, the licence decides, as in upstream n8n.

## Sources

The module is a clean-room rebuild. It uses only these sources:

- The public n8n documentation of
  [source control and environments](https://docs.n8n.io/source-control-environments/).
- The ordinary code that used the original module: the DTOs of `@n8n/api-types`
  (`dto/source-control`, `schemas/source-controlled-file.schema.ts`), the public API controller
  (`public-api/v1/controllers/source-control.public.controller.ts`), the telemetry events
  (`events/maps/relay.event-map.ts`), `services/instance-write-access.service.ts`, the read-only
  test of the data table controller and the telemetry pulse.
- The behaviour of the original module in a running n8n: the golden tests of this module were
  recorded against it, with a local Git server over HTTPS (see "Tests").

## What it does

- **Preferences** (`/rest/source-control/preferences`): the repository URL, the branch, the
  connection type (`ssh` or `https`), the color of the branch and the read-only flag
  (`branchReadOnly`, a protected instance). The settings row `features.sourceControl` holds them.
  An instance starts with an SSH key pair (ed25519, or the type of
  `N8N_SOURCECONTROL_DEFAULT_SSH_KEY_TYPE`) in the row `features.sourceControl.sshKeys`. The
  HTTPS user name and password are in the row `features.sourceControl.httpsCredentials`. The
  private key, the user name and the password are encrypted with `cipher.encryptV2`.
- **Connection** (`POST /preferences`): the module clones the branch that `HEAD` of the remote
  names into the work folder `<n8n folder>/git`. An empty repository gets a first commit with a
  `README.md`. A failed connection resets the preferences, except the connection type and the key
  pair. `initRepo: false` saves the preferences only. `POST /disconnect` deletes the work folder
  and the HTTPS credentials. The key pair stays.
- **Branches** (`GET /get-branches`, `PATCH /preferences` with `branchName`): the branches of the
  remote, and a change of the branch of the work folder.
- **Status** (`GET /get-status`, `GET /status`): a fetch of the branch, then a comparison of the
  instance with the files of the branch, for a push or for a pull. `verbose=true` gives all lists
  of the comparison. A project admin sees only the resources of the projects where the role has
  `sourceControl:push`. A status for a pull leaves out the projects that only the instance has,
  because a pull does not delete projects.
- **Push** (`POST /push-workfolder`): the module writes the selected entries of a fresh status to
  the work folder, commits them as the pushing user and pushes the commit. An entry in conflict
  needs `force`. Each push writes `tags.json` again. A selected variable or folder writes all
  variables or folders. A protected instance cannot push.
- **Pull** (`POST /pull-workfolder`): the instance gets the resources of the branch, and loses
  the resources that the branch does not have, except projects. An entry in conflict needs
  `force`. `autoPublish` (`none`, `published` or `all`) publishes the imported workflows. A
  publication error goes to `publishingError` of the entry. The content import policy checks each
  new or changed workflow and each new credential (transport `source-control`): a refused one is
  skipped, and its entry gets `contentImportPolicy`.
- **Remote content** (`GET /remote-content/workflow/:id`): a workflow file of the branch, for the
  diff view of the editor.
- **Public API** (`/api/v1/source-control/status`, `/push`, `/pull`): the upstream controller,
  with the import paths of this module.
- **Protected instance**: `InstanceWriteAccessService` follows `branchReadOnly`. Other instance
  types read the preferences only, for this flag, and read them again when a main instance sends
  the command `reload-source-control-config`.
- **Telemetry**: the events `source-control-settings-updated`, `source-control-user-started-push-ui`,
  `source-control-user-finished-push-ui`, `source-control-user-started-pull-ui`,
  `source-control-user-finished-pull-ui` and `source-control-user-pulled-api`, as in the original.

## The files of the branch

| File | Content |
|---|---|
| `workflows/<id>.json` | A workflow, with its owner (a personal project by email, or a team project). |
| `credential_stubs/<id>.json` | A credential without secrets: strings become empty, except expressions. |
| `variable_stubs.json` | The global variables, without values. |
| `tags.json` | The tags, and the tags of the workflows that the pushing user may push. |
| `folders.json` | The folders of the projects that the pushing user may push. |
| `projects/<id>.json` | A team project, with the variables of the project without values. |
| `datatables/<id>.json` | A data table: the columns, not the rows. |

## Code

| File | Role |
|---|---|
| `source-control.module.ts` | Starts the module with the licence value. |
| `source-control.controller.ts` | The REST API (`/rest/source-control`). |
| `source-control.middleware.ts` | The answer 412 of the routes that need a connection. |
| `source-control.service.ts` | Connection, status, push, pull and the work folder. |
| `source-control-scoped.service.ts` | The access checks that depend on projects. |
| `source-control-preferences.service.ts` | Preferences, key pair and HTTPS credentials. |
| `source-control-git.service.ts` | Runs Git with a fixed environment. |
| `source-control-resources.service.ts` | Reads the resources of the instance and of the branch. |
| `source-control-status.service.ts` | Compares the instance with the branch. |
| `source-control-export.service.ts` | Writes the files of a push. |
| `source-control-import.service.ts` | Writes the resources of a pull to the database. |
| `source-control-helper.ts` | The numbers of the telemetry events. |

## Git

The module runs the `git` program of the host with `PATH=/usr/bin:/bin`, as the original. The
n8n Docker image has `git` and `ssh`. Over SSH, `GIT_SSH_COMMAND` uses the key pair of the
preferences and `<n8n folder>/ssh/known_hosts` (`StrictHostKeyChecking=accept-new`). Over HTTPS,
a credential helper gives the stored user name and password, `GIT_SSL_CAINFO` and
`GIT_SSL_CAPATH` of the environment apply, and the proxy of the environment applies
(`resolveProxyUrl`). An error of Git is the message of the answer.

Source control and Git connections take the `PATH`, the credential helper, the variables of a
private certificate authority and the largest output of a Git call (256 MB) from
`packages/cli/src/utils/git-process.ts`. Git sync takes the last two from there too.

Git gets the repository URL after `--`, and runs with `-c protocol.ext.allow=never`. The
preferences accept only a repository URL that does not start with `-`. The service runs its work
folder operations one at a time: the connection, the changes of the preferences and the branch,
the disconnection, the branches, the status, the push, the pull, the reset and the remote content.

## Tests

- `packages/cli/test/integration/source-control/source-control-settings.golden.test.ts`: the
  preferences, the key pairs, the connection over HTTPS to a local Git server, the branches, the
  protected instance, the routes as each role and without the licence.
- `source-control-push.golden.test.ts`: the status for a push as each role, pushes of all and of
  some files, conflicts with and without force, and the files and commits of the branch.
- `source-control-pull.golden.test.ts`: the status for a pull, pulls with and without force and
  with each mode of automatic publishing, and the rows that each pull changes.
- `source-control.public-api.test.ts`: the three routes of the public API.

The snapshots of the golden tests were recorded against the original module in a checkout of
the upstream commit of `scripts/sync-upstream.base`, as FORK.md tells. The tests start a local Git
server (`git-http-server.ts`), a fake `ssh` program (`git-remote.ts`) and a proxy
(`connect-proxy.ts`). The fork changed two lines of the tests after the recording, without an
effect on the snapshots: the push test gives no ids to `saveCredential` (the database gives them),
and the pull test masks the random id of a column.

## Differences from the original

- A push without a commit message uses `Push from n8n`. The message of the original is not known.
- A pull deletes a folder only after its workflows moved to the root of the project. The
  database would delete the workflows with the folder.
- While the data table module is off, the status and the pull leave out data tables.
- A repository URL that starts with `-` is an invalid preference.
- The work folder operations run one at a time. The tests do not show if the original does
  this.

## Upstream updates

When an upstream update changes the public API controller
`public-api/v1/controllers/source-control.public.controller.ts`, keep the import paths of this
module. When it changes the DTOs of `@n8n/api-types/src/dto/source-control`, the schema of
`SourceControlledFile` or the events of source control, change this module. The golden tests
fail when the behaviour changes.
