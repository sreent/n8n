import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import type {
	ICredentialContext,
	ICredentialDataDecryptedObject,
	IWorkflowSettings,
} from 'n8n-workflow';

import { CredentialTypes } from '@/credential-types';
import type {
	CredentialStoreMetadata,
	IDynamicCredentialStorageProvider,
} from '@/credentials/dynamic-credential-storage.interface';

import { DynamicCredentialService } from './dynamic-credential.service';
import { extractSharedFields } from './shared-fields';
import { CredentialStorageError } from '../errors/credential-storage.error';

/**
 * Stores the data of a private credential for the identity of a run, for example the OAuth
 * token after the OAuth flow or a refresh. The shared fields of the credential type stay in the
 * credential: the stored data holds only the other fields.
 */
@Service()
export class DynamicCredentialStorageService implements IDynamicCredentialStorageProvider {
	constructor(
		private readonly logger: Logger,
		private readonly credentialTypes: CredentialTypes,
		private readonly dynamicCredentialService: DynamicCredentialService,
	) {}

	async storeIfNeeded(
		credential: CredentialStoreMetadata,
		dynamicData: ICredentialDataDecryptedObject,
		credentialContext: ICredentialContext,
		_staticData?: ICredentialDataDecryptedObject,
		workflowSettings?: IWorkflowSettings,
		executionId?: string,
	): Promise<void> {
		if (!credential.isResolvable) return;
		try {
			const resolverId = this.dynamicCredentialService.effectiveResolverId(
				credential.resolverId,
				workflowSettings,
			);
			const found = resolverId
				? await this.dynamicCredentialService.findResolver(resolverId)
				: undefined;
			if (!found) {
				throw new CredentialStorageError(
					`Resolver "${resolverId}" not found for credential "${credential.name}"`,
				);
			}
			const sharedFields = new Set(
				extractSharedFields(this.credentialTypes.getByName(credential.type)),
			);
			const data = Object.fromEntries(
				Object.entries(dynamicData).filter(([field]) => !sharedFields.has(field)),
			);
			await found.resolver.setSecret(
				credential.id,
				credentialContext,
				data,
				found.handle,
				executionId,
			);
			this.logger.debug('Successfully stored dynamic credentials', {
				credentialId: credential.id,
				resolverId,
			});
		} catch (error) {
			this.logger.error('Failed to store dynamic credentials data', {
				credentialId: credential.id,
				error,
			});
			throw new CredentialStorageError(
				`Failed to store end-user credential data for "${credential.name}"`,
				{ cause: error },
			);
		}
	}
}
