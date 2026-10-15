// Fork code (not in upstream n8n): the frontend module of Git connections (promotions): the
// settings page "Environments v2" and the selection modal of the banners of a project. See
// `FORK.md` in this folder.
import { defineFrontendModule } from '@n8n/frontend-module-sdk';

import { VIEWS } from '@/app/constants';
import { usePromotionsEnabled } from '@/features/shared/promotions/usePromotionsEnabled';

import { PROMOTION_SELECT_MODAL_KEY, PROMOTIONS_SETTINGS_VIEW } from './promotions.constants';

const PromotionsSettingsView = async () => await import('./views/PromotionsSettingsView.vue');
const PromotionSelectModal = async () => await import('./components/PromotionSelectModal.vue');

export const PromotionsModule = defineFrontendModule({
	id: 'promotions',
	name: 'Promotions',
	description: 'Promote workflow changes between environments',
	icon: 'upload',
	routes: [
		{
			path: 'promotions',
			name: PROMOTIONS_SETTINGS_VIEW,
			component: PromotionsSettingsView,
			beforeEnter: () => (usePromotionsEnabled().isEnabled.value ? true : { name: VIEWS.HOMEPAGE }),
			meta: {
				layout: 'settings',
				middleware: ['authenticated', 'rbac', 'custom'],
				middlewareOptions: {
					rbac: {
						scope: [
							'gitConnection:list',
							'gitConnection:read',
							'gitConnection:create',
							'gitConnection:update',
							'gitConnection:delete',
						],
						options: { mode: 'allOf' },
					},
				},
				telemetry: {
					pageCategory: 'settings',
					getProperties: () => ({ feature: 'promotions' }),
				},
			},
		},
	],
	modals: [
		{
			key: PROMOTION_SELECT_MODAL_KEY,
			component: PromotionSelectModal,
			initialState: { open: false, data: { projectId: '' } },
		},
	],
});
