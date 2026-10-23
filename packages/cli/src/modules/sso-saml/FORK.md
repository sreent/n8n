# The fork's SAML sign-in

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../FORK.md),
[packages/cli/src/sso/FORK.md](../../sso/FORK.md) and
[the role provisioning document](../provisioning/FORK.md).

`saml.service.ts`, `saml.controller.ts` and `service-provider.ts` replace the enterprise
`saml.service.ee.ts`, `saml.controller.ee.ts` and `service-provider.ee.ts` for all ordinary code: the
module (`sso-saml.module.ts`), the SAML helpers, the public API controller and its mapper, the test
server and the ordinary tests. This is the fourth pull request of step 4. The class name
`SamlService`, the functions of the service provider, the methods that ordinary code calls, and the
members that ordinary tests use (`_samlPreferences` and `getDecryptedSigningPrivateKey`) stay. The
module loads only with the `feat:saml` licence, as before. While the fork switch is on (step 5 of
FORK.md), the licence has `feat:saml`, so the module loads by default.

## Behaviour

### The preferences

- The service keeps the preferences in memory (`_samlPreferences`). Before any change, they are: the
  mapping of the public documentation (the claims `emailaddress`, `firstname`, `lastname` and `upn`
  of `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/`), empty metadata and metadata URL,
  `ignoreSSL` false, the login binding `redirect`, the ACS binding `post`, `authnRequestsSigned`
  false, the login off, an empty label, `wantAssertionsSigned` and `wantMessageSigned` true, the
  relay state `<instance base URL>`, and the signature config `ds` after
  `/samlp:Response/saml:Issuer`.
- The getter `samlPreferences` gives them with `loginEnabled` and `loginLabel` of the instance
  config (`sso.saml`).
- The settings row `features.saml` (`loadOnStartup`) holds the preferences as JSON, with the signing
  key encrypted by `Cipher.encryptV2`. The key in memory is encrypted too.
- With `N8N_SSO_MANAGED_BY_ENV=true`, the ordinary SSO instance settings loader replaces this row
  at each start, before the module starts. The row then holds only the metadata, the metadata URL
  and the login state of the `N8N_SSO_SAML_*` variables. With the SAML login off, the row holds
  only `loginEnabled: false`.
- `setSamlPreferences(preferences)` does these steps:
  1. It checks the signing settings (below). An error changes nothing.
  2. It loads samlify and the validator, the first time. samlify then checks each SAML message
     against the schema of the ordinary `SamlValidator`. A message that is not valid gives an
     `InvalidSamlMetadataError`.
  3. It takes each field that has a value. The body schema `SamlPreferences` gives defaults, so a
     request from the API always sets `ignoreSSL`, the bindings, the signing flags and the signature
     config. The relay state of a request does not count. An empty signing value removes the stored
     value, the redacted value (`CREDENTIAL_BLANKING_VALUE`) keeps it, and a new key is encrypted.
     The label goes to the instance config.
  4. With a metadata URL, the service keeps the URL and fetches the metadata (below). Else, metadata
     replaces the stored metadata and removes the URL.
  5. With `loginEnabled`, it sets the login state as the SAML helper `setSamlLoginEnabled` does. This
     can fail (400) when another SSO method is active.
  6. When there is metadata, or the login is on, the metadata must be valid
     (`SamlValidator.validateMetadata`): else an `InvalidSamlMetadataError` (400). Then the service
     makes the identity provider again from the metadata.
  7. It writes the row and, in multi-main mode, sends the `reload-saml-config` command.

  A failure in step 4, 5 or 6 leaves the changed fields in memory and the row as it was.
- The signing settings: a new key or certificate needs `N8N_ENV_FEAT_SIGNED_SAML_REQUESTS=true`, else
  400 "SAML request signing is not enabled. Set N8N_ENV_FEAT_SIGNED_SAML_REQUESTS=true to enable
  this feature.". With the flag, a key must be a PEM private key and a certificate a PEM
  certificate (400 each). With `authnRequestsSigned`, the key and the certificate after the change
  must both be there (400) and must match (400). Without the flag, `authnRequestsSigned` alone
  passes.
