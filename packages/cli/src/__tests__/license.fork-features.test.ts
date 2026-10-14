// Fork test (not in upstream n8n): the features that fork code rebuilt are on by default, and
// `N8N_FORK_FEATURES_ENABLED=false` turns them off (step 5 of FORK.md).
import { LicenseState } from '@n8n/backend-common';
import { mockLogger } from '@n8n/backend-test-utils';
import type { GlobalConfig } from '@n8n/config';
import { LICENSE_FEATURES, LICENSE_QUOTAS, UNLIMITED_LICENSE_QUOTA } from '@n8n/constants';
import { Container } from '@n8n/di';
import { LicenseManager } from '@n8n_io/license-sdk';
import type { InstanceSettings } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import { FORK_FEATURE_VALUES, ForkFeaturesConfig } from '@/fork-features';
import { License } from '@/license';

vi.mock('@n8n_io/license-sdk');

const FORK_FEATURES = [
	LICENSE_FEATURES.SHARING,
	LICENSE_FEATURES.PROJECT_ROLE_ADMIN,
	LICENSE_FEATURES.PROJECT_ROLE_EDITOR,
	LICENSE_FEATURES.PROJECT_ROLE_VIEWER,
	LICENSE_FEATURES.ADVANCED_PERMISSIONS,
	LICENSE_FEATURES.CUSTOM_ROLES,
	LICENSE_FEATURES.SAML,
	LICENSE_FEATURES.OIDC,
	LICENSE_FEATURES.EXTERNAL_SECRETS,
	LICENSE_FEATURES.VARIABLES,
	LICENSE_FEATURES.ADVANCED_EXECUTION_FILTERS,
	LICENSE_FEATURES.API_KEY_SCOPES,
	LICENSE_FEATURES.FOLDERS,
	LICENSE_FEATURES.DEBUG_IN_EDITOR,
	LICENSE_FEATURES.INSIGHTS_VIEW_SUMMARY,
	LICENSE_FEATURES.INSIGHTS_VIEW_DASHBOARD,
	LICENSE_FEATURES.INSIGHTS_VIEW_HOURLY_DATA,
	LICENSE_FEATURES.DATA_REDACTION,
	LICENSE_FEATURES.OTEL_CUSTOM_SPAN_ATTRIBUTES,
	LICENSE_FEATURES.TYPE_AVAILABILITY_POLICIES,
	LICENSE_FEATURES.PERSONAL_SPACE_POLICY,
	LICENSE_FEATURES.MFA_ENFORCEMENT,
	LICENSE_FEATURES.WORKFLOW_DIFFS,
	LICENSE_FEATURES.NAMED_VERSIONS,
	LICENSE_FEATURES.COMMUNITY_NODES_CUSTOM_REGISTRY,
	LICENSE_FEATURES.TOKEN_EXCHANGE,
	LICENSE_FEATURES.WORKFLOW_REVIEWS,
	LICENSE_FEATURES.BINARY_DATA_S3,
	LICENSE_FEATURES.BINARY_DATA_AZURE,
	LICENSE_FEATURES.EXECUTION_DATA_S3,
	LICENSE_FEATURES.EXECUTION_DATA_AZURE,
];

const FORK_QUOTAS = [
	LICENSE_QUOTAS.TEAM_PROJECT_LIMIT,
	LICENSE_QUOTAS.WORKFLOWS_WITH_EVALUATION_LIMIT,
	LICENSE_QUOTAS.INSIGHTS_MAX_HISTORY_DAYS,
	LICENSE_QUOTAS.WORKFLOW_HISTORY_PRUNE_LIMIT,
];

