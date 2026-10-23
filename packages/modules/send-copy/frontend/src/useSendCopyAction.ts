import { capabilities, capabilityRegistry } from '@n8n/frontend-module-sdk';
import { useI18n } from '@n8n/i18n';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { computed } from 'vue';

import {
	SEND_COPY_MODAL_KEY,
	SEND_COPY_MODULE_ID,
	SEND_COPY_RECIPIENTS_SCOPE,
} from './send-copy.constants';

/**
 * The "Send a copy" action for the workflow menus of the shell.
 *
 * `isAvailable` is false when the backend module is not active, or when the user cannot list
 * the users that the modal searches. Call `open` only from a handler: the shell provides the
 * modal openers after boot.
 */
export function useSendCopyAction() {
	const settingsStore = useSettingsStore();
	const rbacStore = useRBACStore();
	const i18n = useI18n();

	const isAvailable = computed(
		() =>
			settingsStore.isModuleActive(SEND_COPY_MODULE_ID) &&
			rbacStore.hasScope(SEND_COPY_RECIPIENTS_SCOPE),
	);
	const label = computed(() => i18n.baseText('sendCopy.menu.label'));

	function open(workflow: { id: string; name: string }) {
		capabilityRegistry.use(capabilities.modalOpeners).openModalWithData({
			name: SEND_COPY_MODAL_KEY,
			data: { workflowId: workflow.id, workflowName: workflow.name },
		});
	}

	return { isAvailable, label, open };
}
