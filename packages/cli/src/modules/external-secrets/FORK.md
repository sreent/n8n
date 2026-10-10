# The fork's external secrets

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../FORK.md) and
[FORK-FEATURES.md](../../../../../FORK-FEATURES.md).

This folder holds the fork's external secrets: the replacement of the enterprise module
`modules/external-secrets.ee`. The repository owner chose these on 2026-10-10:

- The fork builds all six providers of the public documentation, as a drop-in replacement: 1Password
  Connect, AWS Secrets Manager, Azure Key Vault, GCP Secrets Manager, HashiCorp Vault and Infisical.
- The licence check (`feat:externalSecrets`) stays until step 5 of FORK.md. In step 5, external
  secrets turn on by default, as SSO does.
- Container CI leaves out the enterprise external secrets tests, as for SSO.

The work comes in four pull requests:

1. The base class of the providers, the config, the provider registry, and three providers:
   HashiCorp Vault, Infisical and 1Password Connect. (This pull request.)
2. The providers AWS Secrets Manager, Azure Key Vault and GCP Secrets Manager.
3. The module: the manager, the stored settings and connections, the REST APIs, the access checks,
   the events and the two repositories of `@n8n/db`. Ordinary code then uses this folder, and
   container CI leaves out the enterprise tests.
4. The editor: the settings pages, the modals, the store and the REST clients.

Until pull request 3, ordinary code uses the enterprise module. Only the golden tests use the files
of this folder. The module registry loads `external-secrets/external-secrets.module.ts` before
`external-secrets.ee/external-secrets.module.ts`, so this folder gets that file only in pull request
3.

## Behaviour

### The settings (`external-secrets.config.ts`)

| Variable | Default | Use |
|---|---|---|
| `N8N_EXTERNAL_SECRETS_UPDATE_INTERVAL` | 300 | How often n8n reads the secrets again, in seconds (used from pull request 3). |
| `N8N_EXTERNAL_SECRETS_CONNECT_TIMEOUT` | 20 | The maximum time of a connect, in seconds. |
| `N8N_EXTERNAL_SECRETS_REFRESH_TIMEOUT` | 20 | The maximum time of a read of the secrets, in seconds. Vault and Infisical stop each HTTP request after the larger of the two timeouts. |

### The base class (`types.ts`)

A provider extends `SecretsProvider`. It has a `name`, a `displayName` and the fields of its
settings form (`properties`). It implements `init(settings)`, `doConnect()`, `disconnect()`,
`update()`, `test()`, `getSecret(name)`, `hasSecret(name)` and `getSecretNames()`. The settings of
`init` are `{ connected, connectedAt, settings }`.

- The state starts as `initializing`.
- `connect()` sets the state to `connecting` and runs `doConnect()`. Then the state is `connected`.
  When `doConnect()` throws (also a value that is not an error), the state is `error`.
- When `doConnect()` does not end within the connect timeout, the state is `error`. A result that
  comes later does not change the state. A later `connect()` can succeed.
- `connect()` never throws.

The registry `ExternalSecretsProviders` maps the type names of the API to the provider classes, in
the order of the types in the API.

### HashiCorp Vault (`providers/vault.ts`)

The provider uses the HTTP API of Vault through `OutboundHttp` without the SSRF guard, because an
admin sets up the vault and it can be on an internal network.

- The settings: the URL (it must end with `/v1`), an optional namespace, the auth method (`token`,
  `usernameAndPassword` or `appRole`) and its credentials, and an optional KV mount (`kvMountPath`),
  KV version (`kvVersion`, default `2`) and folder (`kvSecretPath`, used only with a mount).
- `init` checks the URL (`TypeError: Invalid URL`).
- Each request sends `X-Vault-Token` when the provider has a token, and `X-Vault-Namespace` when the
  namespace is set (also on logins). The token lookups and the logins ask for JSON.
- `connect`: the login (`POST auth/userpass/login/<username>` with the password, or
  `POST auth/approle/login` with the role ID and the secret ID; the token method uses the token of
  the settings), `GET auth/token/lookup-self`, then a LIST of the KV mount of the settings (a 404
  answer with an empty `errors` list is good), or `GET sys/mounts`. A failure gives the state
  `error`. A failed login keeps the token that the provider had.
- The token renewal: after a connect, the provider looks up its token. When the token is renewable
  and has an expiry time, the provider renews it (`POST auth/token/renew-self`) at half of the time
  that is left, and then looks it up again for the next renewal. When the renewal fails, the
  provider connects again (with a new login for userpass and AppRole). `disconnect()` stops the
  renewal. A second connect replaces the scheduled renewal.
- `update`: without a KV mount in the settings, `GET sys/mounts` (a failure throws, and the old
  secrets stay) and all mounts of type `kv` with version `1` or `2`. With a KV mount, only that
  mount and folder, and errors give no secrets instead of an exception. The provider lists folders
  recursively and in parallel (`LIST <mount>metadata/<path>` for KV v2, `LIST <mount><path>` for
  KV v1) and reads each secret (`GET <mount>data/<path>` or `GET <mount><path>`). A folder that
  cannot be listed is left out; a secret that cannot be read is left out.
- The tree of secrets: each mount is a secret, named by its path without the trailing slash. In it,
  a secret is named by its key, and a folder by its path under the start folder without the
  trailing slash. So a folder two levels deep is named like `a/b`. With a folder in the settings,
  the tree nests that folder by its parts (`app/` gives `app`).
- `getSecret(mount)` gives the tree of the mount. `getSecretNames()` gives the dot paths of all
  values, for example `secret.app.db.user`.
