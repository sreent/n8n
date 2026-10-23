import { defineFrontendModule } from '@n8n/frontend-module-sdk';
import { useI18n } from '@n8n/i18n';
import { useRBACStore } from '@n8n/stores/rbac.store';

import {
	AUDIT_LOG_MODULE_ID,
	AUDIT_LOG_SCOPE,
	AUDIT_LOG_SETTINGS_VIEW,
} from './audit-log.constants';

// typescript-eslint reads an SFC import as `any`, because only vue-tsc can type one.
// `pnpm turbo typecheck` is what checks this component for real.
// eslint-disable-next-line @typescript-eslint/no-unsafe-return
const SettingsAuditLogView = async () => await import('./views/SettingsAuditLogView.vue');

/**
 * Fork module (not in upstream n8n). The settings page lists, filters and exports the audit
 * events that the backend module `audit-log` stores. Users with the global scope
 * `auditLogs:manage` see it: the owner, admins, and custom roles with the scope.
 */
export const AuditLogModule = defineFrontendModule({
	// Must match the backend module id: both gate off `/rest/module-settings`.
	id: AUDIT_LOG_MODULE_ID,
	name: 'Audit log',
	description: 'Read, filter and export the audit events of the instance',
	icon: 'scroll-text',
	routes: [
		{
			path: 'audit-log',
			name: AUDIT_LOG_SETTINGS_VIEW,
			component: SettingsAuditLogView,
			meta: {
				layout: 'settings',
				middleware: ['authenticated', 'rbac', 'custom'],
				middlewareOptions: {
					rbac: { scope: AUDIT_LOG_SCOPE },
				},
				telemetry: {
					pageCategory: 'settings',
				},
			},
		},
	],
	settingsPages: [
		{
			id: 'settings-audit-log',
			icon: 'scroll-text',
			get label() {
				return useI18n().baseText('settings.auditLog');
			},
			position: 'top',
			route: { to: { name: AUDIT_LOG_SETTINGS_VIEW } },
			// The shell lists the item only while the module is active, as for the core modules.
			get available() {
				return useRBACStore().hasScope(AUDIT_LOG_SCOPE);
			},
		},
	],
});