- `fetchMetadataFromUrl(url)` sends a GET through `OutboundHttp.requests` (no SSRF check, as for
  OIDC: the identity provider is admin-configured and may be internal), with the certificate check
  off when `ignoreSSL` is on. A failure gives 400 "Error fetching SAML Metadata from <url>: <error>".
  An answer that is not valid metadata gives 400 "Data received from <url> is not valid SAML
  metadata.".
- `loadFromDbAndApplySamlPreferences(apply = true)` reads the row: `undefined` without a row, a
  `SyntaxError` when the row is not JSON. With `apply`, the service takes the row as in steps 2 to 6,
  without the signing check and without a write. When the metadata URL of the row fails, the
  metadata of the row serves. Without metadata in the row, the error is an
  `InvalidSamlMetadataUrlError`.
- `init()` takes the row. When the row is not JSON, its metadata is not valid, or its URL fails
  without metadata, `init()` resets (below). Another error, for example another active SSO method,
  goes to the caller.
- `reset()` turns the login off (`setSamlLoginEnabled(false)`) and deletes the row. The preferences
  in memory stay.
- The `reload-saml-config` command takes the row on each main instance in each role. An error goes
  to the log.

### The service provider

- `getServiceProviderEntityId()` is `<instance base URL>/<rest endpoint>/sso/saml/metadata`,
  `getServiceProviderReturnUrl()` is `.../sso/saml/acs`, and
  `getServiceProviderConfigTestReturnUrl()` is `<instance base URL>/config/test/return`.
- The process makes the samlify service provider once, at its first use, from the preferences of
  that moment: `authnRequestsSigned`, `wantAssertionsSigned`, `wantMessageSigned`, the signature
  config and the ACS binding. A later change of these preferences applies after a restart. The
  golden test shows this for the original.
- Its metadata: the entity ID, `AuthnRequestsSigned`, `WantAssertionsSigned`, the name ID format
  `emailAddress`, and two assertion consumer services: index 0 with the POST binding, and index 1
  with the binding `urn:oasis:names:tc:SAML:2.0:bindings:HTTP-REDIRECT` (in upper case, as the
  original writes it). The ACS binding of the preferences is the default.
- The service provider gets neither the signing key nor the signing certificate, as in the
  original: its metadata has no key descriptor, and a login request with `authnRequestsSigned`
  fails (500 "This is not private key" with the redirect binding, and a 500 of the signing library
  with the POST binding). The second golden test records this for a process that starts with a
  stored config with signed requests. Signed login requests are an experimental feature of the
  original (`N8N_ENV_FEAT_SIGNED_SAML_REQUESTS`). The fork stores and checks the signing settings,
  as the original does.
- Before samlify loads, the service provider is not available: 500 "Samlify is not initialized".

### The endpoints

The config endpoints need a session and the `saml:manage` scope, then the licence: without
`feat:saml`, 403 `{ status: 'error', message: 'Unauthorized' }` (the ordinary
`samlLicensedMiddleware`). So a user without the scope gets the scope error also without the
licence.

| Endpoint | What it does |
|---|---|
| `GET /sso/saml/metadata` | No session and no licence needed. The metadata of the service provider, as `text/xml`. An error keeps the `text/xml` type. |
| `GET /sso/saml/config` | The preferences (the getter), the signing key redacted, with `entityID` and `returnUrl`. |
| `POST /sso/saml/config` | After the body check (`SamlPreferences`; a failure gives 400 with the first zod issue as the body): when SSO is managed by the environment (`ssoManagedByEnv`), 403 "SSO configuration is managed via environment variables and cannot be modified through the API". Else `setSamlPreferences`, and the result with the signing key redacted. |
| `POST /sso/saml/config/toggle` | The body `SamlToggleDto`, the environment check as above, then `setSamlPreferences({ loginEnabled })` and 200 `OK`. |
| `POST /sso/saml/config/test` | The login request of a connection test (below). |
| `GET /sso/saml/initsso` | No session needed. The ordinary `samlLicensedAndEnabledMiddleware` (403 `Unauthorized`). The login request, with the relay state of the `redirect` query after `validateRedirectUrl`, or `/`. |
| `GET` and `POST /sso/saml/acs` | No session needed. The licence middleware. The response of the identity provider: in the query (GET, redirect binding) or in the form (POST). |