describe('License with the fork features', () => {
	let license: License;
	let manager: LicenseManager;
	const config = Container.get(ForkFeaturesConfig);

	beforeEach(async () => {
		vi.mocked(LicenseManager.prototype.hasFeatureEnabled).mockReturnValue(false);
		vi.mocked(LicenseManager.prototype.getFeatureValue).mockReturnValue(undefined);
		const globalConfig = mock<GlobalConfig>({
			license: {
				serverUrl: 'https://server.com/v1',
				autoRenewalEnabled: false,
				detachFloatingOnShutdown: false,
				activationKey: '',
				tenantId: 1,
				cert: '',
			},
			multiMainSetup: { enabled: false },
		});
		const instanceSettings = mock<InstanceSettings>({
			instanceId: 'instance-id',
			instanceType: 'main',
			isLeader: true,
		});
		license = new License(mockLogger(), instanceSettings, mock(), mock(), globalConfig);
		await license.init();
		manager = vi.mocked(LicenseManager).mock.instances[0];
	});

	afterEach(() => {
		config.enabled = false;
		config.nonProductionBanner = false;
		vi.clearAllMocks();
	});

	test('the test setup turns the fork features off', () => {
		expect(process.env.N8N_FORK_FEATURES_ENABLED).toBe('false');
		expect(config.enabled).toBe(false);
	});

	/**
	 * The config that n8n makes from the environment at start. The container reads the environment
	 * when it makes the config, so this makes a new one, then puts back the config of the tests.
	 */
	function configFromEnvironment() {
		Container.reset();
		try {
			return Container.get(ForkFeaturesConfig);
		} finally {
			Container.set(ForkFeaturesConfig, config);
		}
	}

	test('the switch is on by default', () => {
		const previous = process.env.N8N_FORK_FEATURES_ENABLED;
		delete process.env.N8N_FORK_FEATURES_ENABLED;
		try {
			expect(configFromEnvironment().enabled).toBe(true);
		} finally {
			process.env.N8N_FORK_FEATURES_ENABLED = previous;
		}
	});

	test('the banner of a non-production instance is off by default, and an instance turns it on', () => {
		expect(configFromEnvironment().nonProductionBanner).toBe(false);
		process.env.N8N_FORK_NON_PRODUCTION_BANNER = 'true';
		try {
			expect(configFromEnvironment().nonProductionBanner).toBe(true);
		} finally {
			delete process.env.N8N_FORK_NON_PRODUCTION_BANNER;
		}
	});

	test('the fork turns on the features and the quotas that the owner chose', () => {
		expect(FORK_FEATURE_VALUES).toEqual({
			...Object.fromEntries(FORK_FEATURES.map((feature) => [feature, true])),
			...Object.fromEntries(FORK_QUOTAS.map((quota) => [quota, UNLIMITED_LICENSE_QUOTA])),
		});
	});

	describe('when the fork features are on', () => {
		beforeEach(() => {
			config.enabled = true;
		});

		test.each(FORK_FEATURES)('%s is licensed', (feature) => {
			expect(license.isLicensed(feature)).toBe(true);
			expect(license.getValue(feature)).toBe(true);
			expect(manager.hasFeatureEnabled).not.toHaveBeenCalled();
		});

		test('the licence state follows', () => {
			const state = new LicenseState();
			state.setLicenseProvider(license);
			expect(state.isSharingLicensed()).toBe(true);
			expect(state.isProjectRoleAdminLicensed()).toBe(true);
			expect(state.isAdvancedPermissionsLicensed()).toBe(true);
			expect(state.isCustomRolesLicensed()).toBe(true);
			expect(state.isSamlLicensed()).toBe(true);
			expect(state.isOidcLicensed()).toBe(true);
			expect(state.isExternalSecretsLicensed()).toBe(true);
			expect(state.isVariablesLicensed()).toBe(true);
			expect(state.isAdvancedExecutionFiltersLicensed()).toBe(true);
			expect(state.isApiKeyScopesLicensed()).toBe(true);
			expect(state.isFoldersLicensed()).toBe(true);
			expect(state.isDebugInEditorLicensed()).toBe(true);
			expect(state.isInsightsSummaryLicensed()).toBe(true);
			expect(state.isInsightsDashboardLicensed()).toBe(true);
			expect(state.isInsightsHourlyDataLicensed()).toBe(true);
			expect(state.isDataRedactionLicensed()).toBe(true);
			expect(state.isOtelCustomSpanAttributesLicensed()).toBe(true);
			expect(state.isLicensed(LICENSE_FEATURES.TYPE_AVAILABILITY_POLICIES)).toBe(true);
			expect(state.isPersonalSpacePolicyLicensed()).toBe(true);
			expect(state.isMFAEnforcementLicensed()).toBe(true);
			expect(state.isWorkflowDiffsLicensed()).toBe(true);
			expect(state.isLicensed(LICENSE_FEATURES.NAMED_VERSIONS)).toBe(true);
			expect(state.isCustomNpmRegistryLicensed()).toBe(true);
			expect(state.isLicensed(LICENSE_FEATURES.TOKEN_EXCHANGE)).toBe(true);
			expect(state.isWorkflowReviewsLicensed()).toBe(true);
			expect(state.isBinaryDataS3Licensed()).toBe(true);
			expect(state.isBinaryDataAzureLicensed()).toBe(true);
			expect(state.isExecutionDataS3Licensed()).toBe(true);
			expect(state.isExecutionDataAzureLicensed()).toBe(true);
			expect(state.getMaxTeamProjects()).toBe(UNLIMITED_LICENSE_QUOTA);
			expect(state.getMaxWorkflowsWithEvaluations()).toBe(UNLIMITED_LICENSE_QUOTA);
			expect(state.getInsightsMaxHistory()).toBe(UNLIMITED_LICENSE_QUOTA);
			expect(state.getWorkflowHistoryPruneQuota()).toBe(UNLIMITED_LICENSE_QUOTA);
		});

		test('the workflow history has no time limit', () => {
			// The prune of the workflow history reads this value (workflow-history-helper.ts).
			expect(license.getWorkflowHistoryPruneLimit()).toBe(UNLIMITED_LICENSE_QUOTA);
		});

		test('the banner of a non-production instance shows only when the instance turns it on', () => {
			expect(license.isLicensed(LICENSE_FEATURES.SHOW_NON_PROD_BANNER)).toBe(false);
			expect(manager.hasFeatureEnabled).toHaveBeenCalledWith(LICENSE_FEATURES.SHOW_NON_PROD_BANNER);

			config.nonProductionBanner = true;
			expect(license.isLicensed(LICENSE_FEATURES.SHOW_NON_PROD_BANNER)).toBe(true);
			// The other fork features stay on.
			expect(license.isLicensed(LICENSE_FEATURES.SHARING)).toBe(true);
		});

		test.each(FORK_QUOTAS)('%s has no limit', (quota) => {
			expect(license.getValue(quota)).toBe(UNLIMITED_LICENSE_QUOTA);
			expect(manager.getFeatureValue).not.toHaveBeenCalled();
		});

		test('the licence decides the other features and quotas', () => {
			expect(license.isLicensed(LICENSE_FEATURES.LDAP)).toBe(false);
			expect(manager.hasFeatureEnabled).toHaveBeenCalledWith(LICENSE_FEATURES.LDAP);
			vi.mocked(manager.hasFeatureEnabled).mockReturnValue(true);
			expect(license.isLicensed(LICENSE_FEATURES.LDAP)).toBe(true);

			vi.mocked(manager.getFeatureValue).mockReturnValue(5);
			expect(license.getValue(LICENSE_QUOTAS.USERS_LIMIT)).toBe(5);
			expect(license.getValue(LICENSE_QUOTAS.VARIABLES_LIMIT)).toBe(5);
		});
	});

	describe('when the fork features are off', () => {
		test.each(FORK_FEATURES)('the licence decides %s', (feature) => {
			expect(license.isLicensed(feature)).toBe(false);
			expect(manager.hasFeatureEnabled).toHaveBeenCalledWith(feature);
			vi.mocked(manager.hasFeatureEnabled).mockReturnValue(true);
			expect(license.isLicensed(feature)).toBe(true);
		});

		test('the licence decides the quotas', () => {
			const state = new LicenseState();
			state.setLicenseProvider(license);
			expect(state.getMaxTeamProjects()).toBe(0);
			expect(state.getMaxWorkflowsWithEvaluations()).toBe(0);
			expect(state.getInsightsMaxHistory()).toBe(7);
			expect(license.getWorkflowHistoryPruneLimit()).toBe(24);
			vi.mocked(manager.getFeatureValue).mockReturnValue(3);
			expect(state.getMaxTeamProjects()).toBe(3);
			expect(state.getMaxWorkflowsWithEvaluations()).toBe(3);
			expect(state.getInsightsMaxHistory()).toBe(3);
			expect(license.getWorkflowHistoryPruneLimit()).toBe(3);
		});

		test('the licence decides the banner of a non-production instance', () => {
			config.nonProductionBanner = true;
			expect(license.isLicensed(LICENSE_FEATURES.SHOW_NON_PROD_BANNER)).toBe(false);
			expect(manager.hasFeatureEnabled).toHaveBeenCalledWith(LICENSE_FEATURES.SHOW_NON_PROD_BANNER);
		});
	});
});
