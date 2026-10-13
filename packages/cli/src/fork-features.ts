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
};
