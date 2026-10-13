# No registration and no licence keys

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../FORK.md).

The fork turns on its features with the fork switch (`packages/cli/src/fork-features.ts`, step 5 of
FORK.md), without a registration and without a licence key. On 2026-10-13 the owner chose to remove
from the fork the flows that send data to n8n to get a licence, and the entry of licence keys.

## What the fork removed

| Part | Backend | Editor |
| --- | --- | --- |
| Registration of the Community Edition | The route `POST /rest/license/enterprise/community-registered`, which sent the email address, the instance ID and the instance URL to `https://enterprise.n8n.io/community-registered` | The modal "Get paid features for free (forever)" and the four places that opened it: the end of the setup survey, the notice of Settings > Usage and plan, the folder button of the workflows page when folders were off, and the button of the evaluations paywall |
| Request of an enterprise trial | The route `POST /rest/license/enterprise/request_trial`, which sent the name, the email address and the instance URL to `https://enterprise.n8n.io/enterprise-trial` | The store action and the REST client function (no screen used them) |
| Licence key entry | The routes `POST /rest/license/activate` and `POST /rest/license/renew` (the renewal also gave the token of the "Manage plan" link), and the activation at start-up with `N8N_LICENSE_ACTIVATION_KEY` | On Settings > Usage and plan: the button "Enter activation key" with its dialog, the EULA dialog and the success dialog, the activation from the URL parameter `key`, and the links "Manage plan" and "View plans" |

The licence service now has only `getLicenseData`, and the controller only `GET /rest/license`. The
usage store and the REST client read the licence data only. When `N8N_LICENSE_ACTIVATION_KEY` is
set, n8n logs a warning at start-up and does not use the key.

The evaluations paywall shows "Evaluations are off" without a button. It shows only while the fork
switch is off (`N8N_FORK_FEATURES_ENABLED=false`). See
[the FORK.md of the evaluation editor](../../../frontend/editor-ui/src/features/ai/evaluation/FORK.md).

## What stays

- **The page Settings > Usage and plan** shows the plan and the use of active workflows.
- **A stored licence certificate.** The `License` class still reads a certificate that the database
  or `N8N_LICENSE_CERT` holds, for example from an upstream n8n before the change to the fork, and
  the licence renewal task renews it with the licence server of n8n. The fork makes no new
  certificate. `n8n license:clear` deletes a stored certificate, and `n8n license:info` shows it.
- **Upstream code that nothing uses now**, kept to keep the changes to upstream files small: the
  methods `activate` and `getManagementJwt` of the `License` class, the error class
  `LicenseEulaRequiredError`, the request type `LicenseRequest.Activate`, the response type
  `ILicensePostResponse`, the DTO `CommunityRegisteredRequestDto` and the optional field
  `managementToken` of the usage schema in `@n8n/api-types`, the telemetry event of the
  registration, the scopes `community:register` and `license:manage` in the role data, and the
  i18n texts. The paywall of debug in editor still names the Registered
  Community Edition. It shows only while the fork switch is off. A Playwright intercept stubs
  `/rest/license/renew`, which the editor no longer calls.

## Tests

- `__tests__/license.controller.test.ts`: the controller has only the route `GET /`.
- `__tests__/license.service.test.ts`: the licence data.
- `test/integration/license.api.test.ts`: `GET /rest/license`, and the four removed routes answer
  404.
- `commands/__tests__/base-command.fork-license.test.ts`: the start-up activates no key, and warns
  when `N8N_LICENSE_ACTIVATION_KEY` is set.
- `features/settings/usage/views/SettingsUsageAndPlan.test.ts` (editor): the page loads the licence
  data, and shows no button, also to a user with the scopes `license:manage` and
  `community:register`.
- `app/__tests__/modal-key-ratchet.test.ts` (editor): the registration modal is not in the modal
  list.

## Upstream updates

Keep the parts above removed. When an update changes the licence controller, the licence service,
`initLicense` of `commands/base-command.ts`, the page Settings > Usage and plan, the usage store, the
REST client `api/usage.ts`, the setup survey (`PersonalizationModal.vue`) or the folder button of
`WorkflowsView.vue`, merge the upstream change into what the fork keeps. When the update brings a new
flow that registers the instance or enters a licence key, ask the owner. The tests above fail when a
removed route or the activation at start-up comes back.
