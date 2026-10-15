import { Service } from '@n8n/di';
import { DataSource, Repository } from '@n8n/typeorm';

import { DynamicCredentialEntry } from '../entities/dynamic-credential-entry';

@Service()
export class DynamicCredentialEntryRepository extends Repository<DynamicCredentialEntry> {
	constructor(dataSource: DataSource) {
		super(DynamicCredentialEntry, dataSource.manager);
	}

	/** The stored data of a subject, or null. */
	async findData(credentialId: string, subjectId: string, resolverId: string) {
		const entry = await this.findOne({
			select: ['data'],
			where: { credentialId, subjectId, resolverId },
		});
		return entry?.data ?? null;
	}

	/** Stores the data of a subject: changes the existing entry, else adds one. */
	async saveData(credentialId: string, subjectId: string, resolverId: string, data: string) {
		await this.upsert({ credentialId, subjectId, resolverId, data }, [
			'credentialId',
			'subjectId',
			'resolverId',
		]);
	}

	async deleteData(credentialId: string, subjectId: string, resolverId: string) {
		await this.delete({ credentialId, subjectId, resolverId });
	}

	/** Deletes the data of all subjects of a resolver. */
	async deleteAllOfResolver(resolverId: string) {
		await this.delete({ resolverId });
	}
}
