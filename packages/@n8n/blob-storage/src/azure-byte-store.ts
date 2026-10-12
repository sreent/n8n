import type { AzureBlobService } from './azure-blob/azure-blob.service';
import { UnavailableByteStore } from './unavailable-storage';

/**
 * Fork stand-in (not in upstream n8n) for the enterprise Azure Blob byte store, which the fork
 * removed. Each operation fails. See `../FORK.md`.
 */
export class AzureByteStore extends UnavailableByteStore {
	// The parameter keeps the constructor that the ordinary callers use.
	constructor(_azureBlobService: AzureBlobService) {
		super('Azure Blob');
	}
}
