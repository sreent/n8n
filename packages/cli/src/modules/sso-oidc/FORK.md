# The fork's OIDC sign-in

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../FORK.md) and
[packages/cli/src/sso/FORK.md](../../sso/FORK.md).

`oidc.service.ts` and `oidc.controller.ts` replace the enterprise `oidc.service.ee.ts` and
`oidc.controller.ee.ts` for all ordinary code: the module (`sso-oidc.module.ts`), the public API
controller and the ordinary tests. This is the second pull request of step 4. The class name
`OidcService` and the methods that ordinary code calls (`init`, `loadConfig` and `updateConfig`)
stay. The module loads only with the `feat:oidc` licence, as before. While the fork switch is on
(step 5 of FORK.md), the licence has `feat:oidc`, so the module loads by default.

## Behaviour

### The config

- The settings row `features.oidc` (`loadOnStartup`) holds the config as JSON: the fields of
  `OidcConfigDto` in their order, with the client secret encrypted by `Cipher.encryptV2`.
- With `N8N_SSO_MANAGED_BY_ENV=true`, the ordinary SSO instance settings loader writes this row
  from the `N8N_SSO_OIDC_*` variables at each start, before the module starts. With the OIDC login
  off, the row holds only `loginEnabled: false`.
- `loadConfig(decryptSecret = false)` reads the row each time. A missing row, a row that is not
  JSON, and a row that `OidcConfigDto` refuses give the default config: an empty client id and
  secret, the discovery endpoint `http://n8n.io/not-set`, the login off, the prompt
  `select_account`, no ACR values, no extra scopes, and the RP-initiated logout off. The discovery
  endpoint is a `URL`. With `decryptSecret`, a secret that does not decrypt is an empty string.
- `init()` loads the config into memory, and applies its login state.
- The login state works as the SAML helper `setSamlLoginEnabled`. With the login on,
  `assertAuthenticationMethodCanBeEnabled('oidc')` runs first, and the sign-in method becomes
  `oidc`. With the login off, the method changes from `oidc` to `email`, and else stays.
  `sso.oidc.loginEnabled` gets the login state.
- `updateConfig(config)` does these steps:
  1. The redacted secret value (`OIDC_CLIENT_SECRET_REDACTED_VALUE`) keeps the secret of the config
     in memory.
  2. With the login on, it checks the sign-in method (400 when another SSO method is active).
  3. It runs a discovery with the new config. A failure gives a `UserError` (400): "Failed to
     discover OIDC metadata, based on the provided configuration".
  4. It writes the row, replaces the config in memory, clears the cached provider metadata, and
     applies the login state.
  5. In multi-main mode, it sends the `reload-oidc-config` command.
- The `reload-oidc-config` command loads the config into memory and clears the cached metadata, on
  each main instance in each role. It does not change `sso.oidc.loginEnabled` or the sign-in
  method.

### The endpoints

Each endpoint needs the `feat:oidc` licence (403 "Plan lacks license for this feature"). The
config endpoints also need the `oidc:manage` scope.

| Endpoint | What it does |
|---|---|
| `GET /sso/oidc/config` | The stored config, with the discovery endpoint as the URL parser writes it. The client secret is the redacted value, or empty when the stored secret is empty. |
| `POST /sso/oidc/config` | After the body check (`OidcConfigDto`, unknown keys are dropped): when SSO is managed by the environment (`ssoManagedByEnv`), 403 "OIDC configuration is managed via environment variables and cannot be modified through the API". Else `updateConfig`, and the response of `GET`. |
| `POST /sso/oidc/config/test` | An authorization URL from the stored config, with a new discovery. The state cookie has `testMode`. An error of the discovery goes to the caller (500). |
| `GET /sso/oidc/login` | No session needed. 403 "OIDC login is not enabled", unless the login is on in the config in memory and `oidc` is the sign-in method. `sso.oidc.loginEnabled` does not count. Else a redirect (302) to the authorization URL, with the state and nonce cookies. |
| `GET /sso/oidc/callback` | No session needed. See below. |
| `POST /sso/oidc/logout` | Session needed. See below. |

### The authorization request

- The state is `n8n_state:<uuid v4>` and the nonce is `n8n_nonce:<uuid v4>`.
- The parameters, in this order: `redirect_uri` (`<instance base URL>/<rest endpoint>/sso/oidc/callback`),
  `response_type=code`, `scope`, `prompt`, `state`, `nonce`, `acr_values` (the ACR values joined
  with spaces, only when there are some), and `client_id` (from `openid-client`). There is no PKCE.