### The login request

- The identity provider comes from the stored metadata. Without metadata: 400 "Invalid SAML
  metadata: No IdP metadata configured. Please provide valid identity provider metadata.".
- With the login binding `redirect`, the response is `{ data: <URL of the identity provider> }`, with
  `SAMLRequest` and `RelayState`. With `post`, it is the page of the ordinary `getInitSSOFormView`
  with the CSP nonce.
- samlify refuses a request when the `AuthnRequestsSigned` of the service provider and the
  `WantAuthnRequestsSigned` of the identity provider differ (500).
- The connection test uses the login binding of the request body. With metadata (or a metadata URL)
  in the body, the metadata must be valid (400), and the test uses it without storing it: the relay
  state is `<test return URL>?t=<12 hex characters>`, and the ACS gets the preferences back once
  with the id (`consumePendingTestConfig`) for 15 minutes. Without metadata in the body, the relay
  state is the test return URL, and the test uses the stored metadata.

### The assertion consumer service

1. A relay state that starts with the test return URL makes a connection test (step 7).
2. `getAttributesFromLoginResponse` parses the response with samlify: the identity provider of the
   stored metadata, and the service provider. A failure gives "SAML Authentication failed. Could not
   parse SAML response. <error>". This covers a missing response, a response that is not valid for
   the schema (also an empty `InResponseTo`), a signature of another key, a response without a
   signature, an issuer of another entity, a failed status, and a time outside its conditions.
   samlify does not check the audience, the destination or the recipient. A response of the redirect
   binding fails, because the request has no octet string for its signature check.
3. The ordinary `getMappedSamlAttributesFromFlowResult` maps the attributes. A missing attribute of
   the mapping gives "SAML Authentication failed. Invalid SAML response (missing attributes: <names>)."
   in the order email, user principal name, first name, last name.
