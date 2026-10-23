import type { Scope } from '@n8n/permissions';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { createPinia, setActivePinia } from 'pinia';

import { AI_GATEWAY_ADMIN_VIEW } from './ai-gateway.constants';
import { AiGatewayModule } from './ai-gateway.module';

describe('AiGatewayModule', () => {
	const settingsPage = () =>
		AiGatewayModule.settingsPages?.find(({ id }) => id === 'settings-fork-ai-gateway');

	const grant = (scopes: Scope[]) => useRBACStore().setGlobalScopes(scopes);

	beforeEach(() => {
		setActivePinia(createPinia());
	});

	it('has the same id as the backend module', () => {
		expect(AiGatewayModule.id).toBe('ai-gateway');
	});

	it('limits the settings route to users with the scope aiAssistant:manage', () => {
		const route = AiGatewayModule.routes?.find(({ name }) => name === AI_GATEWAY_ADMIN_VIEW);

		expect(route?.path).toBe('ai-gateway');
		expect(route?.meta).toMatchObject({
			layout: 'settings',
			middleware: ['authenticated', 'rbac', 'custom'],
			middlewareOptions: { rbac: { scope: 'aiAssistant:manage' } },
		});
	});

	it('shows the sidebar item to a user with the scope', () => {
		grant(['aiAssistant:manage']);

		expect(settingsPage()).toMatchObject({
			label: 'Gateway credits admin',
			route: { to: { name: AI_GATEWAY_ADMIN_VIEW } },
			available: true,
		});
	});

	it('hides the sidebar item from a user without the scope', () => {
		grant(['user:list']);

		expect(settingsPage()?.available).toBe(false);
	});
});
