import { ExternalSecretsConnectionRepository } from '@n8n/db';
import { Service } from '@n8n/di';

/**
 * Fork code (not in upstream n8n). Whether a project can use a connection: the credentials of the
 * project can only refer to the secrets of these connections.
 */
@Service()
export class SecretsProviderAccessCheckService {
	constructor(private readonly connectionRepository: ExternalSecretsConnectionRepository) {}

	/**
	 * A global connection is available in each project; a connection with access rows only in its
	 * projects. A disabled connection counts.
	 */
	async isProviderAvailableInProject(providerKey: string, projectId: string) {
		const connection = await this.connectionRepository.findWithAccessByProviderKey(providerKey);
		if (!connection) return false;
		const { projectAccess } = connection;
		return projectAccess.length === 0 || projectAccess.some((row) => row.projectId === projectId);
	}
}
