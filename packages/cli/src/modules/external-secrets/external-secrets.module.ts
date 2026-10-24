import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule, OnShutdown } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Fork module (not in upstream n8n): external secrets, in place of the enterprise module
 * `external-secrets.ee`. packages/cli/src/modules/external-secrets/FORK.md describes it.
 */
@BackendModule({ name: 'external-secrets', licenseFlag: 'feat:externalSecrets' })
export class ExternalSecretsModule implements ModuleInterface {
	async init() {
		await import('./external-secrets.controller.js');
		await import('./external-secrets-settings.controller.js');
		await import('./secrets-providers-connections.controller.js');
		await import('./secrets-providers-project.controller.js');
		await import('./secrets-providers-completions.controller.js');
		await import('./secrets-providers-types.controller.js');

		const { ExternalSecretsManager } = await import('./external-secrets-manager.js');
		await Container.get(ExternalSecretsManager).init();
	}

	async systemTasks() {
		const { ExternalSecretsRefreshTask } = await import('./external-secrets-refresh.task.js');
		return [ExternalSecretsRefreshTask];
	}

	@OnShutdown()
	async shutdown() {
		const { ExternalSecretsManager } = await import('./external-secrets-manager.js');
		Container.get(ExternalSecretsManager).shutdown();
	}

	/** The modes of external secrets for the editor. */
	async settings() {
		const { ExternalSecretsConfig } = await import('./external-secrets.config.js');
		const { ExternalSecretsService } = await import('./external-secrets.service.js');
		const config = Container.get(ExternalSecretsConfig);
		return {
			multipleConnections: config.externalSecretsMultipleConnections,
			forProjects: config.externalSecretsForProjects,
			roleBasedAccess: config.externalSecretsRoleBasedAccess,
			systemRolesEnabled: await Container.get(ExternalSecretsService).getSystemRolesEnabled(),
		};
	}
}
