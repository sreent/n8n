import type { FrontendSettings } from '@n8n/api-types';
import { capabilities, capabilityRegistry } from '@n8n/frontend-module-sdk';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { createPinia, setActivePinia } from 'pinia';

import { SEND_COPY_MODAL_KEY } from './send-copy.constants';
import { useSendCopyAction } from './useSendCopyAction';

describe('useSendCopyAction', () => {
	const openModal = vi.fn();
	const openModalWithData = vi.fn();

	beforeEach(() => {
		setActivePinia(createPinia());
		capabilityRegistry.provide(capabilities.modalOpeners, { openModal, openModalWithData });
	});

	afterEach(() => {
		capabilityRegistry.clear();
		vi.clearAllMocks();
	});

	it('is not available before the settings load', () => {
		expect(useSendCopyAction().isAvailable.value).toBeFalsy();
	});

	it('is not available when the backend module is not active', () => {
		useSettingsStore().$patch({ settings: { activeModules: ['otel'] } as FrontendSettings });

		expect(useSendCopyAction().isAvailable.value).toBe(false);
	});

	it('is available when the backend module is active and the user can list users', () => {
		useSettingsStore().$patch({ settings: { activeModules: ['send-copy'] } as FrontendSettings });
		useRBACStore().addGlobalScope('user:list');

		expect(useSendCopyAction().isAvailable.value).toBe(true);
	});

	it('is not available when the user cannot list users', () => {
		useSettingsStore().$patch({ settings: { activeModules: ['send-copy'] } as FrontendSettings });

		expect(useSendCopyAction().isAvailable.value).toBe(false);
	});

	it('gives the menu label', () => {
		expect(useSendCopyAction().label.value).toBe('Send a copy');
	});

	it('opens the modal with the workflow', () => {
		useSendCopyAction().open({ id: 'wf-1', name: 'Daily report' });

		expect(openModalWithData).toHaveBeenCalledWith({
			name: SEND_COPY_MODAL_KEY,
			data: { workflowId: 'wf-1', workflowName: 'Daily report' },
		});
	});
});
