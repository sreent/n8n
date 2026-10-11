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

The work comes in five pull requests:

1. The base class of the providers, the config, the provider registry, and three providers:
   HashiCorp Vault, Infisical and 1Password Connect. (Done.)
2. The providers AWS Secrets Manager, Azure Key Vault and GCP Secrets Manager. (Done.)
3. The repositories of the two tables of the connections in `@n8n/db`, for ordinary code. (Done.)
4. The module: the manager, the stored settings and connections, the REST APIs, the access checks
   and the events. Ordinary code then uses this folder, and container CI leaves out the enterprise
   tests. (This pull request.)
5. The editor: the settings pages, the modals, the store and the REST clients.

Ordinary code uses this folder. The module registry loads
`external-secrets/external-secrets.module.ts`. It tries the enterprise folder only when that file is
not there, so n8n starts the fork module and not the enterprise module. Until pull request 5, the
enterprise pages of the editor use the REST APIs of the fork module.

## Behaviour

### The settings (`external-secrets.config.ts`)

| Variable | Default | Use |
|---|---|---|
| `N8N_EXTERNAL_SECRETS_UPDATE_INTERVAL` | 300 | How often n8n reads the secrets of the connected providers again, in seconds. |
| `N8N_EXTERNAL_SECRETS_CONNECT_TIMEOUT` | 20 | The maximum time of a connect, in seconds. |
| `N8N_EXTERNAL_SECRETS_REFRESH_TIMEOUT` | 20 | The maximum time that n8n waits for a read of the secrets, in seconds. Vault and Infisical stop each HTTP request after the larger of the two timeouts. The other providers have no request timeout. |
| `N8N_ENV_FEAT_EXTERNAL_SECRETS_FOR_PROJECTS` | `true` | The vaults of projects: a connection can belong to projects. |
| `N8N_ENV_FEAT_EXTERNAL_SECRETS_MULTIPLE_CONNECTIONS` | `true` | More than one connection for each provider type. |
| `N8N_ENV_FEAT_EXTERNAL_SECRETS_ROLE_BASED_ACCESS` | `true` | The setting of the system roles (`POST /external-secrets/settings`). |

The first two flags select the mode of the module. When one of them is on, the module uses the
stored connections (the mode with connections). When both are off, the module uses one stored
setting for each provider type (the mode with settings). The original has the same flags with the
same defaults, and one more variable (see "Differences from the original").

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
- After a failed connect, `connectError` holds the error: the value that `doConnect()` threw, or
  the error `Timed out connecting after <ms>ms` (for example `Timed out connecting after 20000ms`).
  A good connect clears it. The tests of the APIs give the message of this error.

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

### AWS Secrets Manager (`providers/aws-secrets-manager.ts`)

The provider uses the AWS SDK (`@aws-sdk/client-secrets-manager`), which makes its own requests.

- The settings: the region, and the auth method: `iamUser` with an access key ID and a secret
  access key, or `autoDetect`. With `autoDetect`, the SDK finds the credentials with its default
  chain (the environment, the shared files, the role of the container or the instance). Then the
  provider ignores the keys in the settings.
