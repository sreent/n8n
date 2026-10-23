import { SecretsProviderConnectionRepository, type SecretsProviderConnection } from '@n8n/db';
import { Service } from '@n8n/di';
import { Cipher } from 'n8n-core';
import { type IDataObject, jsonParse } from 'n8n-workflow';

/**
 * Fork code (not in upstream n8n). The stored connections of the mode with connections: their
 * settings are an encrypted JSON object.
 */
@Service()
export class ExternalSecretsProviderConnectionManager {
	constructor(
		private readonly connectionRepository: SecretsProviderConnectionRepository,
		private readonly cipher: Cipher,
	) {}

	/** The connections that the module loads: the enabled ones, in the order of their IDs. */
	async getEnabledConnections() {
		return await this.connectionRepository.findEnabledConnections();
	}

	async decryptSettings(connection: Pick<SecretsProviderConnection, 'encryptedSettings'>) {
		return jsonParse<IDataObject>(await this.cipher.decryptV2(connection.encryptedSettings));
	}

	async encryptSettings(settings: IDataObject) {
		return await this.cipher.encryptV2(JSON.stringify(settings));
	}
}