- The scope is `openid email profile`, then the scope name of the role provisioning when it gives
  roles from direct claims (also when the name is empty), then the extra scopes with the outer
  spaces removed. One space separates each part.
- The cookie `n8n-oidc-state` holds a JWT with the audience `n8n:oidc-state`: the state, and
  `testMode` or `redirectUrl`. The cookie `n8n-oidc-nonce` holds a JWT with the audience
  `n8n:oidc-nonce` and the nonce. `JwtService` signs both. They live 15 minutes, are `HttpOnly`,
  and take `SameSite` and `Secure` from the auth cookie config.
- The login puts a `redirect` query into the state cookie when `validateRedirectUrl` keeps it and it
  is not `/`.

### The provider metadata

- The login, the callback and the logout share one cached discovery of the config in memory. It
  serves for one hour from its request, also when it failed. A config change and the reload command
  clear it. `init()` and the connection test do not.
- The connection test and its callback run their own discovery of the stored config.
- `openid-client` sends the requests through
  `OutboundHttp.transport({ proxy: false, useDefaultSsrfPolicy: 'unsafe' })`:
  - A direct connection, as the original makes. A black-box probe showed that the original does not
    use the proxy of the environment: with `HTTPS_PROXY` set, its discovery failed on the DNS lookup
    of the provider host.
  - No SSRF check, as the original. The backend-network README tells to use `'unsafe'` for an
    admin-configured provider that can be internal.

### The callback

1. Both cookies must be there, and the state cookie must verify. Else the callback redirects to
   `<instance base URL>/signin?ssoError=login-failed`, and the cookies stay.
2. It clears both cookies. Then the nonce cookie must verify.
3. In test mode (the state cookie has `testMode`), it runs the token and userinfo requests with the
   stored config and a new discovery. It sends the page of `renderOidcTestSuccess` (the claims of
   the id token and the userinfo response), or the page of `renderOidcTestFailure` with "Invalid
   authorization code" (the token request or its checks fail), "Invalid token" (userinfo fails), or
   the message of another error. Test mode does not check the login, the email or the user, and
   sends no events.
4. Else the login must be on, as for the login.
5. The token request (`authorizationCodeGrant` with the expected state and nonce, and the client
   secret in the body), and userinfo (`fetchUserInfo` with the subject of the id token).
   `openid-client` does not check the signature of an id token from the token endpoint.
6. The email comes from userinfo only. It must be there and valid (`isValidEmail` of `@n8n/db`),
   also for a user with an identity.
