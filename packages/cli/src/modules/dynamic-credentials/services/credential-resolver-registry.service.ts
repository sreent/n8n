import { Logger } from '@n8n/backend-common';
import { CredentialResolverEntryMetadata, type ICredentialResolver } from '@n8n/decorators';
import { Container, Service } from '@n8n/di';

/** The resolver types: the classes with the `@CredentialResolver()` decorator, by type name. */
@Service()
export class CredentialResolverRegistry {
	private readonly resolvers = new Map<string, ICredentialResolver>();

	constructor(
		private readonly logger: Logger,
		private readonly resolverMetadata: CredentialResolverEntryMetadata,
	) {}

	async init() {
		this.resolvers.clear();
		for (const resolverClass of this.resolverMetadata.getClasses()) {
			const resolver = Container.get(resolverClass);
			try {
				await resolver.init?.();
			} catch (error) {
				this.logger.error(`Failed to initialize credential resolver "${resolverClass.name}"`, {
					error,
				});
				continue;
			}
			this.resolvers.set(resolver.metadata.name, resolver);
		}
	}

	getResolverByTypename(typeName: string): ICredentialResolver | undefined {
		return this.resolvers.get(typeName);
	}

	getAllResolvers(): ICredentialResolver[] {
		return [...this.resolvers.values()];
	}
}
