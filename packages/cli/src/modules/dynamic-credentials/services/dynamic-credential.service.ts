import { Logger } from '@n8n/backend-common';
import {
	CredentialResolverDataNotFoundError,
	CredentialResolverError,
	type CredentialResolverHandle,
	type ICredentialResolver,
} from '@n8n/decorators';
import { Service } from '@n8n/di';
import { ExecutionContextService } from 'n8n-core';
import type {
	ICredentialDataDecryptedObject,
	IExecutionContext,
	IWorkflowSettings,
} from 'n8n-workflow';

import type {
	CredentialResolutionResult,
	CredentialResolveMetadata,
	ICredentialResolutionProvider,
} from '@/credentials/credential-resolution-provider.interface';

import { CredentialResolverRegistry } from './credential-resolver-registry.service';
import { CredentialResolverService } from './credential-resolver.service';
import { N8nResolverSeederService } from './n8n-resolver-seeder.service';
import { SYSTEM_RESOLVER_ID, SYSTEM_RESOLVER_TYPE } from '../constants';
import { isN8nIdentity } from '../credential-resolvers/identifiers/n8n-identifier';
import type { DynamicCredentialResolver } from '../database/entities/credential-resolver';
import { DynamicCredentialResolverRepository } from '../database/repositories/credential-resolver.repository';
import { CredentialResolutionError } from '../errors/credential-resolution.error';
import { CredentialResolverNotConfiguredError } from '../errors/credential-resolver-not-configured.error';
import { CredentialResolverNotFoundError } from '../errors/credential-resolver-not-found.error';
import { MissingExecutionContextError } from '../errors/missing-execution-context.error';
import { N8nIdentityNotSupportedError } from '../errors/n8n-identity-not-supported.error';

/** A stored resolver with its resolver type and the handle for the calls of the type. */
export type ResolverWithHandle = {
	entity: DynamicCredentialResolver;
	resolver: ICredentialResolver;
	handle: CredentialResolverHandle;
};

/**
 * Resolves private credentials for a run: the resolver of the credential (or of the workflow,
 * or the system resolver) gives the data of the identity of the run, which replaces the static
 * data of the credential.
 */
@Service()
export class DynamicCredentialService implements ICredentialResolutionProvider {
	constructor(
		private readonly logger: Logger,
		private readonly repository: DynamicCredentialResolverRepository,
		private readonly registry: CredentialResolverRegistry,
		private readonly resolverService: CredentialResolverService,
		private readonly seeder: N8nResolverSeederService,
		private readonly executionContextService: ExecutionContextService,
	) {}

	getSystemResolverId(): string | null {
		return this.seeder.isSeeded ? SYSTEM_RESOLVER_ID : null;
	}

	/** The resolver that a credential uses: its own, else the one of the workflow, else the system one. */
	effectiveResolverId(resolverId: string | null | undefined, settings?: IWorkflowSettings) {
		return resolverId ?? settings?.credentialResolverId ?? this.getSystemResolverId();
	}

	/** A stored resolver with its type, or undefined when one of them does not exist. */
	async findResolver(resolverId: string): Promise<ResolverWithHandle | undefined> {
		const entity = await this.repository.findResolverById(resolverId);
		if (!entity) return undefined;
		const resolver = this.registry.getResolverByTypename(entity.type);
		if (!resolver) return undefined;
		const handle: CredentialResolverHandle = {
			configuration: await this.resolverService.resolvedConfigOf(entity),
			resolverName: entity.name,
			resolverId: entity.id,
		};
		return { entity, resolver, handle };
	}

	async resolveIfNeeded(
		credential: CredentialResolveMetadata,
		staticData: ICredentialDataDecryptedObject,
		executionContext?: IExecutionContext,
		workflowSettings?: IWorkflowSettings,
		executionId?: string,
	): Promise<CredentialResolutionResult> {
		if (!credential.isResolvable) return { data: staticData, isDynamic: false };

		const log = { credentialId: credential.id, credentialName: credential.name };
		const resolverId = this.effectiveResolverId(credential.resolverId, workflowSettings);
		if (!resolverId) throw new CredentialResolverNotConfiguredError(credential.name);

		const found = await this.findResolver(resolverId);
		if (!found) {
			this.logger.debug('Resolver not found for dynamic credential', { ...log, resolverId });
			throw new CredentialResolverNotFoundError(resolverId, credential.name);
		}
		if (!executionContext?.credentials) {
			this.logger.debug('No execution context available for dynamic credential', log);
			throw new MissingExecutionContextError();
		}

		const context = await this.executionContextService.decryptCredentialContext(
			executionContext.credentials,
		);
		const { entity, resolver, handle } = found;
		const isSystemResolver = entity.type === SYSTEM_RESOLVER_TYPE;
		if (!isSystemResolver && isN8nIdentity(context)) {
			this.logger.debug('Refused to resolve external-subject credential with n8n identity', log);
			throw new N8nIdentityNotSupportedError(credential.name);
		}

		try {
			const data = await resolver.getSecret(credential.id, context, handle, executionId);
			const resolvedUserId = await resolver.resolveOwningUserId?.(context, handle, executionId);
			this.logger.debug('Successfully resolved dynamic credentials', { ...log, resolverId });
			return {
				data: { ...staticData, ...data },
				isDynamic: true,
				...(resolvedUserId ? { resolvedUserId } : {}),
			};
		} catch (error) {
			this.logger.debug('Dynamic credential resolution failed', { ...log, resolverId });
			if (error instanceof CredentialResolverDataNotFoundError && isSystemResolver) {
				throw new CredentialResolutionError(
					`'${credential.name}' end-user credential is not connected for you. Connect yours to execute this workflow manually.`,
					{ cause: error },
				);
			}
			const reason =
				error instanceof CredentialResolverError || error instanceof CredentialResolutionError
					? `: ${error.message}`
					: '';
			throw new CredentialResolutionError(
				`Failed to resolve dynamic credentials for "${credential.name}"${reason}`,
				{ cause: error },
			);
		}
	}
}
