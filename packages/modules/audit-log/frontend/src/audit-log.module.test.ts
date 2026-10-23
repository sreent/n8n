import type { Scope } from '@n8n/permissions';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { createPinia, setActivePinia } from 'pinia';

import { AUDIT_LOG_SETTINGS_VIEW } from './audit-log.constants';
import { AuditLogModule } from './audit-log.module';

describe('AuditLogModule', () => {
	const settingsPage = () =>
		AuditLogModule.settingsPages?.find(({ id }) => id === 'settings-audit-log');

	const grant = (scopes: Scope[]) => useRBACStore().setGlobalScopes(scopes);

	beforeEach(() => {
		setActivePinia(createPinia());
	});

	it('has the same id as the backend module', () => {
		expect(AuditLogModule.id).toBe('audit-log');
	});

	it('limits the settings route to users with the scope of the audit log', () => {
		const route = AuditLogModule.routes?.find(({ name }) => name === AUDIT_LOG_SETTINGS_VIEW);

		expect(route?.path).toBe('audit-log');
		expect(route?.meta).toMatchObject({
			layout: 'settings',
			middleware: ['authenticated', 'rbac', 'custom'],
			middlewareOptions: { rbac: { scope: 'auditLogs:manage' } },
			telemetry: { pageCategory: 'settings' },
		});
	});

	it('shows the sidebar item to a user with the scope', () => {
		grant(['auditLogs:manage']);

		expect(settingsPage()).toMatchObject({
			label: 'Audit log',
			route: { to: { name: AUDIT_LOG_SETTINGS_VIEW } },
			available: true,
		});
	});

	it('hides the sidebar item from a user without the scope', () => {
		grant(['user:list']);

		expect(settingsPage()?.available).toBe(false);
	});
});
