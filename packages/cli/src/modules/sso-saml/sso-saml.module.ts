import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

@BackendModule({ name: 'sso-saml', licenseFlag: 'feat:saml', instanceTypes: ['main'] })
export class SamlModule implements ModuleInterface {
	async init() {
		await import('./saml.controller.js');

		const { SamlService } = await import('./saml.service.js');
		await Container.get(SamlService).init();
	}
}