- `init` makes the client. An unknown auth method gives `UnknownAuthTypeError` ("Unknown auth
  type"), and an empty region gives the error of the SDK ("Region is missing"). Then there is no
  client.
- The client gets the HTTP agents of `OutboundHttp` without the SSRF guard. Thus the requests use
  the proxy of the environment. The SDK reads its other settings from the environment, for example
  `AWS_ENDPOINT_URL_SECRETS_MANAGER`. It tries a request up to 3 times after server errors,
  throttling and network errors.
- `connect`: `ListSecrets` with `MaxResults: 1`. A failure gives the state `error`.
- `update`: `ListSecrets` page by page (`NextToken`), then `BatchGetSecretValue` for the listed
  names, with 20 names in each request, one request at a time. Each secret with a text value
  (`SecretString`) that is not empty is a secret of n8n. Binary values (`SecretBinary`) and the
  secrets in `Errors` are left out. A failed request throws the error of the SDK, and the old
  secrets stay. Without a client, `update` throws a `TypeError`.
- `test`: `ListSecrets` with `MaxResults: 1` gives `[true]`, or `[false, <error message>]`.
- `disconnect` does nothing. Calls before a connect and after a disconnect use the client of
  `init`.
- There is no request timeout, only the connect timeout.

### Azure Key Vault (`providers/azure-key-vault.ts`)

The provider uses the Azure SDK (`@azure/identity` and `@azure/keyvault-secrets`), which makes its
own requests.

- The settings: the Azure cloud (`environment`), the vault name, the tenant ID, the client ID, the
  client secret, and for the custom cloud, the vault URL and the authority host.
- The vault URL and the authority host of each cloud:

  | Cloud | Vault URL | Authority host |
  |---|---|---|
  | `public` (also when the setting is not there) | `https://<vault name>.vault.azure.net/` | `https://login.microsoftonline.com` |
  | `usGovernment` | `https://<vault name>.vault.usgovcloudapi.net/` | `https://login.microsoftonline.us` |
  | `china` | `https://<vault name>.vault.azure.cn/` | `https://login.partner.microsoftonline.cn` |
  | `custom` | The vault URL of the settings | The authority host of the settings, or `https://login.microsoftonline.com` when it is empty |

- The provider uses the vault name and the vault URL as they are, without checks. For the other
  clouds, it ignores the fields of the custom cloud.
- `connect` makes a `ClientSecretCredential` (the tenant ID, the client ID, the client secret and
  the authority host) and a `SecretClient`. It makes no request. An unknown or empty cloud gives
  the state `error`, without a client. A second connect makes a new client.
- `update`: the list of the properties of all secrets, then a read of each secret that is not
  disabled (`enabled` is not `false`), all at the same time. A secret with a value is a secret of
  n8n, also with an empty value. A secret without a value, or that the vault does not give (for
  example with 403 or 404), is left out. A failure of the list throws the error of the SDK, and the
  old secrets stay. Without a client, `update` throws a `TypeError`.
- `test`: "Failed to connect to Azure Key Vault" without a client. Else the first secret of the
  list gives `[true]` (also for a vault without secrets), or `[false, <error message>]`.
- `disconnect` does nothing.

### GCP Secrets Manager (`providers/gcp-secrets-manager.ts`)

The provider uses the GCP SDK (`@google-cloud/secret-manager`), which makes its own requests.

- The settings: the service account key, the JSON text of the key file.
- `init` reads `client_email`, `private_key` and `project_id` from the key, without the spaces
  around them. The line breaks of the private key stay as they are (also the text `\n`). Without
  a project ID, the project is empty. When the key is not a JSON object with an email and a private
  key, `init` gives a `UserError`: 'Service account key must contain "client_email" and
  "private_key" fields. Use the downloaded service account JSON key file from Google Cloud
  Console.'
- `connect` makes a `SecretManagerServiceClient` with the email, the private key and the project
  ID. It makes no request. Before an `init` without errors, the state is `error`. A second connect
  makes a new client.
- `update`: `listSecrets` of `projects/<project ID>`, then `accessSecretVersion` of
  `projects/<project ID>/secrets/<name>/versions/latest` for each secret, all at the same time. The
  value is the text of the payload (`toString()`). A value that is not empty is a secret of n8n. A
  secret that cannot be read is left out. A failure of the list throws the error of the SDK, and
  the old secrets stay. Before an `init` without errors or before a connect, `update` throws a
  `TypeError`.
- `test`: "Failed to connect to GCP Secrets Manager" without a client. Else `initialize()` of the
  client gives `[true]`, or `[false, <error message>]`. The test reads no secret.
- `disconnect` does nothing. It does not close the client.
- One difference from the original: for a key that is a JSON value but not an object (for example
  `null`), or that has a field that is not text, the original fails with a `TypeError`. The fork
  gives the `UserError` of a key without the fields.

### The repositories (`@n8n/db`)

`ExternalSecretsConnectionRepository` (the table `secrets_provider_connection`) and
`ExternalSecretsProjectAccessRepository` (the table `project_secrets_provider_access`) are fork
repositories in `@n8n/db`. The fork module and ordinary code use them in place of the enterprise
`SecretsProviderConnectionRepository` and `ProjectSecretsProviderAccessRepository`. Ordinary code
imports them under the names of the enterprise repositories, so only the import lines of the
upstream files change. The enterprise module still uses the enterprise repositories: it uses more
methods than ordinary code, and the fork does not know them.

A connection without access rows is global. A connection loads its access rows, and each row loads
its project (eager relations of the entities). The queries of the connection repository:

- `findWithAccessByProviderKey(providerKey)`: the connection with its access rows, or `null`.
- `listWithAccess()`: all connections with their access rows, in the order of their IDs.
- `findEnabledConnections()`: the enabled connections without their access rows, in the order of
  their IDs. The manager loads these.
- `findIdByProviderKey(providerKey)`: the ID of the connection, as text, or `null`. A disabled
  connection counts. The key must match exactly.
- `findIdsByProviderKeys(providerKeys)`: the IDs of the connections with the keys, as text, each
  ID once. Disabled connections count.
- `findEnabledGlobalConnections({ providerKeys })`: the enabled global connections, without the
  `projectAccess` relation.
- `findEnabledByProjectId(projectId, { providerKeys })`: the enabled connections with an access row
  of the project (owner or user). Each connection has only the access row of that project, with the
  project.
- `findAllAccessibleProviderKeysByCredentialId(credentialId)`: the provider keys of the enabled
  global connections and of the enabled connections of the project that owns the credential
  (`credential:owner`). A project that the credential is only shared with does not count.

With `providerKeys`, a query gives only the connections with these keys. An empty list of keys
gives an empty list without a query (an `IN ()` condition is not valid SQL for PostgreSQL). The
original queries give no defined order: the order depends on the query plan of the database. The
fork orders the connections by ID.

The access repository:

- `grantAccess(connectionId, projectIds, role)`: one insert with an access row for each project.
  When a project is twice in the list or does not exist, the insert fails and adds no row.
- `revokeAllAccess(connectionId)`: deletes the access rows of the connection.

### The module (`external-secrets.module.ts`)

The module has the name `external-secrets` and the licence flag `feat:externalSecrets`, as the
original. n8n starts it only when the licence has that feature.

- `init` registers the controllers of the REST APIs and starts the manager.
- `shutdown` (`@OnShutdown`) stops the manager.
- `settings` gives the modes to the editor: `{ multipleConnections, forProjects, roleBasedAccess,
  systemRolesEnabled }`. The first three are the flags of the config. `systemRolesEnabled` is
  `true` when the setting `externalSecrets.systemRolesEnabled` has the value `"true"`. `settings`
  does not check the licence.

### The manager (`external-secrets-manager.ts`)

The manager keeps the providers that n8n uses in the provider registry, by name. It gives them to
the secrets proxy of the core (`ExternalSecretsProxy`), which gives the secrets to expressions
(`$secrets.<name>.<secret>`).

- The start loads the providers and starts the update interval. A second start does nothing until
  a stop.
- In the mode with settings, the setting `feature.externalSecrets` holds the settings of all
  provider types: an encrypted JSON object `{ <type>: { connected, connectedAt, settings } }`.
  Each type in it is a provider with the name of the type. The manager connects a provider only
  when `connected` is true.
- In the mode with connections, each enabled connection is a provider with the name of its provider
  key. The manager connects each of them. A disabled connection has no provider. When the settings
  of a connection cannot be decrypted, the connection has no provider, and the manager writes an
  error to the log.
- To load a provider, the manager makes a new instance of the type and initializes it. When the
  initialization fails, nothing changes. A new name goes into the registry now, so the order of the
  registry is the order in which the names came. Then the manager connects the provider (when it
  must) and reads its secrets. It waits at most the refresh timeout for the secrets. After that
  time, the read goes on, and the provider counts as ready.
- A ready provider takes the place of the provider of the name, and the old provider disconnects.
  When the new provider is not ready, a connected old provider stays, and the new provider tries
  again later. When the old provider is not connected, the new provider takes its place and tries
  again later.
- The retries: the base delay is 10 seconds, and it doubles at each retry, up to 10 minutes. Each
  delay is a random part of the base delay, from 50% to 100%. Thus the first retry comes 5 to 10
  seconds after the failure. A retry connects the provider when it is not connected, and reads its
  secrets. When the provider is ready, it takes the place of the provider of the name, and the
  retries stop. A new load of the name, a removal of the name, a reload of all providers and the
  stop cancel the retries. A provider that only waited for a retry then disconnects.
- At each update interval, the manager reads the secrets of each connected provider again. When a
  read fails, the provider keeps its old secrets.
- After each change through the APIs, the manager sends the command
  `reload-external-secrets-providers` to the other instances. The publisher sends commands only in
  queue mode. Each instance that gets the command loads all providers again: it removes the
  providers of names that are not stored now, and loads the others again.
- The stop ends the update interval and the retries, and disconnects the providers, also the
  providers that wait for a retry. The providers stay in the registry with their secrets.
- A test makes a new instance of the type, initializes it with the settings (`connected: true`),
  connects it, runs its `test()` and disconnects it. When the initialization fails, the result is
  `{ success: false }`. When the connect fails, the error of the result is the message of
  `connectError`.
- A sync reads the secrets of the connected provider of the name again. Then it sends the reload
  command and emits the event `external-secrets-provider-reloaded` (`vaultType` is the name). A
  sync fails when the provider is not there or not connected, or when the read fails.

### The settings API (`/external-secrets`)

The settings API works in all modes. Each route needs a global scope.

| Route | Scope | Answer |
|---|---|---|
| `GET /providers` | `externalSecretsProvider:list` | Each provider type: `connected`, `connectedAt`, `data` (the stored settings), `displayName`, `icon`, `name` and `state`. |
| `GET /providers/:provider` | `externalSecretsProvider:read` | One provider type, also with the fields of its form (`properties`). |
| `POST /providers/:provider` | `externalSecretsProvider:create` | Stores the body as the settings of the type, and loads the provider. `{}`. |
| `POST /providers/:provider/connect` | `externalSecretsProvider:update` | Stores `connected` of the body, and loads or removes the provider. `{}`. |
| `POST /providers/:provider/test` | `externalSecretsProvider:update` | Tests the settings of the body. `{ success: true, testState: 'connected' }`, or status 400 with `{ success: false, testState: 'error', error? }`. |
| `POST /providers/:provider/update` | `externalSecretsProvider:sync` | A sync of the provider. `{ updated: true }`, or status 400 with `{ updated: false }`. |
| `GET /secrets` | `externalSecret:list` | The names of the secrets of each provider in the registry, by name. |
| `POST /settings` | `externalSecretsProvider:update` | Stores `systemRolesEnabled` of the body (`UpdateExternalSecretsSettingsDto`). `{ systemRolesEnabled }`. |

- A provider type that n8n does not know gives the HTML error page of Express, with status 500
  (`ResponseError: Could not find provider "<type>"`).
- The answers show the value of each password field of the form (`typeOptions.password`) as the
  blanking value of n8n (`CREDENTIAL_BLANKING_VALUE`), also an empty value. In the body of a save
  or a test, a blanking value takes the stored value.
- A save keeps `connected` and `connectedAt` of the stored settings. A new type gets
  `connected: false` and `connectedAt: null`. The save loads the provider with the new settings,
  and connects it only when `connected` is true. Then the new provider runs its `test()` for the
  event `external-secrets-provider-settings-saved` (`isNew`, `isValid` and `errorMessage`).
- The API does not check the body of a save: it stores a list or unknown fields as they are.
- `connect` stores the value of `connected` as it is, also a text or no value. A true value loads
  and connects the provider. Another value removes the provider.
- `POST /settings` sets the setting `externalSecrets.systemRolesEnabled` (loaded at the start). It
  adds the scopes of `EXTERNAL_SECRETS_SYSTEM_ROLES_ENABLED_SETTING` (`@n8n/permissions`) to the
  project roles, or removes them, and emits the event `external-secrets-system-roles-toggled`. It
  needs the flag of role-based access. Without it, the answer is status 403 with
  `Role-based access for external secrets is not enabled`.

### The connections API (`/secret-providers/connections`)

The connections API needs the mode with connections. Else each route gives status 403 with
`Requested beta external secret endpoint without feature flag enabled`. Each route needs a global
scope. The body of a create and of an update must match `CreateSecretsProviderConnectionDto` and
`UpdateSecretsProviderConnectionDto` of `@n8n/api-types`. Else the answer is status 400 with the
error of the schema.

| Route | Scope | Answer |
|---|---|---|
| `GET /` | `externalSecretsProvider:list` | All connections in the order of their IDs, without settings. |
| `POST /` | `externalSecretsProvider:create` | Creates a connection. The connection. |
| `GET /:providerKey` | `externalSecretsProvider:read` | The connection, with its settings and the names of its secrets. |
| `PATCH /:providerKey` | `externalSecretsProvider:update` | Changes the connection. The connection. |
| `DELETE /:providerKey` | `externalSecretsProvider:delete` | Deletes the connection. Status 204 without a body. |
| `POST /:providerKey/test` | `externalSecretsProvider:update` | Tests the stored settings. `{ success, testState: 'tested' or 'error', error? }`, always with status 200. |
| `POST /:providerKey/reload` | `externalSecretsProvider:sync` | A sync of the provider. `{ success }`. |

- A connection in a list has `id` (as text), `name` (the provider key), `type`, `state`,
  `isEnabled`, `projects` (the `id`, `name` and `role` of each access row), `secretsCount`,
  `createdAt` and `updatedAt`. The state and the secrets come from the provider in the registry.
  Without a provider, the state is `initializing`, and there are no secrets. One connection alone
  also has `settings` (with the blanking value in the password fields, as in the settings API) and
  `secrets` (`[{ name }]`).
- A create needs a provider key that no other connection has. Else the answer is status 400 with
  `Connection with key "<key>" already exists`. The check is case-sensitive. The create stores the
  connection (enabled), gives the projects of `projectIds` the role
  `secretsProviderConnection:user`, loads the provider and sends the reload command. A connection
  with projects needs the vaults of projects. Else the answer is status 403 with
  `Tried to create a project-scoped external secret connection without feature flag enabled`.
- The access rows come after the connection. When they fail, the connection stays without them:
  an unknown project gives the error of the foreign key, and a project that is twice in the list
  gives `There is already an entry with this name`, both with status 500.
- An update changes the type, the settings, `isEnabled` and the projects. `projectIds` replaces
  all access rows with the role `secretsProviderConnection:user`. The provider key does not
  change. A new type needs new settings: else the answer is status 400 with
  `When changing the connection type, new settings must be provided as well`. New settings replace
  the stored settings, and a blanking value keeps the stored value. Then the manager loads the
  provider again, or removes it when the connection is disabled, and sends the reload command.
- A delete removes the connection and its access rows, removes the provider and sends the reload
  command.
- A test uses the stored settings, not the body.
- A reload needs a provider in the registry. Else the answer is status 404 with
  `Provider "<key>" not found`.
- An unknown provider key gives status 404 with `Connection with key "<key>" not found`.
- The events: `external-secrets-connection-created`, `external-secrets-connection-updated`,
  `external-secrets-connection-deleted`, `external-secrets-connection-tested` (with `isValid` and
  `errorMessage`) and `external-secrets-connection-reloaded` (only after a good reload). Each event
  has the user, the role of the user, the provider key, the type (`vaultType`) and the projects
  (`id` and `name`).

### The project API (`/secret-providers/projects/:projectId/connections`)

The project API needs the vaults of projects. Else each route gives status 403 with
`External secrets for projects feature is not enabled`. Each route needs the scope in the project:
the global scope, or the scope of the project role of the user.

| Route | Scope | Answer |
|---|---|---|
| `GET /` | `externalSecretsProvider:list` | The connections of the project, then the global connections, without settings. |
| `POST /` | `externalSecretsProvider:create` | Creates a connection that the project owns. The connection, with `scopes`. |
| `GET /:providerKey` | `externalSecretsProvider:read` | A connection of the project or a global connection, with `scopes`. |
| `PATCH /:providerKey` | `externalSecretsProvider:update` | Changes a connection of the project. The connection, with `scopes`. |
| `DELETE /:providerKey` | `externalSecretsProvider:delete` | Deletes a connection of the project. Status 204 without a body. |
| `POST /:providerKey/test` | `externalSecretsProvider:update` | Tests a connection of the project, as in the connections API. |

- A connection of the project has an access row of the project (owner or user). `PATCH`, `DELETE`
  and the test need such a connection. Else the answer is status 404 with
  `Connection with key "<key>" not found in project "<projectId>"`. Only `GET` also shows a global
  connection.
- A create in a project gives the project the role `secretsProviderConnection:owner`. The
  `projectIds` of the body do not count. An unknown project gives the error of the foreign key
  (status 500), and the connection stays.
- An update in a project does not change the projects. A delete in a project emits no event.
- `scopes` are the scopes of the user for the connection, sorted: the scopes of the global role of
  the user, and the scopes of the project role of the user that the role of the project for the
  connection allows (`secretsProviderConnection:owner` or `secretsProviderConnection:user`). For a
  global connection, the role `secretsProviderConnection:user` counts. Only the scopes of
  `externalSecretsProvider` and `externalSecret` count.

### The completions and the types

| Route | Mode | Scope | Answer |
|---|---|---|---|
| `GET /secret-providers/completions/secrets/global` | Connections | `externalSecret:list` (global) | The names of the secrets of each enabled global connection, by provider key. |
| `GET /secret-providers/completions/secrets/global/:projectId` | Vaults of projects | `externalSecret:list` in the project | The same. |
| `GET /secret-providers/completions/secrets/project/:projectId` | Vaults of projects | `externalSecret:list` in the project | The names of the secrets of each enabled connection of the project. |
| `GET /secret-providers/types` | Connections | None | Each provider type: `type`, `displayName`, `icon` and `properties`. |
| `GET /secret-providers/types/:type` | Connections | None | One provider type, or status 404 with `Provider type "<type>" not found`. |

A connection without a provider in the registry has no entry in the completions. Without the mode,
the global completions give status 403 with
`External secrets multiple connections feature is not enabled`, the routes of a project give
status 403 with `External secrets for projects feature is not enabled`, and the types give status
403 with `Requested beta external secret endpoint without feature flag enabled`.

### The access check (`secret-provider-access-check.service.ts`)

`isProviderAvailableInProject(providerKey, projectId)` tells which connections the credentials of
a project can use: a global connection, or a connection with an access row of the project. A
disabled connection counts. An unknown key gives `false`. The credential services of ordinary code
use it.

### Differences from the original

- A stored setting or connection with a provider type that is not in the list of the types has no
  provider, and the manager writes an error to the log. The golden tests leave this case out: with
  the original, it did not give a result that a snapshot could record. The schemas of the API
  accept only the six types, so the case comes only from stored data.
- The original reads one more variable, `N8N_EXTERNAL_SECRETS_PREFER_GET` (default `false`). The
  public documentation does not list it, and the fork does not implement it.
- The fork limits the delay of the retries to 10 minutes. The probes of the original showed no
  limit below about 3 minutes.
- The order of the projects of a connection is the order of the database, in the original and in
  the fork. The golden tests sort them.

## Clean-room sources

- The ordinary code: the test helper `test/shared/external-secrets/utils.ts` (the provider
  interface), the ordinary tests in `test/integration/external-secrets`, the schemas of
  `@n8n/api-types` (`secrets-provider.schema.ts`, `external-secrets.schema.ts`), the core
  `ExternalSecretsProxy`, the module registry, `@n8n/backend-network`, the `@1password/connect`
  library, and the SDKs `@aws-sdk/client-secrets-manager`, `@azure/identity`,
  `@azure/keyvault-secrets` and `@google-cloud/secret-manager`.
- For the module: the ordinary tests in `test/integration/external-secrets` (the routes, the
  answers, the events and the parameters of the manager), the test server, the decorators of
  `@n8n/decorators`, the publisher and its commands, the events of `EventService`, the schemas
  `CreateSecretsProviderConnectionDto`, `UpdateSecretsProviderConnectionDto` and
  `UpdateExternalSecretsSettingsDto` of `@n8n/api-types`, the setting
  `EXTERNAL_SECRETS_SYSTEM_ROLES_ENABLED_SETTING` and the roles of `@n8n/permissions`, the type of
  the module settings in the editor, and the Playwright fixtures (the variable
  `N8N_ENV_FEAT_EXTERNAL_SECRETS_FOR_PROJECTS`).
- For the repositories: the entities `SecretsProviderConnection` and
  `ProjectSecretsProviderAccess`, the ordinary test
  `test/integration/database/repositories/secrets-provider-connection.repository.test.ts`, and the
  ordinary users `credentials-helper.ts`, `credentials/credential-dependency.service.ts` and the
  fork's `TeamProjectRepository`.
- The public n8n documentation: [Use external secret stores](https://docs.n8n.io/administer/manage-credentials/use-external-secret-stores.md)
  and [the environment variables](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/external-secrets.md).
- The public API documentation of [Vault](https://developer.hashicorp.com/vault/api-docs),
  [Infisical](https://infisical.com/docs/api-reference),
  [1Password Connect](https://developer.1password.com/docs/connect/connect-api-reference),
  [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/apireference/),
  [Azure Key Vault](https://learn.microsoft.com/en-us/azure/key-vault/secrets/) and
  [GCP Secret Manager](https://cloud.google.com/secret-manager/docs).
- The behaviour of the original files, recorded black-box: the registry gave the names and the
  fields of the forms (the data of `GET /secret-providers/types`). Temporary probes and the golden
  tests ran the original providers against the fake servers, a fake AWS endpoint, and fakes of the
  classes of the Azure SDK and the GCP SDK. The golden test of the repositories ran the queries
  of the enterprise repositories on a fixture.
- For the module, temporary probes recorded the route table of the original controllers (the base
  path, the method, the path, the licence flag, the scope, the types of the arguments and the names
  of the schemas), the registrations of the module (its metadata and its handlers of commands and
  of the stop), the fields of the original config with their defaults and the names of the
  environment variables that it reads (a proxy on `process.env`), the state fields of an original
  provider around a connect, the retries of failed connects and failed reads, and the commands to
  other instances. The golden tests of the module ran the original module through its REST APIs.
- To find the files that use the enterprise module and the enterprise repositories, the fork took
  them out of the type check (it moved the module folder away, or removed the two exports of
  `@n8n/db`) and listed only the names of the files with type errors.

The enterprise files and their tests were not read, and the enterprise tests were not a source.
Until pull request 4, container CI ran the enterprise tests of external secrets with the other
tests, and its output shows only test names and results. The output of the runs with the original
files was filtered to test names, counts, error headlines and snapshot lines.

There was one slip during the preparation: a `grep -r` over `packages/cli/src/credentials` without
the enterprise exclusions searched `credentials.service.ee.ts` and its test for state words. The
output showed only matched fragments without file names, counted over all files (for example
`state: 'connected'` and `'error'`). The fork code does not use them: the states come from the
schemas of `@n8n/api-types` and the behaviour of the original files.

There was a second slip in pull request 3: the ordinary test
`test/integration/external-secrets/external-secrets.api.test.ts` gives the connection repository to
the constructor of the enterprise manager. When its import used the fork repository, the type check
reported that the fork class does not have four methods of the enterprise class, and named them
(`findAll`, `hasGlobalProvider`, `isProviderAvailableInProject` and
`findAllAccessibleByProjectWithProjectAccess`). The fork does not use these names, except
`isProviderAvailableInProject`: the access check of the fork has that name, because ordinary code
calls it.

There were two slips in pull request 4:

- In a first recording, the answer to a route with an unknown provider type was the HTML error page
  of Express, with a stack trace. The recording kept the start of the second line of the page: the
  start of a class name in the first frame of the stack (`at ExternalSecretsCo`). The golden tests
  now keep only the first line of such a page.
- A type check printed the continuation lines of its errors, which name the members of the other
  type. They named the private property `connectionRepository` of an enterprise class, four members
  of the enterprise base class (`stateHistory`, `setState`, `hasEverBeenConnected` and
  `canPerformOperations`), and the names and the fields of eight test providers of the enterprise
  tests. The fork does not use the four members or the names of the test providers. The fork code
  had the names `connectionRepository` and `connectError` (also a field of some of these test
  providers) before the slip. The type checks now show only the first line of each error, and no
  line of an enterprise file.

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

`__tests__/aws-secrets-manager.test.ts` runs the real AWS SDK against a fake Secrets Manager
endpoint (`__tests__/fakes/fake-aws.ts`, which `AWS_ENDPOINT_URL_SECRETS_MANAGER` points to). The
snapshot records the requests with the operation, the input, and the access key and the region of
the signature. The cases cover the auth methods, the pages and the batches, the errors and the
retries of the SDK, a slow endpoint, and the transport (the SSRF protection, and a proxy of the
environment).

`__tests__/azure-key-vault.test.ts` and `__tests__/gcp-secrets-manager.test.ts` replace the classes
of the SDKs with fakes that log each construction, each call, and each use of a member that the
fake does not have. The snapshot records that log. The cases cover the clouds, the forms of the
service account key, the errors of the list and of single reads, and the parallel reads.

The tests set the connect timeout to 1 second and the refresh timeout to 2 seconds. The AWS test
sets the connect timeout to 3 seconds: the retries of the SDK after a throttled request take up to
1.5 seconds, and all requests of a connect must be in the connect step.

`__tests__/repositories.integration.test.ts` runs the queries of the connection repository on a
fixture: global and project connections, enabled and disabled ones, owner and user access, a
personal project, and credentials with owner and user sharing. The snapshot records each result,
with each list sorted.

The snapshots were recorded twice against the original files, with the same result. The fork files
give the same snapshots. To record them again after an upstream update: in a copy of a test, point
the import that the test marks at the original (the `.ee` file of the module, or for the
repositories the classes `SecretsProviderConnectionRepository` and
`ProjectSecretsProviderAccessRepository` of `@n8n/db`), run the copy with `-u`, and use its
snapshot.

The golden tests of the module are in `__tests__/module`. They run the module in the integration
test server with a database. The provider types are fakes (`harness.ts`): they log each call, and
the tests make them fail, hang or wait on purpose. For each step, the snapshot records the request,
the status and the answer, the calls to the providers (by instance), the events, the commands to
other instances, and the stored state: the settings, the decrypted connections, the access rows and
the scopes of the project roles. Labels replace the IDs of users, projects and connections, and the
dates. Of an HTML error page, the snapshot keeps only the first line.

- `settings-api.integration.test.ts`: the settings API and the setting of the system roles, with
  passwords, failed inits, connects and tests, invalid input, the access of each global role, the
  multi-main mode, the licence and the modes.
- `connections-api.integration.test.ts`: the connections API, with failed and slow connects,
  invalid input, the access of each global role, the multi-main mode, the licence and the modes.
- `project-api.integration.test.ts`: the project API, the completions and the types, and the access
  of nine users (the global roles, the project roles and custom roles) with the system roles off,
  with them on, and with them on without role-based access.
- `lifecycle.integration.test.ts`: the start with stored settings and with stored connections, the
  reload command, the stop, the settings for the editor, the access check, the update interval,
  the timeouts, the retries and the start without the licence.

The tests of the retries and of the update interval check times in ranges, because the delays are
random. The connections whose connect fails live less than 5 seconds in the other tests, so no
retry comes in a step.

The module snapshots were recorded against the original module, and a second recording gave the
same snapshots. The fork module gives the same snapshots. Ten mutations of the fork code (the
blanking of passwords, the merge of blanked values, the replacement of a connected provider, the
order of the registry, the delay of the retries, the scopes in a project, the order of the
connections of a project, the state of a test, the reload command after a delete, and the
`connected` value of new settings) each made a golden test fail.

To record the module snapshots again after an upstream update:

1. Copy `__tests__/module` to a temporary folder next to it.
2. In the copy, point the imports that the tests mark at the original files:

   | Fork import | Original file |
   |---|---|
   | `@/modules/external-secrets/external-secrets-providers` | `@/modules/external-secrets.ee/external-secrets-providers.ee` |
   | `@/modules/external-secrets/types` | `@/modules/external-secrets.ee/types` |
   | `@/modules/external-secrets/external-secrets.config` | `@/modules/external-secrets.ee/external-secrets.config` |
   | `@/modules/external-secrets/external-secrets-manager` | `@/modules/external-secrets.ee/external-secrets-manager.ee` |
   | `@/modules/external-secrets/external-secrets.module` | `@/modules/external-secrets.ee/external-secrets.module` |
   | `@/modules/external-secrets/settings-store.service` | `@/modules/external-secrets.ee/settings-store.service` |
   | `@/modules/external-secrets/secret-provider-access-check.service` | `@/modules/external-secrets.ee/secret-provider-access-check.service.ee` |
   | `@/modules/external-secrets/provider-registry.service` | `@/modules/external-secrets.ee/provider-registry.service` |

3. Move `external-secrets.module.ts` of this folder away for the run, so that the module registry
   loads the enterprise module. In `test/integration/shared/utils/test-server.ts`, point the import
   of `external-secrets.module.js` at the enterprise folder.
4. Run the copy with `-u`, use its snapshots, and restore the three changes.

Keep the output of the run to test names, counts, error headlines and snapshot lines.

## What stays

- The enterprise module `modules/external-secrets.ee` and its tests stay, for the recordings of the
  golden tests after upstream updates. n8n does not start the enterprise module. Only these files
  import it: the enterprise tests, `credentials/credentials.service.ee.ts` and
  `services/project.service.ee.ts` (ordinary code does not use these two enterprise files), and the
  upstream test helper `test/shared/external-secrets/utils.ts`, which only the enterprise tests use.
- Container CI leaves out the enterprise tests of external secrets
  (`scripts/container-ci-skipped-tests.txt`).
- `test/shared/external-secrets/fork-providers.ts` is a copy of the upstream `utils.ts` on the fork
  base class. The ordinary tests of external secrets use it. When an upstream update changes
  `utils.ts`, make the same change in the copy.
- The enterprise repositories `secrets-provider-connection.repository.ee.ts` and
  `project-secrets-provider-access.repository.ee.ts` of `@n8n/db` stay, with their exports. The
  enterprise module uses them.
