import { defineFrontendModule } from '@n8n/frontend-module-sdk';

import { SEND_COPY_MODAL_KEY, SEND_COPY_MODULE_ID } from './send-copy.constants';

/**
 * Keep this file import-light: types, constants and the SDK only. The modal loads
 * lazily, so the module adds nothing to the boot chunk.
 */
export const SendCopyModule = defineFrontendModule({
	// Must match the backend module id: both gate off `/rest/module-settings`.
	id: SEND_COPY_MODULE_ID,
	name: 'Send a copy',
	description: 'Send an independent copy of a workflow to colleagues.',
	icon: 'send',

	modals: [
		{
			key: SEND_COPY_MODAL_KEY,
			component: async () => await import('./components/SendCopyModal.vue'),
			initialState: { open: false, data: { workflowId: '', workflowName: '' } },
		},
	],
});
