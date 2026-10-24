import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule, OnShutdown } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Fork module (not in upstream n8n): dynamic credentials, in place of the enterprise module
 * `dynamic-credentials.ee`. A private credential (an end-user credential) has data for each
 * user: the system resolver keys it by the n8n user, a custom resolver keys it by the user of
 * an external identity provider (OAuth2 or Slack). See `README.md` in this folder.
 */
@BackendModule({ name: 'dynamic-credentials', licenseFlag: 'feat:dynamicCredentials' })
export class DynamicCredentialsModule implements ModuleInterface {
	async init() {
		// The decorators of these files register the resolver types, the hooks and the routes.
		await import('./credential-resolvers/index.js');
		await import('./context-establishment-hooks/index.js');
		await import('./credential-resolvers.controller.js');
		await import('./dynamic-credentials.controller.js');
		await import('./workflow-status.controller.js');

		const { CredentialResolverRegistry } = await import(
			'./services/credential-resolver-registry.service.js'
		);
		const { N8nResolverSeederService } = await import('./services/n8n-resolver-seeder.service.js');
		await Container.get(CredentialResolverRegistry).init();
		await Container.get(N8nResolverSeederService).seed();

		const { DynamicCredentialsProxy } = await import('@/credentials/dynamic-credentials-proxy.js');
		const { CredentialConnectionStatusProxy } = await import(
			'@/credentials/credential-connection-status-proxy.js'
		);
		const { ExecutingUserIdentifierProxy } = await import('@n8n/backend-services');
		const { DynamicCredentialService } = await import('./services/dynamic-credential.service.js');
		const { DynamicCredentialStorageService } = await import(
			'./services/dynamic-credential-storage.service.js'
		);
		const { CredentialConnectionStatusService } = await import(
			'./services/credential-connection-status.service.js'
		);
		const { N8NIdentifier } = await import('./credential-resolvers/identifiers/n8n-identifier.js');

		const proxy = Container.get(DynamicCredentialsProxy);
		proxy.setStorageProvider(Container.get(DynamicCredentialStorageService));
		proxy.setResolverProvider(Container.get(DynamicCredentialService));
		Container.get(CredentialConnectionStatusProxy).setProvider(
			Container.get(CredentialConnectionStatusService),
		);
		Container.get(ExecutingUserIdentifierProxy).setProvider(Container.get(N8NIdentifier));
	}

	async entities() {
		const { DynamicCredentialResolver } = await import(
			'./database/entities/credential-resolver.js'
		);
		const { DynamicCredentialEntry } = await import(
			'./database/entities/dynamic-credential-entry.js'
		);
		const { DynamicCredentialUserEntry } = await import(
			'./database/entities/dynamic-credential-user-entry.js'
		);
		return [DynamicCredentialResolver, DynamicCredentialEntry, DynamicCredentialUserEntry];
	}

	/** The credential check, for the forms and the Dynamic Credential Check node. */
	async context() {
		const { CredentialCheckProxyService } = await import(
			'./services/credential-check-proxy.service.js'
		);
		return { credentialCheckProxy: Container.get(CredentialCheckProxyService) };
	}

	/** Nothing to stop: the module has no timers, and runs keep their resolution until the end. */
	@OnShutdown(100)
	async shutdown() {}
}