4. The email in lowercase must be valid (`isValidEmail`), else 400 "Invalid email format".
5. The role provisioning resolves the roles, before n8n links or creates the user (see
   [the role provisioning](../provisioning/FORK.md#an-sso-sign-in)): the direct claims from the
   attributes that the provisioning config names, and the expression context `$claims` (the raw
   attributes), `$saml.attributes` (the same) and `$provider` `saml`.
6. The user:
   - the user of the SAML identity (the user principal name), as it is;
   - else the user with the email. The `emailVerified` attribute (when the mapping names one)
     decides: with `emailVerifiedRequired`, only `true` (in any case) passes. Without it, only
     `false` (in any case) fails, with `SamlEmailNotVerifiedError`. The ordinary
     `updateUserFromSamlAttributes` links the user and changes the names;
   - else a new member by the ordinary `createUserFromSamlAttributes`.

   n8n does not check whether the user is disabled. Then the role provisioning applies the roles.
7. A connection test renders `saml-connection-test-success` with the mapped attributes and the raw
   attributes as JSON, or `saml-connection-test-failed` with the message of the error. It sends no
   events and no cookie, but it links or creates the user as a sign-in does.
8. Else the event `user-logged-in` (`authenticationMethod: 'saml'`) with the user before the role
   change. When the SAML login is on (`isSamlLicensedAndEnabled`), the session cookie (`usedMfa`
   true) and a redirect to `<instance base URL><relay state>`, with `validateRedirectUrl`. Else 202
   with the mapped attributes, and no cookie.
9. A refused sign-in of the role provisioning sends `user-login-failed` (`userEmail` `unknown`,
   `reason` "Access denied by SSO role mapping configuration") and redirects to
   `<instance base URL>/signin?ssoError=access-denied`. Another failure sends `user-login-failed`
   (`userEmail` the email of a `SamlEmailNotVerifiedError`, else `unknown`, and the message as
   `reason`) and gives 401 "SAML Authentication failed: <message>".

## Clean-room sources

- The ordinary code of the module: `sso-saml.module.ts`, `constants.ts`, `types.ts`,
  `saml-helpers.ts`, `saml-validator.ts`, the middleware, the errors, the POST form view and the
  schemas.
- The ordinary callers and neighbours: the public API controller and its mapper, the SAML instance
  settings loader, the DTOs of `@n8n/api-types`, the REST client and the SSO settings of the editor,
  the templates of the connection test, the SSO helpers, the controller registry, the error
  serializer, `validateRedirectUrl`, `isValidEmail`, `createUserWithProject`, the pub/sub event
  map, and the `samlify` library.
- The ordinary tests: the SAML API test, the SAML helper tests, the validator test, the test of the
  POST form view, the public API tests, and the instance settings loader test.
- The public n8n documentation of SAML.
- The behaviour of the original files, recorded black-box by the golden test (below).

The enterprise files and their tests were not read, and the enterprise tests were not run on the
fork code, as the repository owner chose. There were two slips during the preparation:

1. A `grep -r` over `packages/cli/src` searched the contents of the enterprise files for
   `sso/saml`. A filter in the same command removed the lines of enterprise files before the output,
   so no enterprise content or file name reached the output.
2. A `grep` with the shell glob `src/modules/sso-saml/*.ts` searched the three enterprise SAML files
   for the signing flag. The output was empty.

Since then, searches use a wrapper that puts the exclusions last and refuses enterprise paths.

## The golden tests

`__tests__/saml.integration.test.ts` runs the endpoints and the service on a real database, with a
fake identity provider (samlify with the signing fixtures of the ordinary tests, and a key that the
test makes). Its 12 parts cover:

- the first use in a process: the metadata, the config, the login, a sign-in and a connection test
  before any config;
- the metadata of the service provider for each role and licence, and after config changes;
- reading and saving the config: each role and licence, many bodies, merges, the metadata URL (a
  local server), the signing keys with and without the flag, the other sign-in methods, SSO managed
  by the environment, and multi-main;
- toggling the login, the login request (bindings, redirect values) and the connection test with its
  callback;
- the ACS: new, linked and existing users, the email rules, the names, the signatures, the times,
  the values of the response, the relay states, the redirect binding, and the login off;
- the role provisioning: direct claims, mixed project claims, and probes of the expression context;
- the service: `init()` and `loadFromDbAndApplySamlPreferences` with stored rows of each kind, the
  getter, `reset()`, and the reload command in each instance role.

For each case, the snapshot records the response (status, location, cookies with their decoded
claims, body), the events, the pub/sub commands, the sign-in state, the rows that changed (with the
signing key decrypted), and the passwords of new users. The test resets the preferences in memory
before each part, because the service keeps them over `reset()` and over `init()` without a row.

`__tests__/saml-signed-requests.integration.test.ts` runs in its own process, because n8n makes the
service provider once in a process. It stores a config with signed requests, runs `init()` as after
a restart, and records the metadata and the login requests of both bindings, also of the connection
test. The fake identity provider checks the signature of each login request that n8n makes.

The snapshots were recorded against the original files. The fork files give the same snapshots.
The fork no longer has the original files. To record the snapshots again after an upstream update,
record them in a checkout of upstream n8n, as FORK.md tells ("Upstream updates"), with the imports
of the code under test at the `.ee` files that the comments of the tests name.

## Removed enterprise files

- The fork deleted `saml.service.ee.ts`, `saml.controller.ee.ts`, `service-provider.ee.ts` and their
  tests in step 4. Before, container CI left out the two enterprise SAML tests.
