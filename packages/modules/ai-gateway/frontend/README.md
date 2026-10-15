# @n8n/frontend-module-ai-gateway

Fork module (not in upstream n8n). It adds the page **Settings > AI gateway** for the self-hosted
AI gateway. Users with the global scope `aiAssistant:manage` ("Manage AI usage") see it: the owner
and the admins. The repository owner chose the gateway on 2026-10-15.

The backend module is `packages/cli/src/modules/ai-gateway`. Its README tells how a call goes
through the gateway, how the budgets and the prices work, and the REST API that this page uses.
Users who are not admins keep the ordinary page **Settings > Gateway credits** of upstream n8n: their
balance and their calls.

## The page

- `views/SettingsAiGatewayAdminView.vue` is the page. The route is `/settings/ai-gateway`. The
  `rbac` middleware needs the scope `aiAssistant:manage`, and the `custom` middleware hides the page
  when the backend module is off. The settings sidebar shows the page under the same two
  conditions.
- The switch at the top turns the gateway on or off. The gateway is on only when it also has a
  credential for at least one provider. After a change of the switch or of the providers, the page
  reads the settings of the editor again, so the option **Use Gateway credits** of the nodes follows
  without a reload.
- The tabs:
  - **Overview** (`components/AiGatewayOverview.vue`): the month (UTC), the monthly budget, the
    spend of the month, what is left of the budget, the balance of the top-ups, and what the calls
    can still spend. A table shows each project with a budget or a call this month.
  - **Providers** (`components/AiGatewayProviders.vue`): the credential that the gateway uses for
    each provider. The list holds the credentials of the type of the provider.
  - **Budgets** (`components/AiGatewayBudgets.vue`): the monthly budget of the instance, the
    monthly limit of each user (empty is no limit), and the monthly budgets of team projects.
  - **Top-ups** (`components/AiGatewayTopUps.vue`): add a top-up with an amount and a note, and the
    newest 100 top-ups with the admin who added each one.
  - **Prices** (`components/AiGatewayPrices.vue`): the list prices and the prices that an admin set,
    in dollars for one million tokens. An admin sets a price for any model of a provider, edits a
    list price, and removes a price of an admin.
  - **Usage** (`components/AiGatewayUsage.vue`): the calls, newest first, with filters for the
    provider, the project and the model.
- `ai-gateway-admin.store.ts` keeps the data of the page. A save sends the full settings. Only the
  newest request changes the list of calls.

## Tests

The tests check the REST client, the store, the descriptor, the helpers of the prices and the page
(`views/SettingsAiGatewayAdminView.test.ts`) with a mocked REST API. The fork tests of
`useAiGatewayTopUp.test.ts` in editor-ui check the **Top up** button.

## Changes outside the module

- The four registrations of a frontend module, which `pnpm n8n-module-sdk create` made: the alias
  in `@n8n/frontend-vite-config`, and the dependency, the `paths` and the manifest entry in
  editor-ui.
- The texts `settings.forkAiGateway.*` and `aiGateway.topUp.fork.member` in
  `packages/frontend/@n8n/i18n/src/locales/en.json`.
- `packages/frontend/editor-ui/src/app/composables/useAiGatewayTopUp.ts`: on an instance that is not
  n8n Cloud, **Top up** opens this page for a user with the scope `aiAssistant:manage`, and tells
  other users to ask an admin.

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
