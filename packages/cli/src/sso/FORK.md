# The fork's SSO helpers

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../FORK.md).

`sso-helpers.ts` replaces the enterprise `sso.ee/sso-helpers.ts` for all ordinary code. This is the
first pull request of step 4. The exports keep their names, so that the callers change only their
import. The fork's OIDC, SAML and LDAP modules use these helpers too.

## Behaviour

The sign-in method of the instance is `email`, `ldap`, `saml` or `oidc`. The legacy config holds it
(`userManagement.authenticationMethod`). At start, n8n loads it from the settings row with the same
key.

- `getCurrentAuthenticationMethod()` gives the method in the config, as it is. The settings row does
  not count after the start.
- `setCurrentAuthenticationMethod(method)` sets the method in the config. Then it writes the
  settings row (`loadOnStartup: true`), which a later change replaces. It does not check the method,
  and it does not change the login flags of the SSO config. When the write fails, the config keeps
  the new method and the error goes to the caller.
- `isSsoCurrentAuthenticationMethod()` is true for `ldap`, `saml` and `oidc`.
- `isSamlCurrentAuthenticationMethod()` and `isOidcCurrentAuthenticationMethod()` compare the method
  with `saml` and `oidc`.
- `isSamlLicensed()` reads `feat:saml` from `LicenseState`. While the fork switch is on (step 5 of
  FORK.md), the licence has SAML.
- `isSamlLicensedAndEnabled()` is true when `sso.saml.loginEnabled` is on, the licence has SAML, and
  the method is `saml`. It checks in this order, so with the SAML login off it does not read the
  licence.
- `getSamlLoginLabel()` gives `sso.saml.loginLabel` as it is.
- `assertAuthenticationMethodCanBeEnabled(method)` does nothing when the current method is `email`
  or `method`. Else it throws a `BadRequestError` (400): "Cannot switch {method} login enabled state
  when an authentication method other than email or {method} is active (current: {current})".

## Clean-room sources

- The ordinary code that calls the helpers: the auth, password reset, invitation and me
  controllers, the user, email change and frontend services, the SSO instance settings loader, and
  the SAML helpers and middleware.
- The ordinary config: the `sso` part of `GlobalConfig`, the legacy config schema, and the start
  command that loads the settings rows.
- The ordinary unit and integration tests of those files. One of them showed the order of the
  checks in `isSamlLicensedAndEnabled`.
- The behaviour of the original helpers, recorded black-box by
  `__tests__/sso-helpers.integration.test.ts` (below).

The enterprise file and its test were not read or run on the fork code, as the repository owner
chose.

## The golden test

`__tests__/sso-helpers.integration.test.ts` calls the helpers on a real database. It covers each
sign-in method (also an unknown one), 5 licence states and 5 sets of SSO login flags, the SAML
label, each change from one method to another, a change with all login flags on, the licence source
of the SAML checks and the order of those checks, a database write that fails, and a settings row
that differs from the config. For each call, the snapshot records the result or the error (class
chain, message, status code), the config, and the rows that the call changed.

The snapshot was recorded against the original helpers. The fork helpers give the same snapshot. The
fork no longer has the original file. To record the snapshot again after an upstream update, use a
checkout of the upstream commit in `scripts/sync-upstream.base`: copy the test there, point its
helpers import at `@/sso.ee/sso-helpers`, run it with `-u`, and use its snapshot.

## Removed enterprise files

- The fork deleted `sso.ee/sso-helpers.ts` and its test with the enterprise SAML and OIDC files in
  step 4.
