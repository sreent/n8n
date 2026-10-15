import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import { Cipher } from 'n8n-core';

import { SYSTEM_RESOLVER_ID, SYSTEM_RESOLVER_NAME, SYSTEM_RESOLVER_TYPE } from '../constants';
import { DynamicCredentialResolverRepository } from '../database/repositories/credential-resolver.repository';

/** Adds the system resolver when it is not there. Each start of the module calls it. */
@Service()
export class N8nResolverSeederService {
	private seeded = false;

	constructor(
		private readonly logger: Logger,
		private readonly repository: DynamicCredentialResolverRepository,
		private readonly cipher: Cipher,
	) {}

	/** Whether the system resolver exists. */
	get isSeeded() {
		return this.seeded;
	}

	async seed() {
		if (!(await this.repository.existsResolver(SYSTEM_RESOLVER_ID))) {
			try {
				await this.repository.insert({
					id: SYSTEM_RESOLVER_ID,
					name: SYSTEM_RESOLVER_NAME,
					type: SYSTEM_RESOLVER_TYPE,
					config: await this.cipher.encryptV2('{}'),
				});
			} catch (error) {
				// Another main instance can add it at the same time.
				if (!(await this.repository.existsResolver(SYSTEM_RESOLVER_ID))) throw error;
				this.logger.debug('Another instance added the system credential resolver', { error });
			}
		}
		this.seeded = true;
	}
}
