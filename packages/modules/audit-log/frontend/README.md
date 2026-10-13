# @n8n/frontend-module-audit-log

Fork module (not in upstream n8n). It adds the **Settings > Audit log** page. Users with the
global scope `auditLogs:manage` read the audit events of the instance, filter them, open the
details of an event, and export the events as CSV or JSON. The owner and admins have the scope, and
a custom role can have it.

The backend module is `packages/cli/src/modules/audit-log`. Its README tells how the backend
stores the events, how long it keeps them, and the REST API. The page has no licence check: the
owner chose on 2026-10-11 that the audit log is on by default.

## The page

- `views/SettingsAuditLogView.vue` is the page. The route is `/settings/audit-log`. The `rbac`
  middleware needs the scope `auditLogs:manage`, and the `custom` middleware hides the page when
  the backend module is off. The settings sidebar shows the page under the same two conditions.
- The description tells how long the audit log keeps an event. The value comes from the module
  settings (`retentionDays`).
- The table shows one page of the events, newest first: the time in the locale of the browser,
  the event name, the user (the e-mail address, else the user id), and the type of the project of
  the event: **Personal space** or **Team project**. The tooltip of the project shows its id. The page sizes are 25, 50,
  100 and 250 events. A click on a row, or on its eye button, opens the details of the event
  (`components/AuditLogEventDetails.vue`) with the payload as JSON.
- The filters:
  - **Event**: an event name, or a group of events, for example `n8n.audit.user.*`. The names come
    from `GET /rest/audit-log/event-names`. Each group of two or more events gets a group option.
  - **User**: only for users who may list the users (`user:list`). The select searches the users
    of the instance.
  - **Project**: **Personal spaces** or **Team projects** (`projectType`). **Personal spaces**
    shows what users did in their personal spaces.
  - **Date**: a range of whole days in the local time zone. Both days are included.
  - A change to a filter goes back to the first page. "Clear filters" removes all filters.
- **Export**: CSV or JSON, with the filters of the page. A download link cannot send the
  `browser-id` header that the REST API needs, so the page reads the file with `fetch`. Then it
  saves the file under the name that the backend gives.
- `audit-log.store.ts` keeps the filters, the page and the list. The filters stay when the user
  leaves the page. Only the newest request changes the list, so an older response that comes late
  does not replace it.

## Changes outside the module

- The four registrations of a frontend module, which `pnpm n8n-module-sdk create` made: the alias
  in `@n8n/frontend-vite-config`, and the dependency, the `paths` and the manifest entry in
  editor-ui.
- The texts `settings.auditLog.*` in `packages/frontend/@n8n/i18n/src/locales/en.json`.
- The module settings `'audit-log'` in `FrontendModuleSettings` of `@n8n/api-types`.

## Commands

Frontend feature module. Consumed from source by the editor-ui shell through
`src/app/modules.manifest.ts`; there is no build step and no `dist`.

Read the full guide at `packages/@n8n/module-cli/frontend-module-guide.md`. It gives the
descriptor contract, the registration points and the known problems. This README gives a
summary only.

```bash
pnpm turbo typecheck --filter=@n8n/frontend-module-audit-log
pnpm turbo lint --filter=@n8n/frontend-module-audit-log
pnpm turbo lint:styles --filter=@n8n/frontend-module-audit-log
pnpm turbo test --filter=@n8n/frontend-module-audit-log
```

Go through turbo, not `pnpm --filter <pkg> typecheck`: this package is consumed
from source, and on a cold tree its platform dependencies have not been built
yet. Turbo builds them first; the bare pnpm form does not.

## Import rules

- Depend on foundation and platform packages only (`@n8n/design-system`,
  `@n8n/stores`, `@n8n/composables`, `@n8n/i18n`, `@n8n/rest-api-client`,
  `@n8n/api-types`, `@n8n/permissions`, `n8n-workflow`,
  `@n8n/frontend-module-sdk`). Never import another
  `@n8n/frontend-module-*`, and never import `@/…` from the shell.
- `@n8n/stores` and `@n8n/composables` are **subpath-only** — import
  `@n8n/stores/settings.store`, not `@n8n/stores`.
- The no-cross-module rule is currently a convention: the shared tsconfig base
  omits sibling modules from `paths`, which blocks an accidental import but not
  a deliberate one (declaring the dependency makes it typecheck clean). The
  ESLint rule that actually enforces it is CAT-3692.

## Adding UI

`vite.config.ts` already carries the three plugins a design-system consumer
needs, so a `.vue` file compiles in tests without further setup:

- `@vitejs/plugin-vue` — single-file components.
- `unplugin-icons` — the `~icons/lucide/*` virtual modules behind `N8nIcon`.
- `vite-svg-loader` — design-system's `custom/*.svg` icon components. Without
  it an `.svg` import is a data-URI string, which Vue renders as a tag name.

`src/__tests__/design-system-icons.test.ts` renders one icon of each kind, so a
plugin dropped from `vite.config.ts` fails this package's own suite. Keep that
test while the module renders any design-system component.

SCSS goes in a scoped `<style lang="scss">` block, with tokens from
design-system — `stylelint.config.mjs` holds this package to the same rules the
shell uses. Route components must load lazily — see the note in
`src/audit-log.module.ts`.
