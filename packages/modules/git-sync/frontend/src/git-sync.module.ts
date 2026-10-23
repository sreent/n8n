import { ROLE } from '@n8n/api-types';
import { defineFrontendModule } from '@n8n/frontend-module-sdk';
import { useI18n } from '@n8n/i18n';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useUsersStore } from '@n8n/stores/users.store';

import { GIT_SYNC_MODULE_ID, GIT_SYNC_SETTINGS_VIEW } from './git-sync.constants';

// typescript-eslint reads an SFC import as `any`, because only vue-tsc can type one.
// `pnpm turbo typecheck` is what checks this component for real.
// eslint-disable-next-line @typescript-eslint/no-unsafe-return
const SettingsGitSyncView = async () => await import('./SettingsGitSyncView.vue');

/**
 * Fork module (not in upstream n8n). The settings page connects one project to a
 * branch of a Git repository. Only the instance owner and admins see it.
 */
export const GitSyncModule = defineFrontendModule({
	// Must match the backend module id: both gate off `/rest/module-settings`.
	id: GIT_SYNC_MODULE_ID,
	name: 'Git sync',
	description:
		'Sync the workflows of one project with a Git branch (Environments syncs the whole instance)',
	// Environments and Environments v2 use `git-branch`. A different icon keeps the items apart.
	icon: 'arrow-left-right',
	routes: [
		{
			path: 'git-sync',
			name: GIT_SYNC_SETTINGS_VIEW,
			component: SettingsGitSyncView,
			meta: {
				layout: 'settings',
				middleware: ['authenticated', 'role', 'custom'],
				middlewareOptions: {
					role: [ROLE.Owner, ROLE.Admin],
				},
				telemetry: {
					pageCategory: 'settings',
				},
			},
		},
	],
	settingsPages: [
		{
			id: 'settings-git-sync',
			icon: 'arrow-left-right',
			get label() {
				return useI18n().baseText('settings.gitSync');
			},
			position: 'top',
			route: { to: { name: GIT_SYNC_SETTINGS_VIEW } },
			get available() {
				return (
					useSettingsStore().isModuleActive(GIT_SYNC_MODULE_ID) && useUsersStore().isAdminOrOwner
				);
			},
		},
	],
});
