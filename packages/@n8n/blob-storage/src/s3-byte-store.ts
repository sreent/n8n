import type { ObjectStoreService } from './object-store/object-store.service';
import { UnavailableByteStore } from './unavailable-storage';

/**
 * Fork stand-in (not in upstream n8n) for the enterprise S3 byte store, which the fork removed.
 * Each operation fails. See `../FORK.md`.
 */
export class S3ByteStore extends UnavailableByteStore {
	// The parameter keeps the constructor that the ordinary callers use.
	constructor(_objectStoreService: ObjectStoreService) {
		super('S3');
	}
}
