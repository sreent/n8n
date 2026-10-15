// Fork code (not in upstream n8n): the features that fork code rebuilt are on by default, without a
// licence (step 5 of FORK.md). `N8N_FORK_FEATURES_ENABLED=false` turns them off. Then the licence
// decides, as in upstream n8n.
import { Config, Env } from '@n8n/config';
import { LICENSE_FEATURES, LICENSE_QUOTAS, UNLIMITED_LICENSE_QUOTA } from '@n8n/constants';

import type { FeatureReturnType } from './license';

@Config
export class ForkFeaturesConfig {
	/** Whether the features of the fork are on without a licence. */
	@Env('N8N_FORK_FEATURES_ENABLED')
	enabled: boolean = true;

	/**
	 * Whether the editor shows the banner "This n8n instance is not licensed for production
	 * purposes". Set it on development and test instances, not on production. It needs `enabled`.
	 */
	@Env('N8N_FORK_NON_PRODUCTION_BANNER')
	nonProductionBanner: boolean = false;
}

/**
 * The licence values that n8n uses while the features of the fork are on. Add a value only when the
 * owner chooses it (FORK.md, "Licence checks").
 */
export const FORK_FEATURE_VALUES: FeatureReturnType = {
	// Step 5 of FORK.md.
	[LICENSE_FEATURES.SHARING]: true,
	[LICENSE_FEATURES.PROJECT_ROLE_ADMIN]: true,
	[LICENSE_FEATURES.PROJECT_ROLE_EDITOR]: true,
	[LICENSE_FEATURES.PROJECT_ROLE_VIEWER]: true,
	[LICENSE_FEATURES.ADVANCED_PERMISSIONS]: true,
	[LICENSE_FEATURES.CUSTOM_ROLES]: true,
	[LICENSE_FEATURES.SAML]: true,
	[LICENSE_FEATURES.OIDC]: true,
	[LICENSE_FEATURES.EXTERNAL_SECRETS]: true,
	[LICENSE_QUOTAS.TEAM_PROJECT_LIMIT]: UNLIMITED_LICENSE_QUOTA,
	// The features that the fork rebuilt in step 4, and API key scopes (the owner chose these on
	// 2026-10-13).
	[LICENSE_FEATURES.VARIABLES]: true,
	[LICENSE_FEATURES.ADVANCED_EXECUTION_FILTERS]: true,
	[LICENSE_QUOTAS.WORKFLOWS_WITH_EVALUATION_LIMIT]: UNLIMITED_LICENSE_QUOTA,
	[LICENSE_FEATURES.API_KEY_SCOPES]: true,
	// Folders and debug in editor: the fork has no registration and no licence keys, so the switch
	// turns them on (the owner chose this on 2026-10-13).
	[LICENSE_FEATURES.FOLDERS]: true,
	[LICENSE_FEATURES.DEBUG_IN_EDITOR]: true,
	// Ordinary code behind a licence check: insights (no limit of history), data redaction, the
	// custom span attributes of OpenTelemetry, node type policies and the personal space policy (the
	// owner chose these on 2026-10-13). Node type policies also need
	// N8N_ENABLED_MODULES=type-availability-policies.
	[LICENSE_FEATURES.INSIGHTS_VIEW_SUMMARY]: true,
	[LICENSE_FEATURES.INSIGHTS_VIEW_DASHBOARD]: true,
	[LICENSE_FEATURES.INSIGHTS_VIEW_HOURLY_DATA]: true,
	[LICENSE_QUOTAS.INSIGHTS_MAX_HISTORY_DAYS]: UNLIMITED_LICENSE_QUOTA,
	[LICENSE_FEATURES.DATA_REDACTION]: true,
	[LICENSE_FEATURES.OTEL_CUSTOM_SPAN_ATTRIBUTES]: true,
	[LICENSE_FEATURES.TYPE_AVAILABILITY_POLICIES]: true,
	[LICENSE_FEATURES.PERSONAL_SPACE_POLICY]: true,
	// MFA enforcement, the diffs and the names of workflow versions, and the workflow history
	// without a time limit (the owner chose these on 2026-10-14). N8N_WORKFLOW_HISTORY_PRUNE_TIME
	// can still limit the history.
	[LICENSE_FEATURES.MFA_ENFORCEMENT]: true,
	[LICENSE_FEATURES.WORKFLOW_DIFFS]: true,
	[LICENSE_FEATURES.NAMED_VERSIONS]: true,
	[LICENSE_QUOTAS.WORKFLOW_HISTORY_PRUNE_LIMIT]: UNLIMITED_LICENSE_QUOTA,
	// The private registry of community nodes and token exchange (the owner chose these on
	// 2026-10-14). Token exchange also needs N8N_ENV_FEAT_TOKEN_EXCHANGE=true, because upstream n8n
	// marks it experimental, and N8N_TOKEN_EXCHANGE_ENABLED=true with trusted keys.
	[LICENSE_FEATURES.COMMUNITY_NODES_CUSTOM_REGISTRY]: true,
	[LICENSE_FEATURES.TOKEN_EXCHANGE]: true,
	// Workflow reviews: the fork module of the rebuild (the owner chose this on 2026-10-14). An
	// admin turns the reviews on at Settings > Security & policies.
	[LICENSE_FEATURES.WORKFLOW_REVIEWS]: true,
	// The S3 and Azure Blob storage of binary data and execution data: the fork classes of the
	// rebuild in @n8n/blob-storage (the owner chose this on 2026-10-14).
	[LICENSE_FEATURES.BINARY_DATA_S3]: true,
	[LICENSE_FEATURES.BINARY_DATA_AZURE]: true,
	[LICENSE_FEATURES.EXECUTION_DATA_S3]: true,
	[LICENSE_FEATURES.EXECUTION_DATA_AZURE]: true,
	// Source control with a Git branch: the fork module of the rebuild (the owner chose this on
	// 2026-10-14).
	[LICENSE_FEATURES.SOURCE_CONTROL]: true,
	// Git connections (promotions): the fork module of the rebuild (the owner chose this on
	// 2026-10-14). They also need their module: N8N_ENABLED_MODULES=promotions.
	[LICENSE_FEATURES.GIT_CONNECTIONS]: true,
};

const FORK_FEATURE_VALUES_WITH_BANNER: FeatureReturnType = {
	...FORK_FEATURE_VALUES,
	[LICENSE_FEATURES.SHOW_NON_PROD_BANNER]: true,
};

/**
 * The licence values of the fork for this instance. The banner of a non-production instance is
 * not in FORK_FEATURE_VALUES: each instance turns it on with N8N_FORK_NON_PRODUCTION_BANNER.
 */
export function forkFeatureValues(config: ForkFeaturesConfig): FeatureReturnType {
	return config.nonProductionBanner ? FORK_FEATURE_VALUES_WITH_BANNER : FORK_FEATURE_VALUES;
}
