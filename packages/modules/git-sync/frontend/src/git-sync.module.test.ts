import type { CurrentUserResponse } from '@n8n/rest-api-client/api/users';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useUsersStore } from '@n8n/stores/users.store';
import { createPinia, setActivePinia } from 'pinia';

import { GIT_SYNC_SETTINGS_VIEW } from './git-sync.constants';
import { GitSyncModule } from './git-sync.module';

describe('GitSyncModule', () => {
	const settingsPage = () =>
		GitSyncModule.settingsPages?.find(({ id }) => id === 'settings-git-sync');

	const signIn = (role: string) => {
		const usersStore = useUsersStore();
		usersStore.addUsers([
			{
				id: 'user-1',
				email: 'user@example.com',
				firstName: 'Ada',
				lastName: 'Lovelace',
				role,
				isPending: false,
			} as CurrentUserResponse,
		]);
		usersStore.currentUserId = 'user-1';
	};

	const activate = (active: boolean) => {
		useSettingsStore().$patch({ settings: { activeModules: active ? ['git-sync'] : [] } });
	};

	beforeEach(() => {
		setActivePinia(createPinia());
	});

	it('limits the settings route to the owner and admins', () => {
		const route = GitSyncModule.routes?.find(({ name }) => name === GIT_SYNC_SETTINGS_VIEW);

		expect(route?.path).toBe('git-sync');
		expect(route?.meta).toMatchObject({
			middleware: ['authenticated', 'role', 'custom'],
			middlewareOptions: { role: ['global:owner', 'global:admin'] },
		});
	});

	it.each([
		['global:owner', true],
		['global:admin', true],
		['global:member', false],
	])('shows the sidebar item to %s: %s', (role, visible) => {
		activate(true);
		signIn(role);

		expect(settingsPage()?.available).toBe(visible);
	});

	it('has its own sidebar icon, not the icon of Environments', () => {
		expect(settingsPage()?.icon).toBe('arrow-left-right');
	});

	it('hides the sidebar item when the module is off', () => {
		activate(false);
		signIn('global:owner');

		expect(settingsPage()?.available).toBe(false);
	});
});
