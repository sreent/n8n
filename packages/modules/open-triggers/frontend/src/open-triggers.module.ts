import { defineFrontendModule } from '@n8n/frontend-module-sdk';
import { useI18n } from '@n8n/i18n';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useSettingsStore } from '@n8n/stores/settings.store';

import {
	OPEN_TRIGGER_FIXES_MODAL_KEY,
	OPEN_TRIGGERS_MODULE_ID,
	OPEN_TRIGGERS_SCOPE,
	OPEN_TRIGGERS_SETTINGS_VIEW,
} from './open-triggers.constants';

// typescript-eslint reads an SFC import as `any`, because only vue-tsc can type one.
// `pnpm turbo typecheck` is what checks this component for real.
// eslint-disable-next-line @typescript-eslint/no-unsafe-return
const SettingsOpenTriggersView = async () => await import('./views/SettingsOpenTriggersView.vue');

/**
 * Fork module (not in upstream n8n). The modal gives the one-click fixes and the request of an
 * approval when the publish check of the backend module `open-triggers` stops a publish. The page
 * Settings > Open triggers lists the open triggers of the published workflows, for users with the
 * global scope `workflow:list`: the owner and the admins.
 */
export const OpenTriggersModule = defineFrontendModule({
	// Must match the backend module id: both gate off `/rest/module-settings`.
	id: OPEN_TRIGGERS_MODULE_ID,
	name: 'Open triggers',
	description: 'Find and fix the triggers that accept calls without authentication',
	icon: 'lock',
	modals: [
		{
			key: OPEN_TRIGGER_FIXES_MODAL_KEY,
			component: async () => await import('./components/OpenTriggerFixesModal.vue'),
			initialState: {
				open: false,
				data: { workflowId: '', items: [], otherMessages: [], canRequestApproval: false },
			},
		},
	],
	routes: [
		{
			path: 'open-triggers',
			name: OPEN_TRIGGERS_SETTINGS_VIEW,
			component: SettingsOpenTriggersView,
			meta: {
				layout: 'settings',
				middleware: ['authenticated', 'rbac', 'custom'],
				middlewareOptions: {
					rbac: { scope: OPEN_TRIGGERS_SCOPE },
				},
				telemetry: {
					pageCategory: 'settings',
				},
			},
		},
	],
	settingsPages: [
		{
			id: 'settings-open-triggers',
			icon: 'lock',
			get label() {
				return useI18n().baseText('openTriggers.settings.title');
			},
			position: 'top',
			route: { to: { name: OPEN_TRIGGERS_SETTINGS_VIEW } },
			get available() {
				return (
					useSettingsStore().isModuleActive(OPEN_TRIGGERS_MODULE_ID) &&
					useRBACStore().hasScope(OPEN_TRIGGERS_SCOPE)
				);
			},
		},
	],
});
