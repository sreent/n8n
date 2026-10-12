import { Service } from '@n8n/di';

import { StorageUnavailableError } from '../unavailable-storage';

/**
 * Fork stand-in (not in upstream n8n) for the enterprise S3 client, which the fork removed.
 * n8n loads it when `N8N_EXTERNAL_STORAGE_S3_BUCKET_NAME` is set. Then `init()` fails: n8n
 * continues without S3, or stops when a storage mode needs S3. See `../../FORK.md`.
 */
@Service()
export class ObjectStoreService {
	async init(): Promise<void> {
		throw new StorageUnavailableError('S3');
	}
}
