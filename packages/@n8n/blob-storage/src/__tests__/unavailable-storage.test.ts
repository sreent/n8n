import { Container } from '@n8n/di';
import { UserError } from 'n8n-workflow';

import { AzureBlobService } from '../azure-blob';
import { AzureByteStore } from '../azure-byte-store';
import { ObjectStoreService } from '../object-store';
import { S3ByteStore } from '../s3-byte-store';
import type { ByteStore } from '../types';
import { StorageUnavailableError } from '../unavailable-storage';

const S3_MESSAGE =
	'S3 storage is not in this build of n8n. Keep binary data and execution data in the database or on the filesystem.';
const AZURE_MESSAGE =
	'Azure Blob storage is not in this build of n8n. Keep binary data and execution data in the database or on the filesystem.';

async function expectEachOperationToFail(store: ByteStore, message: string) {
	const operations = [
		async () => await store.write('key', Buffer.from('data')),
		async () => await store.read('key'),
		async () => await store.readStream('key'),
		async () => await store.copy('source', 'target'),
		async () => await store.rename('old', 'new'),
		async () => await store.delete(['key']),
		async () => await store.getMetadata?.('key'),
	];

	for (const operation of operations) {
		await expect(operation()).rejects.toThrow(message);
	}
}

describe('fork stand-ins for the S3 and Azure Blob storage', () => {
	it('fails the start of the S3 client', async () => {
		const service = Container.get(ObjectStoreService);

		await expect(service.init()).rejects.toThrow(S3_MESSAGE);
		await expect(service.init()).rejects.toBeInstanceOf(StorageUnavailableError);
	});

	it('fails the start of the Azure Blob client', async () => {
		const service = Container.get(AzureBlobService);

		await expect(service.init()).rejects.toThrow(AZURE_MESSAGE);
	});

	it('fails each operation of the S3 byte store', async () => {
		await expectEachOperationToFail(new S3ByteStore(new ObjectStoreService()), S3_MESSAGE);
	});

	it('fails each operation of the Azure Blob byte store', async () => {
		await expectEachOperationToFail(new AzureByteStore(new AzureBlobService()), AZURE_MESSAGE);
	});

	it('reports the missing storage as a user error', () => {
		expect(new StorageUnavailableError('S3')).toBeInstanceOf(UserError);
	});
});
