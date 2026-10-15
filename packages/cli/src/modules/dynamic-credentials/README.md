# Dynamic credentials

Fork module (not in upstream n8n). It is a clean-room rebuild of the dynamic credentials of the
n8n Enterprise Edition. A private credential (in the editor: an end-user credential) has data for
each user. The run of a workflow uses the data of the user of the run:

- The system resolver keys the data by the n8n user. A user connects their own account in the
  editor (for example with the OAuth flow of the credential), and a manual run uses it.
- A custom resolver keys the data by the user of an external identity provider: an OAuth2 server
  (token introspection or the userinfo endpoint) or a Slack app (the signature of the request).
  A webhook gives the identity, and the context establishment hooks of the Webhook node read it
  from the request.

The editor parts are ordinary code: the end-user credential option of the credential modal, the
connection state of the credentials, the resolver settings of a workflow, the page of the
credential resolvers (`features/resolvers`) and the Dynamic Credential Check node. They use the
REST API of this module.

The sources of the rebuild are the public documentation
([End-user credentials](https://docs.n8n.io/administer/manage-credentials/end-user-credentials)),
the ordinary code of n8n (the proxies and interfaces in `packages/cli/src/credentials`, the
credential resolver and context establishment contracts of `@n8n/decorators`, the execution
context service of `n8n-core`, the DTOs and schemas in `@n8n/api-types`, the migrations of the
three tables, the OAuth callback, the events, the editor and the Playwright helpers), the ordinary
upstream tests (see "Tests"), and the behaviour of the original module. Black-box golden tests
recorded that behaviour. The enterprise files were not read.

## Turn it on

- The licence value `feat:dynamicCredentials`. The fork switch gives it
  (`packages/cli/src/fork-features.ts`). The module is a default module.
- With the module, the private credentials (the system resolver) work.
- The custom resolvers, the resolver setting of a workflow, the hooks of the Webhook node and the
  Dynamic Credential Check node also need `N8N_ENV_FEAT_DYNAMIC_CREDENTIALS=true`, as in upstream
  n8n. `deploy/` sets it.
- The routes of the resolvers need the global scopes `credentialResolver:*`. The owner and the
  admin have them.

| Variable | Default | What it does |
|---|---|---|
| `N8N_DYNAMIC_CREDENTIALS_CORS_ORIGIN` | empty | The origins (separated by commas, or `*`) that can call the public endpoints from a browser. |
| `N8N_DYNAMIC_CREDENTIALS_CORS_ALLOW_CREDENTIALS` | `false` | Sends `Access-Control-Allow-Credentials: true`. |
| `N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN` | empty | A static token for the public endpoints. A request without a session sends it in `X-Authorization: Bearer <token>`. |
| `N8N_DYNAMIC_CREDENTIALS_RATE_LIMIT_PER_MINUTE` | `60` | The requests to the execution status and the revoke, for each IP address. |
| `N8N_DYNAMIC_CREDENTIALS_AUTHORIZE_RATE_LIMIT_PER_MINUTE` | `60` | The requests to the authorization routes, for each IP address. |

## Resolvers

The table `dynamic_credential_resolver` keeps the resolvers. The configuration is encrypted JSON
(`cipher.encryptV2`).

- At the start, the module adds the system resolver if it is not there: the id `system-n8n`, the
  name `n8n private credentials`, the type `credential-resolver.n8n-1.0` and an empty
  configuration. The system resolver cannot be created, changed or deleted
  (`Cannot <action> the system credential resolver.`).
- `GET /rest/credential-resolvers` lists the resolvers without their configuration, oldest first.
  `?includeSystem=true` adds the system resolver.
- `GET /rest/credential-resolvers/types` lists the types that a user can create:
  `credential-resolver.oauth2-1.0` and `credential-resolver.slack-1.0`, with their options.
- `POST /rest/credential-resolvers` and `PATCH /rest/credential-resolvers/:id` check the
  configuration with the resolver type. The answer gives the configuration with each secret
  option replaced by the blanking value of n8n. A save of the blanking value keeps the stored
  secret. An option that starts with `=` is an expression: n8n evaluates it with `$env` before the
  check and before each use. A failed expression gives
  `Invalid expression in resolver config: <message>`.
- `PATCH` with `clearCredentials: true` deletes the data that the resolver stored for its
  subjects.
- `DELETE /rest/credential-resolvers/:id` deletes the resolver. The database deletes its data and
  removes it from its credentials. The workflows that use it lose the setting, and the active
  ones are activated again.
- `GET /rest/credential-resolvers/:id/workflows` lists the workflows that use the resolver.

### OAuth2 resolver

The options are the URL of the metadata document of the server and the validation:

- `oauth2-introspection`: n8n sends the token to the introspection endpoint of the server, with
  the client ID and secret (Basic authentication, or in the form when the server supports only
  `client_secret_post`). An active token gives its subject. n8n keeps the answer for five
  minutes, or until the token expires.
- `oauth2-userinfo`: n8n sends the token to the userinfo endpoint. With an expected audience, n8n
  first verifies the token as a JWT with the keys of the server (and gets the keys again once for
  an unknown key, at most each five minutes).

n8n reads the metadata document once an hour. An admin sets the server, so the requests can go to
an internal network. Each request has a time limit of 30 seconds.

### Slack resolver

The options are the signing secret of the Slack app and the subject: the Slack user
(`user_id`) or the team and the user (`team_user`, `<team>:<user>`). A resolve verifies the
signature of the request and its age (at most five minutes). A store does not verify them again:
the store gets the context of a request that n8n verified before, for example at the end of an
OAuth flow that started more than five minutes after the request.

## Resolution and storage

The ordinary credentials helper calls the module through `DynamicCredentialsProxy`.

- A private credential uses its resolver, else the resolver of the workflow settings, else the
  system resolver.
- The run needs a credential context (the identity of the run). Without it, the resolution fails:
  `This node uses an end-user credential, but no user could be identified for this run, so the
  credential for it couldn't be resolved`.
- A custom resolver does not accept an n8n identity (a session or an n8n OAuth token).
- The stored data replaces the static data of the credential. Without stored data, the system
  resolver gives `'<name>' end-user credential is not connected for you. Connect yours to execute
  this workflow manually.`
- A store keeps only the fields that are not shared: the shared fields (each field of the
  credential type that is not a `resolvableField` and has no `doNotInherit`) stay in the
  credential.

## Connections

The system resolver keeps the data of each n8n user in `dynamic_credential_user_entry`.

- The credential routes give `connectedByMe`, the account of the connection
  (`connectedAccountIdentifier`) and the number of connected users.
- `DELETE /rest/credentials/:credentialId/my-connection` removes the own connection.
- n8n deletes the connections of a credential when it becomes static, and when a shared field
  changes.
- n8n deletes the connections of a user to the credentials that the user can no longer use
  (without the scope `credential:connect`): after a change of their project role, after they leave
  a project, after the deletion of a project of the user, and after a transfer of the credential
  for the members of the source project. The database deletes the connections of a deleted user.

## Public endpoints

Apps and the Dynamic Credential Check node call these routes. A route accepts the session of the
editor, or the static token of `N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN`. The identity is the
`Authorization` header (`?authSource=bearer`) or the session (`?authSource=cookie`).

- `GET /rest/workflows/:workflowId/execution-status` tells if the identity has the data of each
  private credential of the workflow, with the authorization and revoke URLs.
- `POST /rest/credentials/:id/authorize?resolverId=<id>` gives the URL of the OAuth flow. The
  OAuth callback of n8n stores the token for the identity.
- `DELETE /rest/credentials/:id/revoke?resolverId=<id>` deletes the data of the identity.
- `GET /rest/credentials/:id/authorize?token=<token>` opens an authorization link of the
  credential check. A link is valid for one hour. A link for an n8n user needs that user to sign
  in.
- The `OPTIONS` routes answer the CORS preflight.

## Hooks

The context establishment hooks read the identity from the first item of a Webhook trigger:

- `HttpHeaderExtractor`: a header (default `authorization`) and a pattern (default
  `[Bb][Ee][Aa][Rr][Ee][Rr]\s+(.+)`).
- `BearerTokenExtractor`: the bearer token of the `Authorization` header.
- `SlackSignatureExtractor`: the raw body and the signature headers of a Slack request.

Each hook replaces the values that it read with `**********` in the trigger item.

## Files

| File | What it is |
|---|---|
| `dynamic-credentials.module.ts` | The module `dynamic-credentials` (`feat:dynamicCredentials`). |
| `credential-resolvers.controller.ts`, `dynamic-credentials.controller.ts`, `workflow-status.controller.ts` | The REST API. |
| `credential-resolvers/` | The resolver types, the identifiers of the identities and the two storages. |
| `context-establishment-hooks/` | The hooks of the Webhook node. |
| `services/` | The resolution, the storage, the connections, the resolvers, the credential check, the links and CORS. |
| `database/` | The entities and the repositories of the three tables. |
| `config-redaction.ts`, `constants.ts`, `utils.ts`, `errors/` | The redaction of secrets, the system resolver, the middleware of the endpoints and the errors. |

## Tests

- The golden tests in `test/integration/dynamic-credentials` (`*.golden.test.ts`) record the
  resolvers, the resolution and the storage, the hooks and the Slack resolver, the public
  endpoints, and the connections, with a fake OAuth2 server (`fake-identity-provider.ts`). The
  snapshots were recorded against the enterprise module, two times with the same result, and the
  fork module gives the same snapshots. `subject.ts` names the code under test.
- The ordinary upstream tests run against the fork module: the repository and storage tests in
  `test/integration/dynamic-credentials`, `test/integration/credentials/credentials.resolvable.api.test.ts`,
  `test/integration/manual-execution-credential-context.test.ts`, and the unit tests of the
  credentials controller and the credentials helper.

## Upstream updates

- The ordinary tests above, `credentials.service.ts` (`getChangedSharedFields`) and the test server
  import the fork module. Keep the fork import paths.
- When upstream changes the proxies or the interfaces in `packages/cli/src/credentials`, the
  contracts of `@n8n/decorators` or the migrations of the three tables, compare the change, update
  the fork module, and record the snapshots again.
