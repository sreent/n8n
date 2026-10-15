import { Logger } from '@n8n/backend-common';
import { Container } from '@n8n/di';
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer as readAll } from 'node:stream/consumers';

import { GcsStorageConfig, S3ByteStore } from '../..';
import { ObjectStoreConfig, ObjectStoreService } from '../../object-store';
import type { LogCall } from '../golden/recording';
import { createRecordingLogger } from '../golden/recording';
import type { GcsRequest } from './fake-gcs-server';
import { FakeGcsServer, FakeTunnelProxy } from './fake-gcs-server';

/**
 * Fork test (not in upstream n8n): the native Google Cloud Storage of the object store, against a
 * fake server of the JSON API, the token endpoint and the metadata server. See `../../../FORK.md`.
 */

const BUCKET = 'n8n-gcs';
const CLIENT_EMAIL = 'n8n-storage@acme-project.iam.gserviceaccount.com';
const KEY = 'workflows/wf-1/executions/7/binary_data/0b4c';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** The variables that the tests change. The proxy variables of the machine must not apply. */
const VARIABLES = [
	'GOOGLE_APPLICATION_CREDENTIALS',
	'GCE_METADATA_HOST',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'http_proxy',
	'https_proxy',
	'NO_PROXY',
	'no_proxy',
];

const server = new FakeGcsServer();
const proxy = new FakeTunnelProxy();
const logs: LogCall[] = [];
let savedVariables: Record<string, string | undefined> = {};

const md5 = (content: Buffer) => createHash('md5').update(content).digest('base64');

const decodeJwtPart = (part: string): unknown =>
	JSON.parse(Buffer.from(part, 'base64url').toString());

function serviceAccountKey(clientEmail = CLIENT_EMAIL) {
	return JSON.stringify({
		type: 'service_account',
		project_id: 'acme-project',
		private_key_id: 'key-1',
		private_key: privateKey,
		client_email: clientEmail,
		token_uri: `${server.endpoint}/token`,
	});
}

type Overrides = {
	bucket?: string;
	credentials?: string;
	apiEndpoint?: string;
	maxAttempts?: number;
	startupTimeoutMs?: number;
	s3Bucket?: string;
};

function makeService(overrides: Overrides = {}) {
	Container.reset();
	Container.set(Logger, createRecordingLogger(logs) as unknown as Logger);
	Container.get(ObjectStoreConfig).bucket.name = overrides.s3Bucket ?? '';
	const config = Container.get(GcsStorageConfig);
	config.bucketName = overrides.bucket ?? BUCKET;
	config.credentials = overrides.credentials ?? serviceAccountKey();
	config.apiEndpoint = overrides.apiEndpoint ?? server.endpoint;
	config.maxAttempts = overrides.maxAttempts ?? 3;
	config.startupTimeoutMs = overrides.startupTimeoutMs ?? 10_000;
	return Container.get(ObjectStoreService);
}

async function makeStore(overrides: Overrides = {}) {
	const service = makeService(overrides);
	await service.init();
	server.take();
	logs.length = 0;
	return { service, store: new S3ByteStore(service) };
}

const summary = (requests: GcsRequest[]) => requests.map(({ method, path }) => `${method} ${path}`);

const tokenRequests = (requests: GcsRequest[]) =>
	requests.filter((request) => request.path === '/token');

/** The size of each chunk of a stream, read in flowing mode so that each chunk stays one chunk. */
async function chunkSizes(stream: Readable) {
	const sizes: number[] = [];
	await new Promise<void>((resolve, reject) => {
		stream.on('data', (chunk: Buffer) => sizes.push(chunk.length));
		stream.on('end', resolve);
		stream.on('error', reject);
	});
	return sizes;
}

