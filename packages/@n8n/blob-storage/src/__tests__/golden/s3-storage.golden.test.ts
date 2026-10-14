import { Logger } from '@n8n/backend-common';
import { Container } from '@n8n/di';
import dns from 'node:dns';
import { writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';

import { S3ByteStore } from '../..';
import { ObjectStoreConfig, ObjectStoreService } from '../../object-store';
import type { ByteStore } from '../../types';
import { FakeS3Server } from './fake-s3-server';
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
 * Fork golden test (not in upstream n8n). It records what the S3 storage does: the requests to an
 * S3 server, the results and the errors of each operation, and the logs. The snapshot comes from
 * the original enterprise classes, in a checkout of the upstream commit of
 * `scripts/sync-upstream.base`, through the ordinary index files of this package. The fork classes
 * must give the same snapshot. See `../../../FORK.md`.
 */

const BUCKET = 'n8n-golden';

const server = new FakeS3Server();
const proxy = new FakeProxy();
const logs: LogCall[] = [];
const lookups: string[] = [];
let restoreLookup: () => void;

type Overrides = {
	host?: string;
	protocol?: 'http' | 'https';
	forcePathStyle?: boolean;
	maxAttempts?: number;
	startupTimeoutMs?: number;
	bucket?: string;
	region?: string;
	accessKey?: string;
	accessSecret?: string;
	authAutoDetect?: boolean;
};

function makeService(overrides: Overrides = {}) {
	Container.reset();
	Container.set(Logger, createRecordingLogger(logs) as unknown as Logger);
	const config = Container.get(ObjectStoreConfig);
	config.host = overrides.host ?? `127.0.0.1:${server.port}`;
	config.protocol = overrides.protocol ?? 'http';
	config.forcePathStyle = overrides.forcePathStyle ?? true;
	config.maxAttempts = overrides.maxAttempts ?? 3;
	config.startupTimeoutMs = overrides.startupTimeoutMs ?? 10_000;
	config.bucket.name = overrides.bucket ?? BUCKET;
	config.bucket.region = overrides.region ?? 'us-east-1';
	config.credentials.accessKey = overrides.accessKey ?? 'AKIAGOLDEN';
	config.credentials.accessSecret = overrides.accessSecret ?? 'golden-secret';
	config.credentials.authAutoDetect = overrides.authAutoDetect ?? false;
	return Container.get(ObjectStoreService);
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
	server.buckets.clear();
	server.buckets.add(BUCKET);
	logs.length = 0;
});

