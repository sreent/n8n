import { Logger } from '@n8n/backend-common';
import { Container } from '@n8n/di';
import dns from 'node:dns';
import { writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';

import { AzureByteStore } from '../..';
import { AzureBlobConfig, AzureBlobService } from '../../azure-blob';
import type { ByteStore } from '../../types';
import { AZURITE_ACCOUNT, AZURITE_KEY, FakeAzureServer } from './fake-azure-server';
import type { LogCall } from './recording';
import {
	createRecordingLogger,
	describeError,
	describeValue,
	FakeProxy,
	resolveLocalhostSubdomains,
	withProxy,
} from './recording';

/**
 * Fork golden test (not in upstream n8n). It records what the Azure Blob storage does: the requests
 * to an Azure Blob server, the results and the errors of each operation, and the logs. The snapshot
 * comes from the original enterprise classes, in a checkout of the upstream commit of
 * `scripts/sync-upstream.base`, through the ordinary index files of this package. The fork classes
 * give the same snapshot, except in the steps "read a missing key" and "metadata of a missing key"
 * (see "Differences from the enterprise classes" in `../../../FORK.md`).
 */

const CONTAINER = 'n8n-golden';

const server = new FakeAzureServer();
const proxy = new FakeProxy();
const logs: LogCall[] = [];
const lookups: string[] = [];
let restoreLookup: () => void;

type Overrides = {
	connectionString?: string;
	accountName?: string;
	accountKey?: string;
	containerName?: string;
	endpoint?: string;
	authAutoDetect?: boolean;
};

function makeService(overrides: Overrides = {}) {
	Container.reset();
	Container.set(Logger, createRecordingLogger(logs) as unknown as Logger);
	const config = Container.get(AzureBlobConfig);
	config.connectionString = overrides.connectionString ?? server.connectionString;
	config.accountName = overrides.accountName ?? '';
	config.accountKey = overrides.accountKey ?? '';
	config.containerName = overrides.containerName ?? CONTAINER;
	config.endpoint = overrides.endpoint ?? '';
	config.authAutoDetect = overrides.authAutoDetect ?? false;
	return Container.get(AzureBlobService);
}

/** Fails when `run` takes longer than `ms`, so that a hanging call ends the step. */
async function within<T>(ms: number, run: () => Promise<T>) {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`still running after ${ms} ms`)), ms);
	});
	try {
		return await Promise.race([run(), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Reads a stream in flowing mode, so each chunk that the stream emits stays one chunk. Gives the
 * class of the stream, its size, the text of a small body, and the chunk sizes when a chunk size
 * was asked for.
 */
async function consume(stream: Readable | null, chunkSize?: number) {
	if (stream === null) return null;
	const chunks: number[] = [];
	const parts: Buffer[] = [];
	await new Promise<void>((resolve, reject) => {
		stream.on('data', (chunk: Buffer) => {
			chunks.push(chunk.length);
			parts.push(chunk);
		});
		stream.on('end', resolve);
		stream.on('error', reject);
	});
	const body = Buffer.concat(parts);
	return {
		class: stream.constructor.name,
		bytes: body.length,
		...(body.length <= 64 ? { text: body.toString('utf-8') } : {}),
		...(chunkSize === undefined
			? {}
			: { chunkCount: chunks.length, chunkSizes: [...new Set(chunks)] }),
	};
}

type Entry = Record<string, unknown>;

async function step(transcript: Entry[], name: string, run: () => Promise<unknown>) {
	server.take();
	logs.length = 0;
	let outcome: Entry;
	try {
		outcome = { result: describeValue(await run()) };
	} catch (error) {
		outcome = { error: describeError(error) };
	}
	server.failures.length = 0;
	const parallel = server.maxInFlight > 1;
	const requests = server.take();
	// Requests sent at the same time arrive in any order.
	if (parallel) {
		requests.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
	}
	transcript.push({
		step: name,
		...outcome,
		...(parallel ? { parallel } : {}),
		requests,
		logs: logs.splice(0, logs.length),
	});
}

const dump = (label: string, transcript: Entry[]) => {
	const file = process.env.GOLDEN_JSON;
	if (file) writeFileSync(`${file}.${label}.json`, JSON.stringify(transcript, null, 1));
};

beforeAll(async () => {
	// The Azure SDK reads NO_PROXY once, so the variables must not depend on the machine.
	for (const name of [
		'HTTP_PROXY',
		'HTTPS_PROXY',
		'http_proxy',
		'https_proxy',
		'ALL_PROXY',
		'NO_PROXY',
		'no_proxy',
	]) {
		delete process.env[name];
	}
	restoreLookup = resolveLocalhostSubdomains(dns, lookups);
	await server.start();
	await proxy.start();
});

afterAll(async () => {
	restoreLookup();
	await proxy.stop();
	await server.stop();
});

beforeEach(() => {
	server.reset();
	server.containers.clear();
	server.containers.add(CONTAINER);
	logs.length = 0;
});

describe('Azure Blob storage', () => {
	it('starts the client', async () => {
		const transcript: Entry[] = [];
		const transcriptLookups: string[][] = [];
		await step(transcript, 'init', async () => await makeService().init());
		await step(transcript, 'init again on the same service', async () => {
			const service = Container.get(AzureBlobService);
			await service.init();
		});
		server.containers.clear();
		await step(transcript, 'init with a missing container', async () => await makeService().init());
		await step(transcript, 'containers after the start', async () => [...server.containers]);
		server.containers.add(CONTAINER);
		server.failures.push({ match: /.*/, status: 403, code: 'AuthorizationFailure', times: 1 });
		await step(transcript, 'init with access denied', async () => await makeService().init());
		server.failures.push({ match: /.*/, status: 500, code: 'InternalError', times: 10 });
		await step(
			transcript,
			'init with server errors',
			async () => await within(30_000, async () => await makeService().init()),
		);
		await step(
			transcript,
			'init with an account name, a key and an endpoint',
			async () =>
				await makeService({
					connectionString: '',
					accountName: AZURITE_ACCOUNT,
					accountKey: AZURITE_KEY,
					endpoint: server.blobEndpoint,
				}).init(),
		);
		await step(transcript, 'init with an account name and a key', async () => {
			lookups.length = 0;
			try {
				await within(
					20_000,
					async () =>
						await makeService({
							connectionString: '',
							accountName: AZURITE_ACCOUNT,
							accountKey: AZURITE_KEY,
						}).init(),
				);
			} finally {
				transcriptLookups.push([...new Set(lookups)].filter((name) => !name.endsWith('localhost')));
			}
		});
		await step(transcript, 'names looked up for the default endpoint', async () =>
			transcriptLookups.pop(),
		);
		await step(
			transcript,
			'init with an account name only',
			async () =>
				await within(
					20_000,
					async () =>
						await makeService({
							connectionString: '',
							accountName: AZURITE_ACCOUNT,
							endpoint: server.blobEndpoint,
						}).init(),
				),
		);
		await step(transcript, 'init without credentials', async () => {
			lookups.length = 0;
			try {
				await within(20_000, async () => await makeService({ connectionString: '' }).init());
			} finally {
				transcriptLookups.push([...new Set(lookups)].filter((name) => !name.endsWith('localhost')));
			}
		});
		await step(transcript, 'names looked up without credentials', async () =>
			transcriptLookups.pop(),
		);
		await step(
			transcript,
			'init with a connection string and an account',
			async () =>
				await makeService({
					accountName: 'otheraccount',
					accountKey: AZURITE_KEY,
					endpoint: 'http://other.test',
				}).init(),
		);
		await step(
			transcript,
			'init with an invalid connection string',
			async () => await makeService({ connectionString: 'not a connection string' }).init(),
		);
		await step(
			transcript,
			'init with an empty container name',
			async () => await makeService({ containerName: '' }).init(),
		);
		await step(transcript, 'init through a proxy', async () => {
			proxy.requests.length = 0;
			await withProxy(proxy, async () => await makeService().init());
			return proxy.requests.splice(0);
		});
		dump('init', transcript);
		expect(transcript).toMatchSnapshot();
	}, 180_000);

	it('writes, reads, copies, renames and deletes objects', async () => {
		const transcript: Entry[] = [];
		const service = makeService();
		await service.init();
		const store: ByteStore = new AzureByteStore(service);

		await step(transcript, 'optional methods', async () => ({
			init: typeof store.init,
			getMetadata: typeof store.getMetadata,
			getAbsolutePath: typeof store.getAbsolutePath,
			deletePrefix: typeof store.deletePrefix,
		}));
		await step(
			transcript,
			'write a buffer with metadata',
			async () =>
				await store.write('workflows/1/executions/2/binary_data/a', Buffer.from('hello world'), {
					fileName: 'report ü #1.pdf',
					mimeType: 'application/pdf',
				}),
		);
		await step(
			transcript,
			'write a buffer without metadata',
			async () => await store.write('workflows/1/executions/2/binary_data/b', Buffer.from('plain')),
		);
		await step(
			transcript,
			'write a buffer with an empty file name and MIME type',
			async () =>
				await store.write('workflows/1/executions/2/binary_data/blank', Buffer.from('blank'), {
					fileName: '',
					mimeType: '',
				}),
		);
		await step(
			transcript,
			'metadata of the buffer with empty names',
			async () => await store.getMetadata?.('workflows/1/executions/2/binary_data/blank'),
		);
		await step(
			transcript,
			'write an empty buffer',
			async () => await store.write('workflows/1/executions/2/binary_data/empty', Buffer.alloc(0)),
		);
		await step(
			transcript,
			'write a stream',
			async () =>
				await store.write(
					'workflows/1/executions/2/binary_data/c',
					Readable.from([Buffer.from('abc'), Buffer.from('defg'), Buffer.from('hij')]),
					{ fileName: 'c.txt', mimeType: 'text/plain' },
				),
		);
		await step(
			transcript,
			'write a large stream',
			async () =>
				await store.write(
					'workflows/1/executions/2/binary_data/large',
					Readable.from(
						Array.from({ length: 7 }, (_, index) => Buffer.alloc(1024 * 1024, index + 65)),
					),
					{ fileName: 'large.bin' },
				),
		);
		await step(
			transcript,
			'write a stream that fails',
			async () =>
				await store.write(
					'workflows/1/executions/2/binary_data/broken',
					new Readable({
						read() {
							this.destroy(new Error('source broke'));
						},
					}),
				),
		);
		await step(
			transcript,
			'write a key with special characters',
			async () =>
				await store.write('custom/a b/ü+?#/binary_data/x', Buffer.from('special'), {
					mimeType: 'text/plain; charset=utf-8',
				}),
		);
		await step(transcript, 'read', async () =>
			(await store.read('workflows/1/executions/2/binary_data/a'))?.toString('utf-8'),
		);
		await step(
			transcript,
			'read an empty object',
			async () => (await store.read('workflows/1/executions/2/binary_data/empty'))?.length,
		);
		await step(
			transcript,
			'read a stream of an empty object',
			async () =>
				await consume(await store.readStream('workflows/1/executions/2/binary_data/empty')),
		);
		await step(
			transcript,
			'metadata of an empty object',
			async () => await store.getMetadata?.('workflows/1/executions/2/binary_data/empty'),
		);
		await step(
			transcript,
			'read a missing key',
			async () => await store.read('workflows/1/executions/2/binary_data/missing'),
		);
		await step(transcript, 'read the special key', async () =>
			(await store.read('custom/a b/ü+?#/binary_data/x'))?.toString('utf-8'),
		);
		await step(
			transcript,
			'read a stream',
			async () => await consume(await store.readStream('workflows/1/executions/2/binary_data/c')),
		);
		await step(
			transcript,
			'read a stream in chunks of 4 bytes',
			async () =>
				await consume(
					await store.readStream('workflows/1/executions/2/binary_data/c', { chunkSize: 4 }),
					4,
				),
		);
		await step(
			transcript,
			'read a large stream in chunks of 64 KiB',
			async () =>
				await consume(
					await store.readStream('workflows/1/executions/2/binary_data/large', {
						chunkSize: 65536,
					}),
					65536,
				),
		);
		await step(
			transcript,
			'read a large stream in chunks of 1000 bytes',
			async () =>
				await consume(
					await store.readStream('workflows/1/executions/2/binary_data/large', { chunkSize: 1000 }),
					1000,
				),
		);
		await step(
			transcript,
			'read a stream of a missing key',
			async () => await store.readStream('workflows/1/executions/2/binary_data/missing'),
		);
		await step(
			transcript,
			'read a stream with a chunk size of 0',
			async () =>
				await store.readStream('workflows/1/executions/2/binary_data/c', { chunkSize: 0 }),
		);
		await step(
			transcript,
			'read a stream with a chunk size of 1.5',
			async () =>
				await store.readStream('workflows/1/executions/2/binary_data/c', { chunkSize: 1.5 }),
		);
		await step(
			transcript,
			'metadata',
			async () => await store.getMetadata?.('workflows/1/executions/2/binary_data/a'),
		);
		await step(
			transcript,
			'metadata without names',
			async () => await store.getMetadata?.('workflows/1/executions/2/binary_data/b'),
		);
		await step(
			transcript,
			'metadata of the stream',
			async () => await store.getMetadata?.('workflows/1/executions/2/binary_data/c'),
		);
		await step(
			transcript,
			'metadata of a missing key',
			async () => await store.getMetadata?.('workflows/1/executions/2/binary_data/missing'),
		);
		server.putBlob(CONTAINER, 'foreign/object', Buffer.from('foreign'), {
			contentType: 'image/png',
			metadata: { filename: 'plain-name.png', other: 'x' },
		});
		await step(
			transcript,
			'metadata of an object from elsewhere',
			async () => await store.getMetadata?.('foreign/object'),
		);
		server.putBlob(CONTAINER, 'foreign/encoded', Buffer.from('foreign'), {
			metadata: { filename: encodeURIComponent('ü ä.txt') },
		});
		await step(
			transcript,
			'metadata of an object with an encoded name',
			async () => await store.getMetadata?.('foreign/encoded'),
		);
		server.putBlob(CONTAINER, 'foreign/malformed', Buffer.from('foreign'), {
			metadata: { filename: '%E0%A4%A' },
		});
		await step(
			transcript,
			'metadata of an object with a malformed encoded name',
			async () => await store.getMetadata?.('foreign/malformed'),
		);
		await step(
			transcript,
			'copy',
			async () =>
				await store.copy(
					'workflows/1/executions/2/binary_data/a',
					'workflows/1/executions/3/binary_data/a',
				),
		);
		await step(
			transcript,
			'metadata of the copy',
			async () => await store.getMetadata?.('workflows/1/executions/3/binary_data/a'),
		);
		await step(
			transcript,
			'copy the special key',
			async () => await store.copy('custom/a b/ü+?#/binary_data/x', 'custom/copy/binary_data/x'),
		);
		await step(
			transcript,
			'copy a missing key',
			async () =>
				await store.copy('workflows/1/executions/2/binary_data/missing', 'somewhere/else'),
		);
		await step(
			transcript,
			'rename',
			async () =>
				await store.rename(
					'workflows/1/executions/3/binary_data/a',
					'workflows/1/executions/4/binary_data/a',
				),
		);
		await step(transcript, 'objects after the rename', async () => server.blobNames());
		await step(
			transcript,
			'rename to the same key',
			async () =>
				await store.rename(
					'workflows/1/executions/4/binary_data/a',
					'workflows/1/executions/4/binary_data/a',
				),
		);
		await step(
			transcript,
			'rename a missing key to the same key',
			async () => await store.rename('missing/key', 'missing/key'),
		);
		await step(
			transcript,
			'rename a missing key',
			async () => await store.rename('missing/key', 'other/key'),
		);
		await step(transcript, 'delete no keys', async () => await store.delete([]));
		await step(
			transcript,
			'delete two keys and a missing key',
			async () =>
				await store.delete([
					'workflows/1/executions/2/binary_data/a',
					'workflows/1/executions/2/binary_data/b',
					'workflows/1/executions/2/binary_data/missing',
				]),
		);
		await step(transcript, 'objects after the delete', async () => server.blobNames());
		await step(
			transcript,
			'delete the special key',
			async () => await store.delete(['custom/a b/ü+?#/binary_data/x']),
		);
		const many = Array.from(
			{ length: 1001 },
			(_, index) => `bulk/${String(index).padStart(4, '0')}`,
		);
		for (const key of many) server.putBlob(CONTAINER, key, Buffer.from('x'));
		server.answerDelayMs = 5;
		await step(transcript, 'delete 1001 keys', async () => {
			await store.delete(many);
			return server.blobNames().filter((key) => key.includes('/bulk/')).length;
		});
		server.answerDelayMs = 0;
		if (store.deletePrefix) {
			await step(transcript, 'delete a prefix', async () => {
				await store.deletePrefix?.('workflows/1/executions/2/binary_data');
				return server.blobNames();
			});
		}
		dump('operations', transcript);
		expect(transcript).toMatchSnapshot();
	}, 120_000);

	it('handles server errors', async () => {
		const transcript: Entry[] = [];
		const service = makeService();
		await service.init();
		const store: ByteStore = new AzureByteStore(service);
		await store.write('k', Buffer.from('value'), { fileName: 'k.txt', mimeType: 'text/plain' });

		server.failures.push({ match: /\/k$/, method: 'GET', status: 500, times: 1 });
		await step(transcript, 'read after one server error', async () =>
			(await store.read('k'))?.toString('utf-8'),
		);
		server.failures.push({ match: /\/k$/, method: 'GET', status: 500, times: 10 });
		await step(transcript, 'read with server errors', async () => await store.read('k'));
		server.failures.push({
			match: /\/k$/,
			method: 'GET',
			status: 403,
			code: 'AuthorizationPermissionMismatch',
			times: 1,
		});
		await step(transcript, 'read with access denied', async () => await store.read('k'));
		server.failures.push({
			match: /\/k$/,
			method: 'GET',
			status: 403,
			code: 'AuthorizationPermissionMismatch',
			times: 1,
		});
		await step(
			transcript,
			'read a stream with access denied',
			async () => await consume(await store.readStream('k')),
		);
		server.failures.push({
			match: /\/k$/,
			method: 'HEAD',
			status: 403,
			code: 'AuthorizationPermissionMismatch',
			times: 1,
		});
		await step(
			transcript,
			'metadata with access denied',
			async () => await store.getMetadata?.('k'),
		);
		server.failures.push({ match: /\/k2$/, method: 'PUT', status: 500, times: 10 });
		await step(
			transcript,
			'write with server errors',
			async () => await store.write('k2', Buffer.from('value')),
		);
		server.failures.push({ match: /\/k$/, method: 'DELETE', status: 500, times: 10 });
		await step(transcript, 'delete with server errors', async () => await store.delete(['k']));
		server.putBlob(CONTAINER, 'x', Buffer.from('x'));
		server.putBlob(CONTAINER, 'y', Buffer.from('y'));
		server.failures.push({ match: /\/x$/, method: 'DELETE', status: 500, times: 10 });
		await step(
			transcript,
			'delete three keys when one fails',
			async () => await store.delete(['k', 'x', 'y']),
		);
		await step(transcript, 'blobs after the failed delete', async () => server.blobNames());
		server.putBlob(CONTAINER, 'k', Buffer.from('value'), {
			contentType: 'text/plain',
			metadata: { filename: 'k.txt' },
		});
		server.failures.push({ match: /\/k$/, method: 'HEAD', status: 500, times: 10 });
		await step(
			transcript,
			'copy with server errors on the metadata',
			async () => await store.copy('k', 'k4'),
		);
		server.failures.push({ match: /\/k$/, method: 'DELETE', status: 500, times: 10 });
		await step(
			transcript,
			'rename with server errors on the delete',
			async () => await store.rename('k', 'k5'),
		);
		await step(transcript, 'objects after the failed rename', async () => server.blobNames());
		server.failures.push({ match: /\/k$/, method: 'GET', truncate: true, times: 1 });
		await step(
			transcript,
			'read a stream that the server cuts off',
			async () => await consume(await store.readStream('k')),
		);
		server.failures.push({ match: /\/k$/, method: 'GET', truncate: true, times: 1 });
		await step(
			transcript,
			'read in chunks a stream that the server cuts off',
			async () => await consume(await store.readStream('k', { chunkSize: 2 }), 2),
		);
		server.failures.push({ match: /\/k$/, method: 'GET', truncate: true, times: 1 });
		await step(
			transcript,
			'read a buffer that the server cuts off',
			async () => await store.read('k'),
		);
		server.failures.push({ match: /\/k$/, method: 'GET', hang: true, times: 1 });
		await step(
			transcript,
			'read a stream with a server that does not answer',
			async () => await within(5000, async () => await consume(await store.readStream('k'))),
		);
		server.containers.clear();
		await step(transcript, 'read from a missing container', async () => await store.read('k'));
		await step(
			transcript,
			'read a stream from a missing container',
			async () => await store.readStream('k'),
		);
		await step(
			transcript,
			'metadata from a missing container',
			async () => await store.getMetadata?.('k'),
		);
		server.containers.add(CONTAINER);
		await step(transcript, 'write through a proxy', async () => {
			proxy.requests.length = 0;
			await withProxy(proxy, async () => await store.write('k6', Buffer.from('proxied')));
			return proxy.requests.splice(0);
		});
		await step(transcript, 'write through a proxy with a new store', async () => {
			proxy.requests.length = 0;
			await withProxy(proxy, async () => {
				const proxiedService = makeService();
				await proxiedService.init();
				await new AzureByteStore(proxiedService).write('k7', Buffer.from('proxied'));
			});
			return proxy.requests.splice(0);
		});
		dump('errors', transcript);
		expect(transcript).toMatchSnapshot();
		// The Azure SDK waits seconds between its retries.
	}, 300_000);
});
