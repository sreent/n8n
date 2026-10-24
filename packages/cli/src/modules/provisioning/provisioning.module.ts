// Fork module (not in upstream n8n): the role provisioning of SSO, in place of the enterprise
// `provisioning.ee` module, which the fork deleted. packages/cli/src/modules/provisioning/FORK.md
// describes it.
import { RoleDeletionCheckProxy } from '@n8n/backend-services';
import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';
import { Container } from '@n8n/di';

@BackendModule({
	name: 'provisioning',
	licenseFlag: ['feat:saml', 'feat:oidc'],
})
export class ProvisioningModule implements ModuleInterface {
	async init() {
		await import('./provisioning.controller.js');
		await import('./role-mapping-rule.controller.js');

		const { ProvisioningRoleDeletionChecker } = await import('./role-deletion-checker.js');
		Container.get(RoleDeletionCheckProxy).registerProvider(
			Container.get(ProvisioningRoleDeletionChecker),
		);
	}
}