- `test`: the token lookup (404: "Could not find auth path. Try adding /v1/ to the end of your base
  URL."; another status: "Invalid credentials"; refused connection: "Connection refused. Please
  check the host and port of the server are correct."; other errors: no text), then the check of
  the mount of the settings (403: "Permission denied accessing <path>. Check your token policies.";
  other failures: "Could not access <path> (status <status>).") or of `sys/mounts` (403: "Couldn't
  list mounts. Please give these credentials 'read' access to sys/mounts."; other failures:
  "Couldn't list mounts but it wasn't a permissions issue. Please consult your Vault admin.").

### Infisical (`providers/infisical.ts`)

The provider uses the API of Infisical through `OutboundHttp` without the SSRF guard (Infisical can
be self-hosted on an internal network).

- The settings: the site URL (trailing slashes removed, a path stays), the project ID, the
  environment, the secret path, and Universal Auth with a client ID and a client secret.
- Each request sends `Authorization: Bearer <access token>` when the provider has a token. The
  login and the read of the secrets ask for JSON.
- `connect`: with Universal Auth, the client ID and the client secret must be set, else the state
  is `error` without a request. The login is `POST /api/v1/auth/universal-auth/login`. Then
  `GET /api/v1/workspace/<project ID>` checks the project. A failure gives the state `error`.
- `update`: without a token: "Update attempted on Infisical before authentication". Else
  `GET /api/v4/secrets?projectId=…&environment=…&secretPath=…` (each value encoded with
  `encodeURIComponent`). On 401, the provider logs in again and repeats the request once. The
  secrets of the folder come first (a later key wins); an imported secret is added only when its key
  is not there yet. A failure throws, and the old secrets stay.
- `test`: the project check. 401: "Invalid credentials"; 403: "Permission denied. Verify the
  machine identity has access to this project."; 404: "Project not found. Check the Project ID and
  Site URL."; other status: "Unexpected response from Infisical (status <status>)."; refused
  connection: "Connection refused. Check the Site URL."; other errors: the error message. A test
  does not log in again.

### 1Password Connect (`providers/one-password.ts`)

The provider uses the `@1password/connect` library, which makes its own requests.

- `init` requires the Connect server URL ("Connect Server URL is required.") and the access token
  ("Access Token is required.").
- `connect` makes the client and lists the vaults. An invalid URL or a failure gives the state
  `error`. The library uses only the origin of the URL.
- `update` lists the vaults, the items of each vault, and reads each item, one request at a time.
  Each item is a secret, named by its title, with the fields that have a label and a value that is
  not empty, `0`, `false` or `null`. A later field with the same label wins, and a later item with
  the same title wins. An item without such fields is left out. A failure throws (the library
  rejects with the error body of the server), and the old secrets stay.
- `test`: "Client not initialized" before a connect; the list of the vaults gives `[true]`, or the
  error message ("Unknown error" for a rejection that is not an error).
- There is no request timeout, only the connect timeout.

## Clean-room sources

- The ordinary code: the test helper `test/shared/external-secrets/utils.ts` (the provider
  interface), the ordinary tests in `test/integration/external-secrets`, the schemas of
  `@n8n/api-types` (`secrets-provider.schema.ts`, `external-secrets.schema.ts`), the core
  `ExternalSecretsProxy`, the module registry, `@n8n/backend-network`, and the `@1password/connect`
  library.
- The public n8n documentation: [Use external secret stores](https://docs.n8n.io/administer/manage-credentials/use-external-secret-stores.md)
  and [the environment variables](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/external-secrets.md).
- The public API documentation of [Vault](https://developer.hashicorp.com/vault/api-docs),
  [Infisical](https://infisical.com/docs/api-reference) and
  [1Password Connect](https://developer.1password.com/docs/connect/connect-api-reference).
- The behaviour of the original files, recorded black-box: the registry gave the names and the
  fields of the forms (the data of `GET /secret-providers/types`). Temporary probes and the golden
  tests ran the original providers against the fake servers.

The enterprise files and their tests were not read, and the enterprise tests were not run. The
output of the runs with the original files was filtered to test names, counts, error headlines and
snapshot lines.

There was one slip during the preparation: a `grep -r` over `packages/cli/src/credentials` without
the enterprise exclusions searched `credentials.service.ee.ts` and its test for state words. The
output showed only matched fragments without file names, counted over all files (for example
`state: 'connected'` and `'error'`). The fork code does not use them: the states come from the
schemas of `@n8n/api-types` and the behaviour of the original files.

## The golden tests

`__tests__/secrets-provider.test.ts` builds small providers on the base class, as the ordinary test
helper does, and records the states around `connect()`, errors and the connect timeout.

`__tests__/vault.test.ts`, `__tests__/infisical.test.ts` and `__tests__/one-password.test.ts` run
each provider against a fake server in `__tests__/fakes` (a small HTTP server that also accepts the
`LIST` method of Vault). For each case, the snapshot records the result and the state of each step
(init, connect, update, the secrets, test, disconnect) and the requests that the server got. The
cases cover the form fields, the forms of the settings, the auth methods, the error answers of each
request, network errors, repeated updates, calls before a connect, the request headers, and the
timeouts. The Vault test records the token renewal with fake timers.

The tests set the connect timeout to 1 second and the refresh timeout to 2 seconds.

The snapshots were recorded twice against the original files, with the same result. The fork files
give the same snapshots. To record them again after an upstream update: in a copy of a test, point
the import that the test marks at the `.ee` file, run the copy with `-u`, and use its snapshot.

## What stays

- The enterprise module `modules/external-secrets.ee` and its tests stay. Ordinary code uses them
  until pull request 3.
