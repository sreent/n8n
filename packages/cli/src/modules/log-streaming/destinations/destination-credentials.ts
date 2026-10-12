import { CredentialsRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { Credentials } from 'n8n-core';
import { OperationalError, type ICredentialDataDecryptedObject } from 'n8n-workflow';

import { CREDENTIAL_CACHE_TTL_MS } from '../log-streaming.constants';

interface CachedCredential {
	type: string;
	data: ICredentialDataDecryptedObject;
	expiresAt: number;
}

/**
 * Loads the decrypted data of the credentials that webhook destinations use. The data stays in
 * memory for a minute, so that each event does not read and decrypt the credential again.
 */
@Service()
export class DestinationCredentials {
	private readonly cache = new Map<string, CachedCredential>();

	constructor(private readonly credentialsRepository: CredentialsRepository) {}

	async load(id: string, type: string): Promise<ICredentialDataDecryptedObject> {
		const cached = this.cache.get(id);
		if (cached && cached.type === type && cached.expiresAt > Date.now()) return cached.data;

		const credential = await this.credentialsRepository.findOneBy({ id, type });
		if (!credential) {
			throw new OperationalError(`The credential "${id}" of the type "${type}" does not exist`);
		}
		const data = await new Credentials(
			{ id: credential.id, name: credential.name },
			credential.type,
			credential.data,
		).getData();
		this.cache.set(id, { type, data, expiresAt: Date.now() + CREDENTIAL_CACHE_TTL_MS });
		return data;
	}

	/** Forgets the loaded data. */
	clear() {
		this.cache.clear();
	}
}
