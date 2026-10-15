// Fork test (not in upstream n8n): a bucket of Google Cloud Storage also starts the object store
// (packages/@n8n/blob-storage/FORK.md).
import { Logger } from '@n8n/backend-common';
import { mockInstance } from '@n8n/backend-test-utils';
import { GcsStorageConfig, ObjectStoreConfig, S3ByteStore } from '@n8n/blob-storage';
import { ObjectStoreService } from '@n8n/blob-storage/object-store';
import { Container } from '@n8n/di';

import { ExecutionDataJsonStore } from '@/executions/execution-data/execution-data-json-store';

import { BaseCommand } from '../base-command';

class TestCommand extends BaseCommand {
	async run() {}
}

mockInstance(Logger);
const objectStoreService = mockInstance(ObjectStoreService);
const executionDataJsonStore = mockInstance(ExecutionDataJsonStore);

describe('initObjectStoreIfConfigured', () => {
	const s3Config = Container.get(ObjectStoreConfig);
	const gcsConfig = Container.get(GcsStorageConfig);

	afterEach(() => {
		s3Config.bucket.name = '';
		gcsConfig.bucketName = '';
		vi.clearAllMocks();
	});

	it('starts the object store with a bucket of Google Cloud Storage', async () => {
		gcsConfig.bucketName = 'n8n-gcs';

		// @ts-expect-error Protected method
		const service: unknown = await new TestCommand().initObjectStoreIfConfigured();

		expect(service).toBe(objectStoreService);
		expect(objectStoreService.init).toHaveBeenCalledTimes(1);
		expect(executionDataJsonStore.registerByteStore).toHaveBeenCalledWith(
			's3',
			expect.any(S3ByteStore),
		);
	});

	it('starts the object store with an S3 bucket', async () => {
		s3Config.bucket.name = 'n8n-s3';

		// @ts-expect-error Protected method
		await new TestCommand().initObjectStoreIfConfigured();

		expect(objectStoreService.init).toHaveBeenCalledTimes(1);
	});

	it('starts no object store without a bucket', async () => {
		// @ts-expect-error Protected method
		const service: unknown = await new TestCommand().initObjectStoreIfConfigured();

		expect(service).toBeUndefined();
		expect(objectStoreService.init).not.toHaveBeenCalled();
		expect(executionDataJsonStore.registerByteStore).not.toHaveBeenCalled();
	});
});
