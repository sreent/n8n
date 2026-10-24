// Fork code (not in upstream n8n): the frontend module of log streaming. It gives the page
// Settings > Log streaming, its item in the settings menu and the modal of a destination, in
// place of the descriptor of the enterprise folder `logStreaming.ee`. See `FORK.md` in this
// folder.
import { defineFrontendModule } from '@n8n/frontend-module-sdk';
import { useI18n } from '@n8n/i18n';
import { useRBACStore } from '@n8n/stores/rbac.store';

import { VIEWS } from '@/app/constants';

import {
	LOG_STREAM_MODAL_KEY,
	LOG_STREAMING_MODULE_ID,
	LOG_STREAMING_SCOPE,
} from './logStreaming.constants';

const SettingsLogStreamingView = async () => await import('./views/SettingsLogStreamingView.vue');
const EventDestinationSettingsModal = async () =>
	await import('./components/EventDestinationSettingsModal.vue');

export const LogStreamingModule = defineFrontendModule({
	id: LOG_STREAMING_MODULE_ID,
	name: 'Log streaming',
	description: 'Send the events of n8n to webhook, syslog and Sentry destinations',
	icon: 'log-in',
	routes: [
		{
			path: 'log-streaming',
			name: VIEWS.LOG_STREAMING_SETTINGS,
			component: SettingsLogStreamingView,
			meta: {
				layout: 'settings',
				middleware: ['authenticated', 'rbac', 'custom'],
				middlewareOptions: {
					rbac: { scope: LOG_STREAMING_SCOPE },
				},
				telemetry: {
					pageCategory: 'settings',
				},
			},
		},
	],
	modals: [
		{
			key: LOG_STREAM_MODAL_KEY,
			component: EventDestinationSettingsModal,
			initialState: { open: false, data: undefined },
		},
	],
	settingsPages: [
		{
			id: 'settings-log-streaming',
			icon: 'log-in',
			get label() {
				return useI18n().baseText('settings.log-streaming');
			},
			position: 'top',
			// After the worker view (160) and before the community nodes (180), as before.
			order: 170,
			route: { to: { name: VIEWS.LOG_STREAMING_SETTINGS } },
			get available() {
				return useRBACStore().hasScope(LOG_STREAMING_SCOPE);
			},
		},
	],
	// While the fork switch is off, the module does not start. The page then tells how to turn
	// the switch on.
	placeholderPage: {
		licenseFlag: 'logStreaming',
		component: async () => (await import('./views/SettingsLogStreamingView.vue')).default,
	},
});
