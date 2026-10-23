# @n8n/frontend-module-ai-gateway

Fork module (not in upstream n8n). It adds the page **Settings > Gateway credits admin** for the
self-hosted AI gateway. Users with the global scope `aiAssistant:manage` ("Manage AI usage") see it:
the owner and the admins. The repository owner chose the gateway on 2026-10-15. The texts that
users see call the feature Gateway credits, as `AGENTS.md` tells. The code, the i18n keys and the
comments keep the name AI gateway.

The backend module is `packages/cli/src/modules/ai-gateway`. Its README tells how a call goes
through the gateway, how the budgets and the prices work, and the REST API that this page uses.
Users who are not admins keep the ordinary page **Settings > Gateway credits** of upstream n8n: their
balance and their calls.

## The page

- `views/SettingsAiGatewayAdminView.vue` is the page. The route is `/settings/ai-gateway`. The
  `rbac` middleware needs the scope `aiAssistant:manage`, and the `custom` middleware hides the page
  when the backend module is off. The settings sidebar shows the page under the same two
  conditions.
- The switch at the top turns the gateway on or off. The page asks for a confirmation before it
  turns the gateway off. The gateway is on only when it also has a credential for at least one
  provider. After a change of the switch or of the providers, the page reads the settings of the
  editor again, so the option **Use Gateway credits** of the nodes follows without a reload.
- The tabs with a form stay mounted (`v-show`), so a change of tab keeps the unsaved changes. A save
  on another tab keeps them too. When the user leaves the page with unsaved changes on the tabs
  Providers or Budgets, the page asks first. The tab Usage loads the calls when it opens.
- The tables use `N8nDataTableServer`. The page has all the rows, and gives the table one page of
  25, 50 or 100 rows (`composables/useTablePage.ts`).
- The tabs:
  - **Overview** (`components/AiGatewayOverview.vue`): the month (UTC), the monthly budget, the
    spend of the month, what is left of the budget, the balance of the top-ups, and what the calls
    can still spend. A table shows each project with a budget or a call this month.
  - **Providers** (`components/AiGatewayProviders.vue`): the credential that the gateway uses for
    each provider. The list holds the credentials of the type of the provider and of the types of
    its backends: Azure OpenAI and a Google service account (the open models of Vertex AI) for
    OpenAI, and a Google service account (Vertex AI) for Google Gemini. An Azure OpenAI credential
    takes the names of the deployments. A service account takes the project and the location of
    Vertex AI, which are empty for the defaults of the credential. Next to an OpenAI or Azure
    OpenAI credential, the section **Open models of Vertex AI** takes a second service account for
    the models of a publisher (for example `meta/llama-3.3-70b-instruct-maas`). A service account
    for Google Cloud OCR takes the processors of Document AI that the gateway serves: one project,
    location or processor on each line, and empty for all processors. The page reads a prediction
    endpoint of the Google Cloud console as the resource name of its processor. The page checks
    these fields as the backend does.
  - **Budgets** (`components/AiGatewayBudgets.vue`): the monthly budget of the instance, the
    monthly limit of each user (empty is no limit), and the monthly budgets of team projects. The
    project and the amount of each row have a label for screen readers.
  - **Top-ups** (`components/AiGatewayTopUps.vue`): add a top-up with an amount and a note, and the
    newest 100 top-ups with the admin who added each one. The page shows the amount and asks for a
    confirmation first, because the backend cannot remove a top-up.
  - **Prices** (`components/AiGatewayPrices.vue`): the list prices and the prices that an admin set,
    in dollars for one million tokens, or for one million pages or images for Google Cloud OCR
    (the provider info `priceUnit`). An admin sets a price for any model of a provider, edits a
    list price, and removes a price of an admin. For Google Cloud OCR, a hint tells how to price
    one processor of Document AI (the model `document-ai/<processor ID>`). The switch **Estimate
    the usage of calls without usage** turns the estimates of the gateway on or off (the setting
    `estimateUsage`, see "Estimates" in the README of the backend module). Before the page removes
    a price of an admin for a model without a list price, it asks for a confirmation, because the
    gateway then blocks the model. Ollama models cost nothing without a price, so their prices go
    without a question (`FREE_BY_DEFAULT_PROVIDER`).
  - **Usage** (`components/AiGatewayUsage.vue`): the calls, newest first, with filters for the
    provider, the project and the model. A call whose tokens the gateway estimated has the mark
    **Estimate** next to its cost.
- `ai-gateway-admin.store.ts` keeps the data of the page. A save sends the full settings. Only the
  newest request changes the list of calls.

## Tests

The tests check the REST client, the store, the descriptor, the helpers of the prices and the page
(`views/SettingsAiGatewayAdminView.test.ts`) with a mocked REST API. The page test also checks the
confirmations, the labels of the budget rows, the unsaved changes across tabs and the question when
the user leaves the page. The fork tests of
`useAiGatewayTopUp.test.ts` in editor-ui check the **Top up** button.

## Changes outside the module

- The four registrations of a frontend module, which `pnpm n8n-module-sdk create` made: the alias
  in `@n8n/frontend-vite-config`, and the dependency, the `paths` and the manifest entry in
  editor-ui.
- The texts `settings.forkAiGateway.*` and `aiGateway.topUp.fork.member` in
  `packages/frontend/@n8n/i18n/src/locales/en.json`.
- `packages/frontend/editor-ui/src/app/composables/useAiGatewayTopUp.ts`: when the module settings
  of `ai-gateway` have `selfHosted: true` and the instance is not n8n Cloud, **Top up** opens this
  page for a user with the scope `aiAssistant:manage`, and tells other users to ask an admin.
- The module settings `'ai-gateway'` (`selfHosted`) in `FrontendModuleSettings` of
  `@n8n/api-types`. The backend module gives them.
- The request and response types of `/rest/ai-gateway/*` and the patterns of the backend options
  (`packages/@n8n/api-types/src/dto/ai-gateway/ai-gateway-admin.dto.ts`). The page checks a field
  with the same pattern as the backend.

## Commands

Frontend feature module. Consumed from source by the editor-ui shell through
`src/app/modules.manifest.ts`; there is no build step and no `dist`.

Read the full guide at `packages/@n8n/module-cli/frontend-module-guide.md`. It gives the
descriptor contract, the registration points and the known problems.

```bash
pnpm turbo typecheck --filter=@n8n/frontend-module-ai-gateway
pnpm turbo lint --filter=@n8n/frontend-module-ai-gateway
pnpm turbo lint:styles --filter=@n8n/frontend-module-ai-gateway
pnpm turbo test --filter=@n8n/frontend-module-ai-gateway
```

`src/__tests__/design-system-icons.test.ts` renders one icon of each kind, so a plugin dropped from
`vite.config.ts` fails the tests of this package. Keep that test while the module renders a
design-system component.
