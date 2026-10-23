# The fork's log streaming settings page

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../../../FORK.md) and
[the README of the log streaming module](../../../../../../cli/src/modules/log-streaming/README.md).

This folder holds the settings page **Settings > Log streaming** and its modal. With the REST
client `eventbus.ts` in `@n8n/rest-api-client`, they replace the enterprise folder
`logStreaming.ee` and the enterprise client `eventbus.ee.ts`. The fork removed both.

| Fork file | Enterprise file that it replaces |
| --- | --- |
| `views/SettingsLogStreamingView.vue` | `logStreaming.ee/views/SettingsLogStreamingView.vue` |
| `components/EventDestinationSettingsModal.vue` | `logStreaming.ee/components/EventDestinationSettingsModal.vue` |
| `@n8n/rest-api-client/src/api/eventbus.ts` | `eventbus.ee.ts` in that folder |
| `components/EventDestinationCard.vue`, `components/EventSelection.vue` | (new files) |
| `logStreaming.store.ts`, `logStreaming.descriptions.ts`, `logStreaming.utils.ts` | (new files) |

The fork knows only the names of the enterprise files, from the ordinary code that imported them.
Three ordinary files use the page again, with the lines of upstream and the fork paths:

- `app/router.ts`: the route `/settings/log-streaming` (`VIEWS.LOG_STREAMING_SETTINGS`), for users
  with the global scope `logStreaming:manage`.
- `app/composables/useSettingsItems.ts`: the item **Log streaming** of the settings menu.
- `app/components/Modals.vue`: the modal `LOG_STREAM_MODAL_KEY` with the props `destination`,
  `isNew` and `eventBus`.

## Behaviour

### The page

- While the module `log-streaming` is off, the page shows the box `action-box-unlicensed`. It
  tells how to turn the module on with `N8N_DISABLED_MODULES`. The module also needs the licence
  value `feat:logStreaming`. The fork switch (step 5 of FORK.md) gives it by default, so the fork
  needs no licence.
- Without destinations, the page shows the box `action-box-licensed` with the button **Add new
  destination**.
- Each destination has a card (`destination-card`) with its name and type, a switch
  (`workflow-activate-switch`) that turns it on or off, and a menu with **Open** and **Delete**.
  A click on the card opens the destination.
- While the environment manages the destinations (`N8N_LOG_STREAMING_MANAGED_BY_ENV`), the page
  shows a callout, and the page and the modal are read-only. The test event still works.

### The modal

- A new destination starts with the type: **Webhook**, **Sentry** or **Syslog**
  (`select-destination-type`), then **Continue** (`select-destination-button`). The destination
  gets the defaults of its type from `n8n-workflow`, and is off.
- The header has the name (`subtitle-showing-type`, an inline edit) and the type, and these
  buttons:
  - **Delete** (`destination-delete-button`) for a stored destination. It asks first.
  - **Send test event** (`destination-test-button`) for a stored destination without unsaved
    changes. After the test, its title tells the result: "Event sent and returned OK", or "The
    destination didn't accept the test event".
  - **Save** (`destination-save-button`) only while there are unsaved changes.
- The tab **Settings** uses the parameter inputs of the node view (`ParameterInputList`), with the
  fields of `logStreaming.descriptions.ts`. Thus each field has the test id
  `parameter-input-<name>`. A webhook destination with a generic credential type also has a select
  of the credentials of that type.
- The tab **Events** lists the event groups: the first two parts of the event names, for example
  `n8n.audit`. A group checkbox subscribes the destination to the whole group. The single events
  of a group open with a toggle. The audit group also has the checkbox **Anonymize sensitive
  data**.
- **Save** sends all values of the form. The backend changes the fields of the request, and keeps
  the other fields.

### The REST client

Each export sends one request with `makeRestApiRequest` and gives the `data` of the response.

| Export | Request |
| --- | --- |
| `getEventDestinations(context)` | `GET /eventbus/destination` |
| `saveEventDestination(context, destination)` | `POST /eventbus/destination` with the destination |
| `deleteEventDestination(context, id)` | `DELETE /eventbus/destination?id=` |
| `sendTestEventToDestination(context, id)` | `GET /eventbus/testmessage?id=` |
| `getEventNames(context)` | `GET /eventbus/eventnames` |

## Sources

- The ordinary Playwright page object `SettingsLogStreamingPage.ts` and the specs in
  `packages/quality/testing/playwright/tests/e2e/settings/log-streaming`: the test ids, the flow of
  the modal, and the title of the test button.
- The ordinary texts `settings.log-streaming.*` in `@n8n/i18n`.
- The ordinary lines of upstream in the router, the settings menu and `Modals.vue`.
- The ordinary HTTP Request node (`HttpRequest/V3/Description.ts`) for the fields of a webhook,
  and the public API OpenAPI files of log streaming for the syslog facilities.

## Differences from upstream

- The upstream end-to-end test "should show the unlicensed view when the feature is disabled" does
  not apply. The page follows the module, and the module reads its licence value only when n8n
  starts. Thus a change of the licence at run time does not turn the page off. Also, the box of the
  fork has no button.
- The method select has `GET`, `POST` and `PUT`, as the page object tells. The REST API also
  takes other methods.
- The credential select offers the generic types that the backend supports.

## Tests

`__tests__/` has the tests of the helpers, the store, the page and the modal.
`@n8n/rest-api-client/src/api/__tests__/eventbus.test.ts` tests the requests of the client.
