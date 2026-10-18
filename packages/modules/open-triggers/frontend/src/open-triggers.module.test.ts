import type { Scope } from '@n8n/permissions';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { createPinia, setActivePinia } from 'pinia';

import {
	OPEN_TRIGGER_FIXES_MODAL_KEY,
	OPEN_TRIGGERS_SETTINGS_VIEW,
} from './open-triggers.constants';
import { OpenTriggersModule } from './open-triggers.module';

describe('OpenTriggersModule', () => {
	const settingsPage = () =>
		OpenTriggersModule.settingsPages?.find(({ id }) => id === 'settings-open-triggers');

	const activate = (active: boolean) => {
		useSettingsStore().$patch({ settings: { activeModules: active ? ['open-triggers'] : [] } });
	};

	const grant = (scopes: Scope[]) => useRBACStore().setGlobalScopes(scopes);

	beforeEach(() => {
		setActivePinia(createPinia());
	});

	it('has the same id as the backend module', () => {
		expect(OpenTriggersModule.id).toBe('open-triggers');
	});

	it('registers the modal of the fixes', () => {
		expect(OpenTriggersModule.modals?.map(({ key }) => key)).toEqual([
			OPEN_TRIGGER_FIXES_MODAL_KEY,
		]);
	});

	it('limits the settings route to users with the scope workflow:list', () => {
		const route = OpenTriggersModule.routes?.find(
			({ name }) => name === OPEN_TRIGGERS_SETTINGS_VIEW,
		);

		expect(route?.path).toBe('open-triggers');
		expect(route?.meta).toMatchObject({
			layout: 'settings',
			middleware: ['authenticated', 'rbac', 'custom'],
			middlewareOptions: { rbac: { scope: 'workflow:list' } },
		});
	});

	it('shows the sidebar item to a user with the scope when the module is on', () => {
		activate(true);
		grant(['workflow:list']);

		expect(settingsPage()).toMatchObject({
			label: 'Open triggers',
			route: { to: { name: OPEN_TRIGGERS_SETTINGS_VIEW } },
			available: true,
		});
	});

	it('hides the sidebar item from a user without the scope', () => {
		activate(true);
		grant(['user:list']);

		expect(settingsPage()?.available).toBe(false);
	});

	it('hides the sidebar item when the module is off', () => {
		activate(false);
		grant(['workflow:list']);

		expect(settingsPage()?.available).toBe(false);
	});
});
