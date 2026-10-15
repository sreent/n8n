# LDAP

Fork module (not in upstream n8n). It is a clean-room rebuild of the LDAP feature of the n8n
Enterprise Edition: users sign in with the user name and password of an LDAP directory, and n8n
synchronizes the users of the directory. The settings page Settings > LDAP of the editor is
ordinary code and uses the REST API of this module. The public API of LDAP
(`/api/v1/settings/ldap` and `/api/v1/settings/ldap/sync`) is ordinary code too.

The sources of the rebuild are the public documentation
([LDAP](https://docs.n8n.io/user-management/ldap/)), the ordinary code of n8n (`LdapConfig` and
`LDAP_DEFAULT_CONFIGURATION` in `@n8n/constants`, the migration `CreateLdapEntities`, the entities
`AuthIdentity` and `AuthProviderSyncHistory`, the sign-in route and the auth handler registry, the
SSO helpers, the events, the public API and its DTOs, the `ldap:reset` command, the editor page),
the ordinary upstream tests (`test/integration/ldap/ldap.api.test.ts`,
`test/integration/public-api/ldap.test.ts` and `test/integration/commands/ldap/reset.test.ts`), and
the behaviour of the original module. A black-box golden test recorded that behaviour (see
"Tests"). The enterprise files were not read.

## Turn it on

- The licence value `feat:ldap`. The fork switch gives it (`packages/cli/src/fork-features.ts`).
- The module is a default module and starts on a main instance.
- An admin sets the directory at Settings > LDAP, or with the public API. The routes need the
  scope `ldap:manage` (the configuration and the test of the connection) or `ldap:sync` (the
  synchronization). The owner and the admin have both scopes.

## Configuration

The settings row `features.ldap` keeps the configuration as JSON. The migration
`CreateLdapEntities` writes the default configuration (`LDAP_DEFAULT_CONFIGURATION`).

- A save checks the body against a JSON schema of the 20 fields: the type of each field, no other
  fields, and all fields except `enforceEmailUniqueness`. A failed check answers 400 with each
  error as `request.body.<field> <error>`, separated by commas, for example
  `request.body.connectionPort is not of a type(s) number` or
  `request.body.undefined requires property "baseDn"`. The check does not limit the values: a
  port of 0 or a filter without parentheses is valid.
- The binding password is stored encrypted (`cipher.encryptV2`). The answers give
  `__n8n_BLANK_VALUE_…` (the blanking value of n8n) for a password, and an empty text for no
  password. A save of the blanking value keeps the stored password.
- A stored configuration without `enforceEmailUniqueness` reads as `true`.
- Login on makes LDAP the sign-in method. It needs email or LDAP as the current sign-in method:
  else the save answers 400
  `Cannot switch ldap login enabled state when an authentication method other than email or ldap is active (current: <method>)`.
- Login off makes email the sign-in method when LDAP was. It deletes all LDAP identities, so the
  LDAP users become email users, and it stores the synchronization as off.
- The login state and the label go to the sign-in page (`N8N_SSO_LDAP_LOGIN_ENABLED` and
  `N8N_SSO_LDAP_LOGIN_LABEL` in the config). At the start, a stored login on while SAML or OIDC is
  the sign-in method only gives the warning
  `Cannot set LDAP login enabled state when an authentication method other than email or ldap is active (current: <method>)`.
- Each save emits `ldap-settings-updated` with the user and 12 fields of the configuration (not
  the connection and not the password).

## Connection

- The URL is `ldap://<host>:<port>`, or `ldaps://<host>:<port>` for TLS. The host field is used as
  it is.
- TLS and STARTTLS check the certificate unless `allowUnauthorizedCerts` is on. STARTTLS starts
  once, when n8n makes the client.
- n8n keeps one client. A save or a start makes a new one.
- n8n binds with the binding DN and password. Empty ones bind anonymously.
- The test of the connection binds and answers 200, or 400 with the message of the directory.

## Sign-in

The service is the `ldap` password handler of the sign-in route. With LDAP as the sign-in method,
the route tries the email and n8n password first, and then LDAP for all users except the owner.

1. Nothing happens without the licence or with the login off.
2. n8n searches the base DN for `(&<user filter>(<login ID attribute>=<login ID>))`. The login ID
   is escaped. Without a user filter, the filter is `(|(objectClass=person)(objectClass=user))`.
   A failed search emits `ldap-login-sync-failed`.
3. With more entries, the last one counts. n8n binds as the entry with the password.
4. An entry without its LDAP ID attribute or without an email does not sign in. `objectGUID` and
   `objectSid` become hexadecimal text.
5. A known LDAP ID signs in its user, after n8n writes the names and the email of the directory to
   the user. A disabled user does not sign in.
6. For a new LDAP ID, with `enforceEmailUniqueness` on, n8n searches the email. When more entries
   have it, the sign-in stops with the warning
   `LDAP login blocked: Multiple LDAP accounts share the same email`.
7. A user with the same email (also the owner, an admin or a disabled user) gets the LDAP identity
   and the names of the directory. Else n8n creates a member with a personal project, the LDAP
   identity and a random password, and emits `user-signed-up`.

## Synchronization

`POST /rest/ldap/sync` with `type` `dry` or `live`, the public API, or the timer each
`synchronizationInterval` minutes (live). Each run:

1. Searches for `(&<user filter>(<login ID attribute>=*))`. A failure answers 400 with the message,
   and no history row: `LdapRejectionError` for an answer of the directory, `LdapConnectionError`
   for a network failure.
2. With `enforceEmailUniqueness` on, skips the entries that share an email (in the same case) with
   another entry.
3. Compares the LDAP IDs with the LDAP identities of n8n: new IDs to create, known IDs to update,
   and identities without an entry to disable. An entry with an invalid email stays out of create
   and update, with the warning `LDAP - Invalid email format for user <LDAP ID>`, and its user is
   not disabled. A user of a skipped duplicate is disabled.
4. A live run writes the changes. Create links a user with the same email, else it creates a user.
   Disable sets the user as disabled and deletes the identity. A failure of a write gives the run
   the status `error` with the message.
5. Adds a row to the history (`auth_provider_sync_history`), and emits
   `ldap-general-sync-finished`. Its `type` is `scheduled` while no timer runs, else
   `manual_<mode>`, as in the original.

`GET /rest/ldap/sync?page=<n>&perPage=<n>` gives the history, newest first, 20 rows by default.

## Differences from the original

- A synchronization skips an entry without its LDAP ID attribute, with a warning. The original
  tries to create it, and the run ends with a database error.
- A sign-in with an email of more values and `enforceEmailUniqueness` off stops with a warning. The
  original fails with a server error.
- A synchronization interval of zero minutes or less does not start a timer.
- The writes of a live run run one after the other. The original runs them at the same time, so
  after a failure its result can change from run to run.

## Files

| File | What it is |
|---|---|
| `ldap.module.ts` | The module `ldap` (`feat:ldap`, main instances). |
| `ldap.service.ts` | The configuration, the client, the sign-in handler and the synchronization. |
| `ldap.controller.ts` | The REST API `/rest/ldap`. |
| `helpers.ts` | The schema check, the filters, the attribute mapping and the history functions that the public API and the tests use. |
| `database/ldap.repository.ts` | The queries of the users, the identities and the history. |
| `ldap.errors.ts`, `redact-ldap-config.ts`, `constants.ts`, `types.ts` | The errors, the redaction of the password, the schema and the types. |

## Tests

- `test/integration/ldap/ldap.golden.test.ts` runs a fake directory (a fake of the `ldapts`
  client) and records the REST routes, the sign-in, the synchronization, the timer, the module,
  the events, the warnings and the database. The snapshot was recorded against the enterprise
  module, two times with the same result, and the fork module gives the same snapshot. `subject.ts`
  names the code under test.
- The ordinary upstream tests run against the fork module: `test/integration/ldap/ldap.api.test.ts`,
  `test/integration/public-api/ldap.test.ts` and `test/integration/commands/ldap/reset.test.ts`.

## Upstream updates

- The public API files `controllers/ldap.public.controller.ts` and `handlers/ldap/ldap.handler.ts`,
  the three ordinary tests, `controllers/__tests__/auth.controller.test.ts` and the `ldap` group of
  the test server import the fork module. Keep the fork import paths.
- When upstream changes `LdapConfig`, the migration of the settings row or the sign-in route,
  compare the change, update the fork module, and record the snapshot again.
