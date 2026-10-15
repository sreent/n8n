import { defineFrontendModule } from '@n8n/frontend-module-sdk';
import { useI18n } from '@n8n/i18n';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useSettingsStore } from '@n8n/stores/settings.store';

import {
	AI_GATEWAY_ADMIN_VIEW,
	AI_GATEWAY_MODULE_ID,
	AI_GATEWAY_SCOPE,
} from './ai-gateway.constants';

// typescript-eslint reads an SFC import as `any`, because only vue-tsc can type one.
// `pnpm turbo typecheck` is what checks this component for real.
// eslint-disable-next-line @typescript-eslint/no-unsafe-return
const SettingsAiGatewayAdminView = async () =>
	await import('./views/SettingsAiGatewayAdminView.vue');

/**
 * Fork module (not in upstream n8n). The settings page of the self-hosted AI gateway: the
 * credential of each provider, the budgets, the top-ups, the prices and the calls. Users with the
 * global scope `aiAssistant:manage` see it: the owner and the admins. The backend module is
 * `packages/cli/src/modules/ai-gateway`.
 */
export const AiGatewayModule = defineFrontendModule({
	// Must match the backend module id: both gate off `/rest/module-settings`.
	id: AI_GATEWAY_MODULE_ID,
	name: 'AI gateway',
	description: 'Run AI nodes with Gateway credits through the self-hosted AI gateway',
	icon: 'hand-coins',
	routes: [
		{
			path: 'ai-gateway',
			name: AI_GATEWAY_ADMIN_VIEW,
			component: SettingsAiGatewayAdminView,
			meta: {
				layout: 'settings',
				middleware: ['authenticated', 'rbac', 'custom'],
				middlewareOptions: {
					rbac: { scope: AI_GATEWAY_SCOPE },
				},
				telemetry: {
					pageCategory: 'settings',
				},
			},
		},
	],
	settingsPages: [
		{
			id: 'settings-fork-ai-gateway',
			icon: 'hand-coins',
			get label() {
				return useI18n().baseText('settings.forkAiGateway');
			},
			position: 'top',
			route: { to: { name: AI_GATEWAY_ADMIN_VIEW } },
			get available() {
				return (
					useSettingsStore().isModuleActive(AI_GATEWAY_MODULE_ID) &&
					useRBACStore().hasScope(AI_GATEWAY_SCOPE)
				);
			},
		},
	],
});