/** A port where no server listens. */
async function closedPort() {
	const probe = http.createServer();
	await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
	const address = probe.address();
	const port = address && typeof address === 'object' ? address.port : 0;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

beforeAll(async () => {
	savedVariables = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
	await server.start();
	await proxy.start();
	server.buckets.add(BUCKET);
});

beforeEach(() => {
	for (const name of VARIABLES) delete process.env[name];
	server.take();
	server.objects.clear();
	server.failures.length = 0;
	server.tokenAnswer = { access_token: 'token-1', expires_in: 3600 };
	proxy.targets.length = 0;
	logs.length = 0;
});

afterAll(async () => {
	await server.stop();
	await proxy.stop();
	for (const [name, value] of Object.entries(savedVariables)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe('start-up', () => {
	it('signs in with the key of a service account and lists one object of the bucket', async () => {
		await makeService().init();

		const [tokenRequest, check, ...rest] = server.take();
		expect(rest).toEqual([]);
		expect(tokenRequest).toMatchObject({
			method: 'POST',
			path: '/token',
			contentType: 'application/x-www-form-urlencoded',
		});
		const form = tokenRequest.body as Record<string, string>;
		expect(form.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
		const [header, claims, signature] = form.assertion.split('.');
		expect(decodeJwtPart(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
		const payload = decodeJwtPart(claims) as Record<string, unknown> & { iat: number; exp: number };
		expect(payload).toMatchObject({
			iss: CLIENT_EMAIL,
			scope: 'https://www.googleapis.com/auth/devstorage.read_write',
			aud: `${server.endpoint}/token`,
		});
		expect(payload.exp - payload.iat).toBe(3600);
		expect(Math.abs(payload.iat - Date.now() / 1000)).toBeLessThan(60);
		const verifier = createVerify('RSA-SHA256').update(`${header}.${claims}`);
		expect(verifier.verify(publicKey, signature, 'base64url')).toBe(true);

		expect(check).toEqual({
			method: 'GET',
			path: '/storage/v1/b/n8n-gcs/o',
			query: { maxResults: '1', fields: 'kind' },
			authorization: 'Bearer token-1',
		});
		expect(logs).toEqual([
			{
				level: 'info',
				scopes: [],
				message: `Google Cloud Storage configured: endpoint=http://127.0.0.1:PORT, bucket=n8n-gcs, credentials=the service account ${CLIENT_EMAIL}`,
				metadata: {},
			},
		]);
	});

	it('reads the key file in GOOGLE_APPLICATION_CREDENTIALS', async () => {
		const folder = mkdtempSync(join(tmpdir(), 'n8n-gcs-test-'));
		try {
			const keyFile = join(folder, 'key.json');
			writeFileSync(
				keyFile,
				serviceAccountKey('file-account@acme-project.iam.gserviceaccount.com'),
			);
			process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFile;

			await makeService({ credentials: '' }).init();

			const [tokenRequest] = server.take();
			const form = tokenRequest.body as Record<string, string>;
			expect(decodeJwtPart(form.assertion.split('.')[1])).toMatchObject({
				iss: 'file-account@acme-project.iam.gserviceaccount.com',
			});
			expect(logs[0].message).toContain(
				'credentials=the service account file-account@acme-project.iam.gserviceaccount.com',
			);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it('uses the service account of the metadata server without a key', async () => {
		process.env.GCE_METADATA_HOST = `127.0.0.1:${server.port}`;

		await makeService({ credentials: '' }).init();

		expect(server.take()).toEqual([
			{
				method: 'GET',
				path: '/computeMetadata/v1/instance/service-accounts/default/token',
				query: {},
				metadataFlavor: 'Google',
			},
			{
				method: 'GET',
				path: '/storage/v1/b/n8n-gcs/o',
				query: { maxResults: '1', fields: 'kind' },
				authorization: 'Bearer metadata-token',
			},
		]);
		expect(logs[0].message).toContain('credentials=the service account of the metadata server');
	});

	it('fails when the bucket does not exist', async () => {
		const service = makeService({ bucket: 'missing-bucket' });

		const message =
			'Failed to connect to Google Cloud Storage at http://127.0.0.1:PORT (bucket: missing-bucket): 404 The specified bucket does not exist. Check the name of the bucket, and that the service account has the role Storage Object User or Storage Object Admin on the bucket.';
		await expect(service.init()).rejects.toThrow(message.replace('PORT', String(server.port)));
		expect(logs.at(-1)).toMatchObject({ level: 'error', message });
		expect(summary(server.take())).toEqual(['POST /token', 'GET /storage/v1/b/missing-bucket/o']);
	});

	it('fails when the token endpoint refuses the key', async () => {
		server.tokenAnswer = null;
		const service = makeService();

		const message = `Failed to get an access token for Google Cloud Storage from the service account ${CLIENT_EMAIL}: status 400: {"error":"invalid_grant"}`;
		await expect(service.init()).rejects.toThrow(message);
		expect(logs.at(-1)).toMatchObject({ level: 'error', message });
		expect(summary(server.take())).toEqual(['POST /token']);
	});

	it('fails when the credentials are not the key of a service account', async () => {
		await expect(makeService({ credentials: 'not json' }).init()).rejects.toThrow(
			'Failed to read the credentials of Google Cloud Storage: N8N_EXTERNAL_STORAGE_GCS_CREDENTIALS is not the JSON key of a service account',
		);
		await expect(makeService({ credentials: '{"client_email":"a@b.c"}' }).init()).rejects.toThrow(
			'N8N_EXTERNAL_STORAGE_GCS_CREDENTIALS is not the JSON key of a service account: it needs client_email and private_key',
		);
		process.env.GOOGLE_APPLICATION_CREDENTIALS = join(tmpdir(), 'n8n-gcs-missing-key.json');
		await expect(makeService({ credentials: '' }).init()).rejects.toThrow(
			'Failed to read the credentials of Google Cloud Storage: ENOENT',
		);
		expect(logs.filter((log) => log.level === 'error')).toHaveLength(3);
		expect(server.take()).toEqual([]);
	});

	it('fails when the endpoint does not answer', async () => {
		const port = await closedPort();
		const service = makeService({ apiEndpoint: `http://127.0.0.1:${port}`, maxAttempts: 1 });

		await expect(service.init()).rejects.toThrow(
			`Failed to connect to Google Cloud Storage at http://127.0.0.1:${port} (bucket: n8n-gcs): connect ECONNREFUSED 127.0.0.1:${port}. Check the name of the bucket`,
		);
	});

	it('stops the check of the bucket after the startup timeout', async () => {
		server.failures.push({
			match: (request) => request.path.endsWith('/o'),
			delayMs: 1000,
			count: 1,
		});
		const service = makeService({ startupTimeoutMs: 100 });

		await expect(service.init()).rejects.toThrow(
			`Failed to connect to Google Cloud Storage at ${server.endpoint} (bucket: n8n-gcs): no answer within 100 ms. Check`,
		);
	});

	it('refuses an S3 bucket and a GCS bucket together', async () => {
		const message =
			'Set either N8N_EXTERNAL_STORAGE_S3_BUCKET_NAME or N8N_EXTERNAL_STORAGE_GCS_BUCKET_NAME, not both.';
		await expect(makeService({ s3Bucket: 'n8n-s3' }).init()).rejects.toThrow(message);
		expect(logs.at(-1)).toMatchObject({ level: 'error', message });
		expect(server.take()).toEqual([]);
	});

	it('sends the requests through the proxy of the environment', async () => {
		process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;

		const { store } = await makeStore();
		await store.write(KEY, Buffer.from('through the proxy'));

		expect(proxy.targets).toContain(`127.0.0.1:${server.port}`);
		expect(server.objects.get(`${BUCKET}/${KEY}`)?.body.toString()).toBe('through the proxy');
	});

	it('asks the metadata server without the proxy', async () => {
		const metadataServer = new FakeGcsServer();
		await metadataServer.start();
		try {
			process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
			process.env.GCE_METADATA_HOST = `127.0.0.1:${metadataServer.port}`;

			await makeService({ credentials: '' }).init();

			expect(summary(metadataServer.take())).toEqual([
				'GET /computeMetadata/v1/instance/service-accounts/default/token',
			]);
			expect(proxy.targets).toContain(`127.0.0.1:${server.port}`);
			expect(proxy.targets).not.toContain(`127.0.0.1:${metadataServer.port}`);
		} finally {
			await metadataServer.stop();
		}
	});
});

describe('objects', () => {
	it('writes an object with its file name and MIME type, and reads it', async () => {
		const { store } = await makeStore();
		const content = Buffer.from('hello from n8n');

		const size = await store.write(KEY, content, {
			fileName: 'Report ä 1.pdf',
			mimeType: 'application/pdf',
		});

		expect(size).toBe(content.length);
		const [upload, ...rest] = server.take();
		expect(rest).toEqual([]);
		expect(upload).toMatchObject({
			method: 'POST',
			path: '/upload/storage/v1/b/n8n-gcs/o',
			query: { uploadType: 'multipart' },
			authorization: 'Bearer token-1',
			body: {
				name: KEY,
				contentType: 'application/pdf',
				md5Hash: md5(content),
				metadata: { filename: 'Report%20%C3%A4%201.pdf' },
			},
			content: 'hello from n8n',
		});
		expect(upload.contentType).toMatch(/^multipart\/related; boundary=[0-9a-f-]{36}$/);

		expect(await store.read(KEY)).toEqual(content);
		expect(await store.getMetadata(KEY)).toEqual({
			fileSize: content.length,
			mimeType: 'application/pdf',
			fileName: 'Report ä 1.pdf',
		});
		const [download, metadata] = server.take();
		expect(download).toMatchObject({
			method: 'GET',
			path: '/storage/v1/b/n8n-gcs/o/workflows%2Fwf-1%2Fexecutions%2F7%2Fbinary_data%2F0b4c',
			query: { alt: 'media' },
		});
		expect(metadata).toMatchObject({
			method: 'GET',
			path: download.path,
			query: { fields: 'size,contentType,metadata' },
		});
	});

	it('writes a stream, and an object without metadata as application/octet-stream', async () => {
		const { store } = await makeStore();

		const size = await store.write(KEY, Readable.from([Buffer.from('ab'), Buffer.from('cd')]));

		expect(size).toBe(4);
		const [upload] = server.take();
		expect(upload.body).toEqual({
			name: KEY,
			contentType: 'application/octet-stream',
			md5Hash: md5(Buffer.from('abcd')),
		});
		expect(await store.getMetadata(KEY)).toEqual({
			fileSize: 4,
			mimeType: 'application/octet-stream',
		});
	});

	it('encodes the special characters of an object name', async () => {
		const { store } = await makeStore();
		const key = "a/it's (1)*!.txt";

		await store.write(key, Buffer.from('special'));
		expect((await store.read(key))?.toString()).toBe('special');

		const [upload, download] = server.take();
		expect(upload.body).toMatchObject({ name: key });
		expect(download.path).toBe('/storage/v1/b/n8n-gcs/o/a%2Fit%27s%20%281%29%2A%21.txt');
		expect([...server.objects.keys()]).toEqual([`${BUCKET}/${key}`]);
	});

	it('keeps a line break of a MIME type out of the multipart headers', async () => {
		const { store } = await makeStore();

		await store.write(KEY, Buffer.from('text'), { mimeType: 'text/plain\r\nX-Extra: 1' });

		expect(server.objects.get(`${BUCKET}/${KEY}`)?.body.toString()).toBe('text');
	});

	it('streams an object, also in chunks of a fixed size', async () => {
		const { store } = await makeStore();
		await store.write(KEY, Buffer.from('0123456789'));

		const stream = await store.readStream(KEY);
		expect(stream && (await readAll(stream)).toString()).toBe('0123456789');

		const chunked = await store.readStream(KEY, { chunkSize: 4 });
		expect(chunked && (await chunkSizes(chunked))).toEqual([4, 4, 2]);
	});

	it('copies, renames and deletes objects', async () => {
		const { store } = await makeStore();
		await store.write('a/source', Buffer.from('data'), {
			fileName: 'a.txt',
			mimeType: 'text/plain',
		});

		await store.copy('a/source', 'a/copy');
		expect(await store.getMetadata('a/copy')).toEqual({
			fileSize: 4,
			mimeType: 'text/plain',
			fileName: 'a.txt',
		});

		await store.rename('a/copy', 'a/renamed');
		expect(await store.read('a/copy')).toBeNull();
		expect((await store.read('a/renamed'))?.toString()).toBe('data');

		server.take();
		logs.length = 0;
		await store.delete(['a/source', 'a/renamed', 'a/missing']);
		expect([...server.objects.keys()]).toEqual([]);
		expect(summary(server.take()).sort()).toEqual([
			'DELETE /storage/v1/b/n8n-gcs/o/a%2Fmissing',
			'DELETE /storage/v1/b/n8n-gcs/o/a%2Frenamed',
			'DELETE /storage/v1/b/n8n-gcs/o/a%2Fsource',
		]);
		expect(logs).toEqual([
			{
				level: 'debug',
				scopes: [],
				message: 'Deleting objects from Google Cloud Storage',
				metadata: { objectCount: 3 },
			},
		]);
	});

	it('deletes many objects in groups', async () => {
		const { service, store } = await makeStore();
		const keys = Array.from({ length: 70 }, (_, index) => `many/${index}`);
		for (const key of keys) server.objects.set(`${BUCKET}/${key}`, { body: Buffer.from('x') });

		await store.delete(keys);

		expect(server.objects.size).toBe(0);
		expect(server.take()).toHaveLength(70);
		await service.deleteOne('many/0');
		expect(summary(server.take())).toEqual(['DELETE /storage/v1/b/n8n-gcs/o/many%2F0']);
	});

	it('gives null for a missing object, and a missing-object error for a direct read', async () => {
		const { service, store } = await makeStore();

		expect(await store.read('missing')).toBeNull();
		expect(await store.readStream('missing')).toBeNull();
		expect(await store.getMetadata('missing')).toBeNull();

		const error: unknown = await service.getBuffer('missing').catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			'Request to Google Cloud Storage failed: 404 No such object.',
		);
		expect(service.isMissingObject(error)).toBe(true);
		expect(service.isMissingObject(new Error('other'))).toBe(false);
	});
});

describe('retries and tokens', () => {
	const isDownload = (request: GcsRequest) => request.query.alt === 'media';

	it('retries a temporary error status', async () => {
		const { store } = await makeStore();
		server.objects.set(`${BUCKET}/${KEY}`, { body: Buffer.from('data') });
		server.failures.push({ match: isDownload, status: 503, count: 2 });

		expect((await store.read(KEY))?.toString()).toBe('data');
		expect(server.take().filter(isDownload)).toHaveLength(3);
	});

	it('retries a closed connection', async () => {
		const { store } = await makeStore();
		server.objects.set(`${BUCKET}/${KEY}`, { body: Buffer.from('data') });
		server.failures.push({ match: isDownload, reset: true, count: 1 });

		expect((await store.read(KEY))?.toString()).toBe('data');
		expect(server.take().filter(isDownload)).toHaveLength(2);
	});

	it('stops after the last attempt', async () => {
		const { store } = await makeStore({ maxAttempts: 2 });
		server.objects.set(`${BUCKET}/${KEY}`, { body: Buffer.from('data') });
		server.failures.push({ match: isDownload, status: 503, count: 5 });

		await expect(store.read(KEY)).rejects.toThrow(
			'Request to Google Cloud Storage failed: 503 Injected failure.',
		);
		expect(server.take().filter(isDownload)).toHaveLength(2);
	});

	it('does not retry a permanent error status', async () => {
		const { store } = await makeStore();
		server.objects.set(`${BUCKET}/${KEY}`, { body: Buffer.from('data') });
		server.failures.push({ match: isDownload, status: 403, count: 1 });

		await expect(store.read(KEY)).rejects.toThrow(
			'Request to Google Cloud Storage failed: 403 Injected failure.',
		);
		expect(server.take().filter(isDownload)).toHaveLength(1);
	});

	it('uses one access token for many requests', async () => {
		const service = makeService();
		await service.init();
		const store = new S3ByteStore(service);
		await store.write(KEY, Buffer.from('data'));
		await store.read(KEY);
		await store.delete([KEY]);

		expect(tokenRequests(server.take())).toHaveLength(1);
	});

	it('gets a new access token when the token expires within five minutes', async () => {
		server.tokenAnswer = { access_token: 'short', expires_in: 120 };
		const service = makeService();
		await service.init();
		expect(tokenRequests(server.take())).toHaveLength(2);
		server.objects.set(`${BUCKET}/a`, { body: Buffer.from('a') });
		server.objects.set(`${BUCKET}/b`, { body: Buffer.from('b') });

		// Requests at the same time share one token request.
		await Promise.all([service.getBuffer('a'), service.getBuffer('b')]);

		expect(tokenRequests(server.take())).toHaveLength(1);
	});

	it('retries a failed token request', async () => {
		server.tokenAnswer = { access_token: 'short', expires_in: 120 };
		const { store } = await makeStore();
		server.objects.set(`${BUCKET}/${KEY}`, { body: Buffer.from('data') });
		server.failures.push({ match: (request) => request.path === '/token', status: 500, count: 1 });

		expect((await store.read(KEY))?.toString()).toBe('data');
		expect(summary(server.take())).toEqual([
			'POST /token',
			'POST /token',
			`GET /storage/v1/b/n8n-gcs/o/${encodeURIComponent(KEY)}`,
		]);

		server.tokenAnswer = null;
		await expect(store.read(KEY)).rejects.toThrow(
			`Failed to get an access token for Google Cloud Storage from the service account ${CLIENT_EMAIL}: status 400`,
		);
		expect(summary(server.take())).toEqual(['POST /token', 'POST /token', 'POST /token']);
	});
});
