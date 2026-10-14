/**
 * Side-effect imports for all `@PublicApiController` classes so their
 * decorator metadata is registered before PublicApiControllerRegistry /
 * scope-parity / discover run.
 */
// Fork: the list of API keys in the public API (packages/cli/src/governance/README.md).
import './api-keys.public.controller';
import './audit.public.controller';
// Fork: the audit log in the public API (packages/cli/src/modules/audit-log/README.md).
import './audit-log.public.controller';
import './community-packages.public.controller';
import './credential-type-policies.public.controller';
import './credentials.public.controller';
import './data-tables.public.controller';
import './discover.public.controller';
import './evaluations.public.controller';
import './executions.public.controller';
import './folders.public.controller';
import './insights.public.controller';
// Fork: the insights of each workflow in the public API.
import './insights-by-workflow.public.controller';
// Fork: the inventory of workflows in the public API (packages/cli/src/governance/README.md).
import './inventory.public.controller';
import './node-type-policies.public.controller';
import './otel.public.controller';
import './projects.public.controller';
import './promotions.public.controller';
import './role-mapping-rules.public.controller';
import './roles.public.controller';
import './security-policy.public.controller';
import './sso-oidc.public.controller';
import './source-control.public.controller';
import './sso-saml.public.controller';
import './tags.public.controller';
import './users.public.controller';
import './variables.public.controller';
import './workflows.public.controller';
