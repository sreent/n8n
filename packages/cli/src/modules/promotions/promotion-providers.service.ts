import type {
	CreatePromotionProviderDto,
	PromotionProviderAuthInput,
	PromotionProviderAuthUpdate,
	PromotionProviderConfig,
	PromotionSshKeyType,
	UpdatePromotionProviderDto,
} from '@n8n/api-types';
import { promotionGitConfigSchemas } from '@n8n/api-types';
import { Service } from '@n8n/di';
import { BadRequestError, ConflictError, NotFoundError } from '@n8n/errors';
import { generateKeyPairSync } from 'node:crypto';
import { Cipher } from 'n8n-core';
import { jsonParse } from 'n8n-workflow';
import sshpk from 'sshpk';
import { z } from 'zod';

import type { PromotionProvider } from './database/entities/promotion-provider.entity';
import { PromotionRowConflictError } from './database/promotion-row-conflict.error';
import { PromotionConnectionRepository } from './database/repositories/promotion-connection.repository';
import { PromotionProviderRepository } from './database/repositories/promotion-provider.repository';
import { PROMOTION_KEY_COMMENT } from './promotions.constants';

/** The credentials of a provider, after decryption. */
export type PromotionCredentials =
	| { authType: 'token'; username: string; password: string }
	| { authType: 'ssh-key'; privateKey: string };

const storedCredentialsSchema = z.discriminatedUnion('authType', [
	z.object({ authType: z.literal('token'), username: z.string(), password: z.string() }),
	z.object({ authType: z.literal('ssh-key'), privateKey: z.string() }),
]);

/** A provider as the public API gives it: without the credentials. */
export function toProviderPublic(provider: PromotionProvider) {
	return {
		id: provider.id,
		name: provider.name,
		type: provider.type,
		authType: provider.authType,
		config: provider.config,
		createdAt: provider.createdAt.toISOString(),
		updatedAt: provider.updatedAt.toISOString(),
	};
}

/** A provider in a list or in a connection: also without the public key. */
export function toProviderSummary(provider: PromotionProvider) {
	const { config: _config, ...summary } = toProviderPublic(provider);
	return summary;
}

/**
 * Fork code (not in upstream n8n): the providers of Git connections. A provider keeps the
 * credentials for a Git host: an SSH key pair that n8n makes, or a username and a password for
 * HTTPS. The credentials are encrypted, and no answer gives them. See `README.md`.
 */
@Service()
export class PromotionProvidersService {
	constructor(
		private readonly providerRepository: PromotionProviderRepository,
		private readonly connectionRepository: PromotionConnectionRepository,
		private readonly cipher: Cipher,
	) {}

	async create(input: CreatePromotionProviderDto) {
		const { config, credentials } = this.makeAuth(input.auth);
		const provider = this.providerRepository.create({
			name: input.name,
			type: input.type,
			authType: input.auth.authType,
			config,
			auth: await this.encrypt(credentials),
		});
		const saved = await this.providerRepository.save(provider);
		return {
			provider: toProviderPublic(saved),
			publicKey: 'publicKey' in config ? config.publicKey : null,
		};
	}

	async list(offset: number, limit: number) {
		const { data, count } = await this.providerRepository.findPage(offset, limit);
		return { data: data.map(toProviderSummary), count };
	}

	async findOne(id: string) {
		return toProviderPublic(await this.getEntity(id));
	}

	/** Renames a provider, and replaces its credentials when `auth` is sent. */
	async update(id: string, input: UpdatePromotionProviderDto) {
		const provider = await this.getEntity(id);
		if (input.auth) {
			if (input.auth.authType !== provider.authType) {
				throw new BadRequestError(
					'A provider cannot change its authentication method. Create another provider instead.',
				);
			}
			const { config, credentials } = this.makeAuth(this.withCurrentKeyType(input.auth, provider));
			provider.config = config;
			provider.auth = await this.encrypt(credentials);
		}
		if (input.name !== undefined) provider.name = input.name;
		return toProviderPublic(await this.providerRepository.save(provider));
	}

	/** Deletes a provider. A provider that a connection uses stays. */
	async delete(id: string) {
		await this.getEntity(id);
		if (await this.connectionRepository.isProviderInUse(id)) {
			throw new ConflictError('This provider is used by a connection');
		}
		try {
			await this.providerRepository.deleteProvider(id);
		} catch (error) {
			if (error instanceof PromotionRowConflictError) {
				throw new ConflictError('This provider is used by a connection');
			}
			throw error;
		}
	}

	async getEntity(id: string) {
		const provider = await this.providerRepository.findById(id);
		if (!provider) throw new NotFoundError('Promotion provider not found');
		return provider;
	}

	async decryptCredentials(provider: PromotionProvider): Promise<PromotionCredentials> {
		const plain = await this.cipher.decryptV2(provider.auth);
		return storedCredentialsSchema.parse(jsonParse(plain));
	}

	/** An SSH update without `keyType` makes a key of the type of the current key. */
	private withCurrentKeyType(
		auth: PromotionProviderAuthUpdate,
		provider: PromotionProvider,
	): PromotionProviderAuthInput {
		if (auth.authType === 'token') return auth;
		const current = promotionGitConfigSchemas['ssh-key'].safeParse(provider.config);
		return {
			authType: 'ssh-key',
			keyType: auth.keyType ?? (current.success ? current.data.keyType : 'ed25519'),
		};
	}

	private makeAuth(auth: PromotionProviderAuthInput): {
		config: PromotionProviderConfig;
		credentials: PromotionCredentials;
	} {
		if (auth.authType === 'token') {
			return {
				config: { schemaVersion: 1 },
				credentials: { authType: 'token', username: auth.username, password: auth.password },
			};
		}
		const { privateKey, publicKey } = generateKeyPair(auth.keyType);
		return {
			config: { schemaVersion: 1, publicKey, keyType: auth.keyType },
			credentials: { authType: 'ssh-key', privateKey },
		};
	}

	private async encrypt(credentials: PromotionCredentials) {
		return await this.cipher.encryptV2(JSON.stringify(credentials));
	}
}

/** An OpenSSH key pair: an ed25519 key, or an RSA key of 4096 bits. */
function generateKeyPair(type: PromotionSshKeyType) {
	const pair =
		type === 'ed25519'
			? generateKeyPairSync('ed25519')
			: generateKeyPairSync('rsa', { modulusLength: 4096 });
	const privatePem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
	const publicPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
	const privateKey = sshpk.parsePrivateKey(privatePem, 'pem');
	privateKey.comment = PROMOTION_KEY_COMMENT;
	const publicKey = sshpk.parseKey(publicPem, 'pem');
	publicKey.comment = PROMOTION_KEY_COMMENT;
	return { privateKey: privateKey.toString('ssh'), publicKey: publicKey.toString('ssh') };
}