7. The role provisioning resolves the roles from the claims, before n8n links or creates the user
   (see [the role provisioning](../provisioning/FORK.md#an-sso-sign-in)). When the roles refuse the
   account (`block:access`), the callback sends the event `user-login-failed`
   (`authenticationMethod: 'oidc'`, `userEmail: 'unknown'`, without a `reason`), redirects to
   `<instance base URL>/signin?ssoError=access-denied`, and changes nothing.
8. The email, in lowercase, finds the user:
   - the user of the OIDC identity (the subject), as it is;
   - else the user with the email. The `email_verified` value of userinfo decides: with
     `emailVerifiedRequired`, only `true` and `'true'` pass. Without it, `false` and `'false'` fail.
     The user gets the OIDC identity. The names do not change.
   - else a new member: the email, the names of userinfo (`given_name` and `family_name`, as they
     are), the password `no password set` (not a hash, so no password matches), a personal project,
     and the OIDC identity. `sso.justInTimeProvisioning` does not count.

   The callback does not check whether the user is disabled or pending. A disabled user gets a
   session cookie, which the session check of n8n refuses on the next request.

   Then the role provisioning applies the roles to the user.
9. The session cookie (`AuthService.issueCookie` with `usedMfa` true and `req.browserId`). The
   cookie `n8n-oidc-id-token` with the id token, encrypted by `Cipher.encryptV2`, when the encrypted
   value has 3800 characters or fewer. It lives as long as the session. The event `user-logged-in`
   (`authenticationMethod: 'oidc'`). A redirect to the `redirectUrl` of the state cookie, or `/`.
10. Each other failure outside test mode, also in step 1, sends the event `user-login-failed`
    (`authenticationMethod: 'oidc'`, `userEmail: 'unknown'`, and as `reason` the `error` query of
    the provider or `oidc_callback_failed`), and redirects as in step 1.

### The logout

- `redirectUrl` is the end session URL of the provider (`id_token_hint`,
  `post_logout_redirect_uri` `<instance base URL>/signin`, and `client_id`), when the RP-initiated
  logout is on, the login is on (as for the login), the id token cookie decrypts to a token, and the
  metadata has an `end_session_endpoint`. Else, and after a failure, it is null.
- The logout revokes the session token, and clears the session cookie and the id token cookie.

### Rate limits

- The fork has no IP rate limit on these endpoints. A probe in production mode found none on the
  endpoints of the original.

## Clean-room sources

- The ordinary code of the module: `sso-oidc.module.ts`, `constants.ts`, and the test result page
  `views/oidc-test-result.ts`.
- The ordinary callers and neighbours: the public API controller, the OIDC instance settings
  loader, `OidcConfigDto` and the public DTOs, the REST client of the editor, the frontend service,
  the token purposes of `JwtService` (`oidcState` and `oidcNonce`), `AuthService`, `UrlService`,
  `validateRedirectUrl`, `isValidEmail`, the SAML helpers, the user entity, and the README of
  `@n8n/backend-network`.
- The ordinary tests: the public API test, the instance settings loader test, and the test of the
  test result page.
- The public n8n documentation of OIDC.
- The behaviour of the original files, recorded black-box by the golden test (below), and by
  probes that ran outside the committed tests:
  - spies on the `OutboundHttp` prototype, and wrappers of the `@n8n/backend-network/transport` and
    `undici` modules, which recorded no calls of the original;
  - the error cause of a discovery to a host that does not resolve;
  - a run in production mode, which sent repeated requests to each endpoint, to look for IP rate
    limits.

The enterprise files and their tests were not read, and the enterprise tests were not run on the
fork code, as the repository owner chose. There was one slip: a search with a shell glob printed 10
lines of `sso-saml/saml.service.ee.ts` (calls of the ordinary `SamlValidator`). The OIDC code does
not use them.

The role provisioning of the sign-in came in a later pull request. Its sources, and the two slips of
that work, are in [the role provisioning document](../provisioning/FORK.md#clean-room-sources).

### Instrumentation of the library boundary

`openid-client` is a third-party library. The golden test wraps its functions: each call gets the
global fetch, which nock answers for the fake provider. The wrapper changes no argument other than
`customFetch`. During the work, a second wrapper also recorded the names and the arguments of the
calls (for example the arguments of `discovery`), for diagnosis. The committed test does not record
them.

## The golden test

`__tests__/oidc.integration.test.ts` runs the endpoints and the service on a real database, with a
fake provider (nock, RS256 keys). Its 11 parts cover:

- reading and saving the config: each role, with and without the licence, valid and invalid bodies,
  failing discoveries, the redacted secret, another provider, the sign-in methods `saml`, `ldap` and
  `oidc`, SSO managed by the environment, and multi-main;
- the connection test, the login (prompts, ACR values, scopes, redirect values, the base URL of the
  editor, the login flags) and the callback (new, linked and existing users, `email_verified` and
  `emailVerifiedRequired`, names, large id tokens and redirects), and 32 cases around failures of
  the callback;
- the connection test callback, with its success page and its failures;
- the logout, with and without the RP-initiated logout;
- the cookie settings (`SameSite`, `Secure`, the session duration);
- the service: `init()` with stored rows of each kind, `loadConfig`, `updateConfig`, a row that
  another instance changed, and the reload command in each instance role;
- the provider metadata over time (with a fake clock): the cache lifetime to the millisecond, a
  failed discovery, the connection test, `init()`, and the expiry of the state cookie.

For each case, the snapshot records the response (status, location, cookies with their decoded
claims and decrypted values, body), the requests to the provider, the events, the pub/sub
commands, the sign-in state, the rows that changed, and the passwords of new or changed users.

The test runs with the role provisioning at its defaults (off). The golden test of the role
provisioning (`modules/provisioning/__tests__/provisioning.integration.test.ts`) covers OIDC
sign-ins that give roles.

The snapshot was recorded against the original files. The fork files give the same snapshot. The
fork no longer has the original files. To record the snapshot again after an upstream update, record
it in a checkout of upstream n8n, as FORK.md tells ("Upstream updates"), with the two imports of the
code under test at `@/modules/sso-oidc/oidc.service.ee` and `@/modules/sso-oidc/oidc.controller.ee`.

`__tests__/oidc.service.test.ts` checks the transport that the fork gives `openid-client`, which the
golden test replaces.

## Removed enterprise files

- The fork deleted `oidc.service.ee.ts`, `oidc.controller.ee.ts` and their tests in step 4. Before,
  container CI left out these tests.
