# @n8n/frontend-module-send-copy

Fork module (not in upstream n8n). It adds **Send a copy** to the workflow menu in the
editor and to the workflow cards. A user picks colleagues, and each colleague gets an
independent copy of the workflow in their personal space. This is not live sharing.

- `SendCopyModal.vue` is registered in the shell modal registry (`modals` surface).
- The shell opens it through `useSendCopyAction()`, and provides `sendCopyModalCloser`
  in `editor-ui/src/app/capabilities.manifest.ts`, so the modal can close itself. The
  action shows only when the backend module is active and the user has the global scope
  `user:list`, which the search for colleagues needs.
- The backend module is `packages/cli/src/modules/send-copy`. It decides what the copy
  keeps: no credentials, pinned data, static data, or settings that point to resources
  of the sender. The values typed into node parameters stay in the copy, and the callout
  of the modal tells the user so.
- The search for colleagues waits `DEBOUNCE_TIME.INPUT.SEARCH` of
  `@n8n/frontend-constants/durations`, as the searches of the shell do.
- `send-copy.api.ts` calls `/rest/send-copy/*`. The request and response types and the limit of
  recipients come from `@n8n/api-types` (`dto/send-copy/send-copy.dto.ts`), which the backend
  module uses too.

Frontend feature module. Consumed from source by the editor-ui shell through
`src/app/modules.manifest.ts`; there is no build step and no `dist`.

Read the full guide at `packages/@n8n/module-cli/frontend-module-guide.md`. It gives the
descriptor contract, the registration points and the known problems. This README gives a
summary only.

```bash
pnpm turbo typecheck --filter=@n8n/frontend-module-send-copy
pnpm turbo lint --filter=@n8n/frontend-module-send-copy
pnpm turbo lint:styles --filter=@n8n/frontend-module-send-copy
pnpm turbo test --filter=@n8n/frontend-module-send-copy
```

Go through turbo, not `pnpm --filter <pkg> typecheck`: this package is consumed
from source, and on a cold tree its platform dependencies have not been built
yet. Turbo builds them first; the bare pnpm form does not.

## Import rules

- Depend on foundation and platform packages only (`@n8n/design-system`,
  `@n8n/stores`, `@n8n/composables`, `@n8n/frontend-constants`, `@n8n/i18n`,
  `@n8n/rest-api-client`, `@n8n/api-types`, `@n8n/permissions`, `n8n-workflow`,
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
`src/send-copy.module.ts`.
