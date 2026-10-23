import type { Scope } from '@n8n/permissions';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { createPinia, setActivePinia } from 'pinia';

import { GIT_SYNC_SETTINGS_VIEW } from './git-sync.constants';
import { GitSyncModule } from './git-sync.module';

describe('GitSyncModule', () => {
	const settingsPage = () =>
		GitSyncModule.settingsPages?.find(({ id }) => id === 'settings-git-sync');

	const grant = (scopes: Scope[]) => useRBACStore().setGlobalScopes(scopes);

	const activate = (active: boolean) => {
		useSettingsStore().$patch({ settings: { activeModules: active ? ['git-sync'] : [] } });
	};

	beforeEach(() => {
		setActivePinia(createPinia());
	});

	it('limits the settings route to users with the scope of source control', () => {
		const route = GitSyncModule.routes?.find(({ name }) => name === GIT_SYNC_SETTINGS_VIEW);

		expect(route?.path).toBe('git-sync');
		expect(route?.meta).toMatchObject({
			middleware: ['authenticated', 'rbac', 'custom'],
			middlewareOptions: { rbac: { scope: 'sourceControl:manage' } },
		});
	});

	it.each<[string, Scope[], boolean]>([
		['with the scope', ['sourceControl:manage'], true],
		['without the scope', ['workflow:list'], false],
	])('shows the sidebar item to a user %s: %s', (_label, scopes, visible) => {
		activate(true);
		grant(scopes);

		expect(settingsPage()?.available).toBe(visible);
	});

	it('has its own sidebar icon, not the icon of Environments', () => {
		expect(settingsPage()?.icon).toBe('arrow-left-right');
	});

	it('hides the sidebar item when the module is off', () => {
		activate(false);
		grant(['sourceControl:manage']);

		expect(settingsPage()?.available).toBe(false);
	});
});
