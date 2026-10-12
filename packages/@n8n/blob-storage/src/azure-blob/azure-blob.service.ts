import { Service } from '@n8n/di';

import { StorageUnavailableError } from '../unavailable-storage';

/**
 * Fork stand-in (not in upstream n8n) for the enterprise Azure Blob client, which the fork
 * removed. n8n loads it when `N8N_EXTERNAL_STORAGE_AZURE_CONTAINER_NAME` is set. Then `init()`
 * fails: n8n continues without Azure Blob, or stops when a storage mode needs it. See
 * `../../FORK.md`.
 */
@Service()
export class AzureBlobService {
	async init(): Promise<void> {
		throw new StorageUnavailableError('Azure Blob');
	}
}
