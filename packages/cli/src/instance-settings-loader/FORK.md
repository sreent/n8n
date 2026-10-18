# Fork changes to the instance settings loaders

The instance settings loaders are ordinary upstream code. At each start they set parts of the
configuration of n8n from environment variables, for example the security policy when
`N8N_SECURITY_POLICY_MANAGED_BY_ENV=true`. The page Settings > Security & policies is then
read-only.

The upstream loader of the security policy sets two-factor enforcement and the two rules of the
personal spaces. It does not set workflow reviews and the redaction floor, which are on the same
page. Without a fork change, an instance that manages its security policy with environment
variables could not change these two settings at all.

## What the fork adds

`loaders/fork-security-policy.instance-settings-loader.ts` (fork file) runs after the upstream loader
of the security policy, and only when `N8N_SECURITY_POLICY_MANAGED_BY_ENV=true`:

| Variable | Default | Setting |
|---|---|---|
| `N8N_WORKFLOW_REVIEWS_ENABLED` | `false` | Workflow reviews (`security.workflowReviews`) |
| `N8N_REDACTION_ENFORCEMENT_FLOOR` | `off` | The redaction floor (`redaction.enforcement`): `off`, `production` or `all`. Another value logs a warning and gives `off`. |

The defaults are the defaults of the page, so an instance that turns on the environment management
without these variables gets the upstream behaviour. `deploy/` sets workflow reviews on.

The loader does not emit the event `instance-policies-updated`, as the upstream loader.

## Upstream files

- `instance-settings-loader.service.ts`: the fork loader in the constructor and one line in
  `init`, after the security policy.
- `__tests__/instance-settings-loader.service.test.ts`: the fork loader in the test of the order.

When an upstream update changes these files, keep the fork lines. When upstream adds environment
variables for workflow reviews or the redaction floor, use them, and remove the fork loader.
