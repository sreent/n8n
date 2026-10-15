import type {
	CreateCredentialResolverDto,
	CredentialResolver,
	CredentialResolverAffectedWorkflow,
	CredentialResolverType,
	UpdateCredentialResolverDto,
} from '@n8n/api-types';
import {
	CredentialResolverValidationError,
	type CredentialResolverConfiguration,
	type CredentialResolverHandle,
} from '@n8n/decorators';
import { Service } from '@n8n/di';
import { Cipher } from 'n8n-core';
import { jsonParse } from 'n8n-workflow';

import { CredentialResolverRegistry } from './credential-resolver-registry.service';
import { CredentialResolverWorkflowService } from './credential-resolver-workflow.service';
import { ResolverConfigExpressionService } from './resolver-config-expression.service';
import {
	collectSecretFieldNames,
	redactSecretConfig,
	restoreSecretConfig,
} from '../config-redaction';
import { SYSTEM_RESOLVER_ID, SYSTEM_RESOLVER_TYPE } from '../constants';
import type { DynamicCredentialResolver } from '../database/entities/credential-resolver';
import { DynamicCredentialResolverRepository } from '../database/repositories/credential-resolver.repository';
import { DynamicCredentialEntryRepository } from '../database/repositories/dynamic-credential-entry.repository';
import { DynamicCredentialResolverNotFoundError } from '../errors/credential-resolver-not-found.error';
import { SystemResolverModificationError } from '../errors/system-resolver-modification.error';

/** The resolvers of the instance: their types, their configuration and their workflows. */
@Service()
export class CredentialResolverService {
	constructor(
		private readonly repository: DynamicCredentialResolverRepository,
		private readonly entryRepository: DynamicCredentialEntryRepository,
		private readonly registry: CredentialResolverRegistry,
		private readonly workflows: CredentialResolverWorkflowService,
		private readonly expressions: ResolverConfigExpressionService,
		private readonly cipher: Cipher,
	) {}

	/** The resolver types that a user can create. The system type is not one of them. */
	listTypes(): CredentialResolverType[] {
		return this.registry
			.getAllResolvers()
			.filter((resolver) => resolver.metadata.name !== SYSTEM_RESOLVER_TYPE)
			.map(({ metadata }) => ({
				name: metadata.name,
				displayName: metadata.displayName ?? metadata.name,
				description: metadata.description,
				options: (metadata.options ?? []).map((option) => ({ ...option })),
			}));
	}

	/** The resolvers, without their configuration. */
	async findAll(includeSystem: boolean): Promise<CredentialResolver[]> {
		const resolvers = await this.repository.findResolvers(includeSystem);
		return resolvers.map((resolver) => this.toResponse(resolver));
	}

	/** A resolver with its configuration, with the secrets redacted. */
	async findById(id: string): Promise<CredentialResolver> {
		const resolver = await this.getOrFail(id);
		return await this.toResponseWithConfig(resolver);
	}

	async findAffectedWorkflows(id: string): Promise<CredentialResolverAffectedWorkflow[]> {
		await this.getOrFail(id);
		return await this.workflows.findAffectedWorkflows(id);
	}

	async create(dto: CreateCredentialResolverDto): Promise<CredentialResolver> {
		if (dto.type === SYSTEM_RESOLVER_TYPE) throw new SystemResolverModificationError('create');
		await this.validateConfig(dto.type, dto.config);
		const resolver = await this.repository.save(
			this.repository.create({
				name: dto.name,
				type: dto.type,
				config: await this.encryptConfig(dto.config),
			}),
		);
		return await this.toResponseWithConfig(resolver);
	}

	/**
	 * Changes a resolver. A new type or a new configuration is validated. A secret that the
	 * editor sends back redacted keeps its stored value. `clearCredentials` deletes the data
	 * that the resolver stored for its subjects.
	 */
	async update(id: string, dto: UpdateCredentialResolverDto): Promise<CredentialResolver> {
		const resolver = await this.getOrFail(id);
		if (id === SYSTEM_RESOLVER_ID) throw new SystemResolverModificationError('update');

		const previousType = resolver.type;
		const type = dto.type ?? resolver.type;
		if (dto.config !== undefined || dto.type !== undefined) {
			const storedConfig = await this.decryptConfig(resolver);
			const config =
				dto.config === undefined
					? storedConfig
					: restoreSecretConfig(dto.config, storedConfig, this.secretFieldsOf(type));
			await this.validateConfig(type, config);
			resolver.config = await this.encryptConfig(config);
		}
		resolver.type = type;
		if (dto.name !== undefined) resolver.name = dto.name;
		const saved = await this.repository.save(resolver);

		if (dto.clearCredentials === true) {
			// The resolver type that stored the data deletes it.
			await this.deleteAllSecrets(previousType, {
				resolverId: id,
				resolverName: saved.name,
				configuration: await this.resolvedConfigOf(saved),
			});
		}
		return await this.toResponseWithConfig(saved);
	}

	/**
	 * Deletes a resolver. The database deletes its stored data and unlinks its credentials.
	 * The workflows that use it lose the setting.
	 */
	async delete(id: string) {
		await this.getOrFail(id);
		if (id === SYSTEM_RESOLVER_ID) throw new SystemResolverModificationError('delete');
		await this.repository.delete({ id });
		await this.workflows.clearResolverFromWorkflows(id);
	}

	/** The configuration of a resolver, with its expressions evaluated. */
	async resolvedConfigOf(resolver: DynamicCredentialResolver) {
		return this.expressions.resolve(await this.decryptConfig(resolver));
	}

	private async deleteAllSecrets(type: string, handle: CredentialResolverHandle) {
		const implementation = this.registry.getResolverByTypename(type);
		if (implementation?.deleteAllSecrets) await implementation.deleteAllSecrets(handle);
		else await this.entryRepository.deleteAllOfResolver(handle.resolverId);
	}

	private async getOrFail(id: string) {
		const resolver = await this.repository.findResolverById(id);
		if (!resolver) throw new DynamicCredentialResolverNotFoundError(id);
		return resolver;
	}

	private secretFieldsOf(type: string) {
		return collectSecretFieldNames(this.registry.getResolverByTypename(type)?.metadata.options);
	}

	private async validateConfig(type: string, config: CredentialResolverConfiguration) {
		const resolver = this.registry.getResolverByTypename(type);
		if (!resolver) throw new CredentialResolverValidationError(`Unknown resolver type: ${type}`);
		await resolver.validateOptions(this.expressions.resolve(config));
	}

	private async encryptConfig(config: CredentialResolverConfiguration) {
		return await this.cipher.encryptV2(JSON.stringify(config));
	}

	private async decryptConfig(resolver: DynamicCredentialResolver) {
		return jsonParse<CredentialResolverConfiguration>(await this.cipher.decryptV2(resolver.config));
	}

	private toResponse(resolver: DynamicCredentialResolver): CredentialResolver {
		return {
			id: resolver.id,
			name: resolver.name,
			type: resolver.type,
			config: '',
			createdAt: resolver.createdAt,
			updatedAt: resolver.updatedAt,
		};
	}

	private async toResponseWithConfig(resolver: DynamicCredentialResolver) {
		return {
			...this.toResponse(resolver),
			decryptedConfig: redactSecretConfig(
				await this.decryptConfig(resolver),
				this.secretFieldsOf(resolver.type),
			),
		};
	}
}