describe('S3 storage', () => {
	it('starts the client', async () => {
		const transcript: Entry[] = [];
		const transcriptLookups: string[][] = [];
		await step(transcript, 'init', async () => await makeService().init());
		await step(transcript, 'init again on the same service', async () => {
			const service = Container.get(ObjectStoreService);
			await service.init();
		});
		server.buckets.clear();
		await step(transcript, 'init with a missing bucket', async () => await makeService().init());
		server.buckets.add(BUCKET);
		server.failures.push({ match: /.*/, status: 403, code: 'AccessDenied', times: 1 });
		await step(transcript, 'init with access denied', async () => await makeService().init());
		server.failures.push({ match: /.*/, status: 500, code: 'InternalError', times: 5 });
		await step(transcript, 'init with server errors', async () => await makeService().init());
		server.failures.push({ match: /.*/, hang: true, times: 5 });
		await step(
			transcript,
			'init with a server that does not answer',
			async () => await makeService({ startupTimeoutMs: 300 }).init(),
		);
		await step(
			transcript,
			'init with a region with a space',
			async () => await makeService({ region: 'us east 1' }).init(),
		);
		await step(
			transcript,
			'init with an empty region',
			async () => await makeService({ region: '' }).init(),
		);
		await step(
			transcript,
			'init with the region auto',
			async () => await makeService({ region: 'auto' }).init(),
		);
		await step(
			transcript,
			'init with a host with the protocol',
			async () => await makeService({ host: `http://127.0.0.1:${server.port}` }).init(),
		);
		await step(
			transcript,
			'init with virtual-hosted style',
			async () =>
				await makeService({ host: `localhost:${server.port}`, forcePathStyle: false }).init(),
		);
		process.env.AWS_ACCESS_KEY_ID = 'AKIAFROMENV';
		process.env.AWS_SECRET_ACCESS_KEY = 'secret-from-env';
		await step(
			transcript,
			'init with auto-detected credentials',
			async () =>
				await makeService({ authAutoDetect: true, accessKey: '', accessSecret: '' }).init(),
		);
		delete process.env.AWS_ACCESS_KEY_ID;
		delete process.env.AWS_SECRET_ACCESS_KEY;
		await step(
			transcript,
			'init without credentials',
			async () => await makeService({ accessKey: '', accessSecret: '' }).init(),
		);
		process.env.AWS_REGION = 'eu-west-1';
		await step(
			transcript,
			'init with an empty region and AWS_REGION',
			async () => await makeService({ region: '' }).init(),
		);
		delete process.env.AWS_REGION;
		server.failures.push({ match: /.*/, status: 500, code: 'InternalError', times: 5 });
		await step(
			transcript,
			'init with one attempt and server errors',
			async () => await makeService({ maxAttempts: 1 }).init(),
		);
		await step(transcript, 'init with an empty host', async () => {
			lookups.length = 0;
			try {
				await makeService({
					host: '',
					protocol: 'https',
					startupTimeoutMs: 2000,
					maxAttempts: 1,
				}).init();
			} finally {
				// Only the names, without the local ones.
				transcriptLookups.push([...new Set(lookups)].filter((name) => !name.endsWith('localhost')));
			}
		});
		await step(transcript, 'names looked up for the empty host', async () =>
			transcriptLookups.pop(),
		);
		await step(transcript, 'init through a proxy', async () => {
			proxy.requests.length = 0;
			await withProxy(proxy, async () => await makeService().init());
			return proxy.requests.splice(0);
		});
		await step(transcript, 'init with https through a proxy', async () => {
			proxy.requests.length = 0;
			try {
				await withProxy(
					proxy,
					async () => await makeService({ protocol: 'https', maxAttempts: 1 }).init(),
				);
			} finally {
				transcriptLookups.push(proxy.requests.splice(0));
			}
		});
		await step(transcript, 'proxy requests of the https start', async () =>
			transcriptLookups.pop(),
		);
		dump('init', transcript);
		expect(transcript).toMatchSnapshot();
	}, 120_000);

	it('writes, reads, copies, renames and deletes objects', async () => {
		const transcript: Entry[] = [];
		const service = makeService();
		await service.init();
		const store: ByteStore = new S3ByteStore(service);

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
		server.putObject(BUCKET, 'foreign/object', Buffer.from('foreign'), {
			contentType: 'image/png',
			metadata: { filename: 'plain-name.png', other: 'x' },
		});
		await step(
			transcript,
			'metadata of an object from elsewhere',
			async () => await store.getMetadata?.('foreign/object'),
		);
		server.putObject(BUCKET, 'foreign/encoded', Buffer.from('foreign'), {
			metadata: { filename: encodeURIComponent('ü ä.txt') },
		});
		await step(
			transcript,
			'metadata of an object with an encoded name',
			async () => await store.getMetadata?.('foreign/encoded'),
		);
		server.putObject(BUCKET, 'foreign/malformed', Buffer.from('foreign'), {
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
		await step(transcript, 'objects after the rename', async () => server.objectKeys());
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
		await step(transcript, 'objects after the delete', async () => server.objectKeys());
		await step(
			transcript,
			'delete the special key',
			async () => await store.delete(['custom/a b/ü+?#/binary_data/x']),
		);
		const many = Array.from(
			{ length: 1001 },
			(_, index) => `bulk/${String(index).padStart(4, '0')}`,
		);
		for (const key of many) server.putObject(BUCKET, key, Buffer.from('x'));
		server.answerDelayMs = 5;
		await step(transcript, 'delete 1001 keys', async () => {
			await store.delete(many);
			return server.objectKeys().filter((key) => key.includes('/bulk/')).length;
		});
		server.answerDelayMs = 0;
		if (store.deletePrefix) {
			await step(transcript, 'delete a prefix', async () => {
				await store.deletePrefix?.('workflows/1/executions/2/binary_data');
				return server.objectKeys();
			});
		}
		dump('operations', transcript);
		expect(transcript).toMatchSnapshot();
	}, 120_000);

	it('handles server errors', async () => {
		const transcript: Entry[] = [];
		const transcriptRest: number[] = [];
		const service = makeService();
		await service.init();
		const store: ByteStore = new S3ByteStore(service);
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
			code: 'AccessDenied',
			times: 1,
		});
		await step(transcript, 'read with access denied', async () => await store.read('k'));
		server.failures.push({
			match: /\/k$/,
			method: 'GET',
			status: 403,
			code: 'AccessDenied',
			times: 1,
		});
		await step(
			transcript,
			'read a stream with access denied',
			async () => await consume(await store.readStream('k')),
		);
		server.failures.push({ match: /\/k$/, method: 'GET', status: 500, times: 10 });
		await step(
			transcript,
			'read a stream with server errors',
			async () => await consume(await store.readStream('k')),
		);
		server.failures.push({
			match: /\/k$/,
			method: 'HEAD',
			status: 403,
			code: 'AccessDenied',
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
		server.failures.push({ match: /^\/n8n-golden\/$/, method: 'POST', status: 500, times: 10 });
		await step(transcript, 'delete with server errors', async () => await store.delete(['k']));
		const twoBatches = Array.from({ length: 1001 }, (_, index) => `batch/${index}`);
		for (const key of twoBatches) server.putObject(BUCKET, key, Buffer.from('x'));
		server.failures.push({ match: /^\/n8n-golden\/$/, method: 'POST', status: 500, times: 3 });
		await step(transcript, 'delete two batches when the first fails', async () => {
			try {
				await store.delete(twoBatches);
			} finally {
				transcriptRest.push(server.objectKeys().filter((key) => key.includes('/batch/')).length);
			}
		});
		await step(transcript, 'objects left of the two batches', async () => transcriptRest.pop());
		server.failures.push({ match: /\/k3$/, method: 'PUT', status: 500, times: 10 });
		await step(transcript, 'copy with server errors', async () => await store.copy('k', 'k3'));
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
		await step(transcript, 'objects after the failed rename', async () => server.objectKeys());
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
		server.deleteErrorKeys.add('k');
		server.putObject(BUCKET, 'z', Buffer.from('z'));
		await step(transcript, 'delete when the server keeps a key', async () => {
			await store.delete(['k', 'z']);
			return server.objectKeys().filter((key) => key.endsWith('/k') || key.endsWith('/z'));
		});
		const kept = Array.from({ length: 12 }, (_, index) => `kept/${index}`);
		for (const key of kept) {
			server.putObject(BUCKET, key, Buffer.from('x'));
			server.deleteErrorKeys.add(key);
		}
		await step(
			transcript,
			'delete when the server keeps 12 keys',
			async () => await store.delete(['z', ...kept]),
		);
		server.deleteErrorKeys.clear();
		server.failures.push({ match: /\/k$/, method: 'GET', hang: true, times: 1 });
		await step(
			transcript,
			'read with a server that does not answer',
			async () => await within(5000, async () => await store.read('k')),
		);
		server.buckets.clear();
		await step(transcript, 'read from a missing bucket', async () => await store.read('k'));
		await step(
			transcript,
			'read a stream from a missing bucket',
			async () => await store.readStream('k'),
		);
		await step(
			transcript,
			'metadata from a missing bucket',
			async () => await store.getMetadata?.('k'),
		);
		server.buckets.add(BUCKET);
		process.env.AWS_REQUEST_CHECKSUM_CALCULATION = 'WHEN_REQUIRED';
		process.env.AWS_RESPONSE_CHECKSUM_VALIDATION = 'WHEN_REQUIRED';
		await step(transcript, 'write and read with checksums only when required', async () => {
			const checksumService = makeService();
			await checksumService.init();
			const checksumStore = new S3ByteStore(checksumService);
			await checksumStore.write('k8', Buffer.from('checksums'), { mimeType: 'text/plain' });
			await checksumStore.delete(['k8']);
			return (await checksumStore.read('k')) !== null;
		});
		delete process.env.AWS_REQUEST_CHECKSUM_CALCULATION;
		delete process.env.AWS_RESPONSE_CHECKSUM_VALIDATION;
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
				await new S3ByteStore(proxiedService).write('k7', Buffer.from('proxied'));
			});
			return proxy.requests.splice(0);
		});
		dump('errors', transcript);
		expect(transcript).toMatchSnapshot();
	}, 120_000);
});
