import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';

/**
 * Fork module (not in upstream n8n): Git connections, which the code calls promotions. An instance
 * promotes its team projects to a Git branch, and another instance applies the branch. The public
 * API controller `promotions.public.controller.ts` loads the services when a request comes.
 * `README.md` describes the module. It is not a default module: `N8N_ENABLED_MODULES=promotions`
 * turns it on.
 */
@BackendModule({ name: 'promotions' })
export class PromotionsModule implements ModuleInterface {
	async init() {}

	async entities() {
		const { PromotionProvider } = await import('./database/entities/promotion-provider.entity.js');
		const { PromotionConnection } = await import(
			'./database/entities/promotion-connection.entity.js'
		);
		const { PromotionConnectionProject } = await import(
			'./database/entities/promotion-connection-project.entity.js'
		);
		const { PromotionConfig } = await import('./database/entities/promotion-config.entity.js');
		return [PromotionProvider, PromotionConnection, PromotionConnectionProject, PromotionConfig];
	}
}
