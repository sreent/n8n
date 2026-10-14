# The fork's source control stand-ins

Fork document (not in upstream n8n). Read it with [FORK.md](../../../../../../../FORK.md).

The fork removed the source control backend (Settings > Environments) in step 1, and rebuilt it
on 2026-10-14 (see `packages/cli/src/modules/source-control/README.md`). The editor of source
control is the next part of the rebuild. Until then, Git sync is the editor feature for Git: see
`packages/modules/git-sync/frontend/README.md`. This folder replaces the enterprise editor folder
`sourceControl.ee`. It keeps only what ordinary code uses, with the same store ID, exports, texts,
REST calls and test IDs.

## Files

| File | What it gives ordinary code |
| --- | --- |
| `sourceControl.store.ts` | The store `sourceControl`: `preferences` (the read-only branch, the branch name and colour), `isEnterpriseSourceControlEnabled`, `setPreferences`, `getPreferences`, `getRemoteWorkflow` and `pullWorkfolder`. |
| `sourceControl.api.ts` | The three requests of the store. |
| `sourceControl.types.ts` | `SourceControlPreferences` and the types of the requests. |
| `sourceControl.constants.ts` | The three modal keys. The modal state and the workflow diff routing still name them. |
| `sourceControl.eventBus.ts` | The event bus that pages listen to for the end of a pull. |
| `views/SettingsSourceControl.vue` | The page Settings > Environments. |
| `components/SourceControlInitializationErrorMessage.vue` | The message of the start-up toast. |

## Behaviour

- **The store.** The first preferences are a disconnected, writable branch with the colour
  `#5296D6`. `setPreferences` merges the given fields. `getPreferences` asks
  `GET /source-control/preferences` and merges the answer. `getRemoteWorkflow` asks
  `GET /source-control/remote-content/workflow/:id`. `pullWorkfolder(force, autoPublish)` sends
  `POST /source-control/pull-workfolder`. The fork has no such routes, so these requests fail.
  `isEnterpriseSourceControlEnabled` follows the licence feature `feat:sourceControl`, and is
  `undefined` when the settings have no enterprise part.
- **The settings page** shows the title "Environments" and the box of an instance without the
  licence feature: "Available on the Enterprise plan", the description with the link "More info"
  to the documentation, and the button "See plans". The button sends `User clicked upgrade CTA`
  and opens the pricing page, as in the original.
- **The start-up toast.** With the licence feature, the editor asks for the preferences at start-up,
  and a failure shows a toast with this message. The link "Git configuration" opens nothing, as in
  the original.

## Differences from the original

1. **No source control UI.** The original had the connection form of the settings page, the push,
   pull and pull result modals, and their composables and helpers. The fork deleted them with the
   backend, and `Modals.vue` no longer registers the three modals. The rebuild of the editor brings
   them back. With the licence
   feature, the settings page shows the same box as without it.
2. **Fewer store members.** The store has 6 of the 13 members of the original. Ordinary code uses no
   other one.

## Changes to ordinary files

- The import paths of the ordinary callers and of their tests, from
  `@/features/integrations/sourceControl.ee/` to `@/features/integrations/sourceControl/` (67
  files).
- `Modals.vue`: the three source control modals and their imports are removed.

## Sources

- The ordinary users of the folder (the stores of workflows, credentials, folders and data tables,
  the main sidebar, the workflow diff, the start-up code, the modals, the router) and their tests.
- The texts in `@n8n/i18n` (`settings.sourceControl.*`) and the DTOs of `@n8n/api-types`.
- The behaviour of the original files, recorded black-box: the exports, the constants and the store
  members at run time, the rendered text, test IDs, controls and element tree, the requests, the
  telemetry and the opened windows. The enterprise files were not read.

## Tests

`__tests__/golden/source-control.golden.test.ts` records the store (the licence flag, the
preferences, the requests and their errors), the modal keys, the event bus, the settings page
without the licence feature and its button, and the start-up message and its link. It uses the
harness of the evaluation editor (`features/ai/evaluation/__tests__/golden/harness.ts`). The
snapshot was recorded against the enterprise files, twice with the same result, and the fork files
give the same snapshot.

The fork no longer has the enterprise files. To record the snapshot again after an upstream update,
use a checkout of the upstream commit in `scripts/sync-upstream.base`: copy this test folder and
the harness there, point the exports of `subject.ts` at `@/features/integrations/sourceControl.ee/`,
and run the test with `--update=all`.

## Clean-room record

- I did not open an enterprise file of this folder. I deleted the folder by its name, and restored
  it once from Git by its name to record one more action of the store. Searches that left out the
  enterprise files found the ordinary importers.
