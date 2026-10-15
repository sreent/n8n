import type { OutboundHttp } from '@n8n/backend-network';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync } from 'node:crypto';

import { AiGatewayVertexService, VertexSignInError } from '../ai-gateway-vertex.service';

/** Fork test (not in upstream n8n): the sign-in of the AI gateway to Vertex AI. */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const credential = {
	email: 'n8n@acme-prod.iam.gserviceaccount.com',
	// The credential keeps the line breaks of the key as `\n`, as a pasted JSON key file has them.
	privateKey: privatePem.replace(/\n/g, '\\n'),
	region: 'global',
};

function setup(answer: () => Promise<unknown>) {
	const request = vi.fn(answer);
	const outboundHttp = { requests: () => ({ request }) } as unknown as OutboundHttp;
	return { service: new AiGatewayVertexService(outboundHttp), request };
}

describe('AiGatewayVertexService', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('signs a JWT of the service account and exchanges it for an access token', async () => {
		const { service, request } = setup(async () => ({
			access_token: 'ya29.one',
			expires_in: 3599,
		}));

		await expect(service.accessToken(credential)).resolves.toBe('ya29.one');

		expect(request).toHaveBeenCalledTimes(1);
		const [options] = request.mock.calls[0] as unknown as [
			{ url: string; method: string; body: string },
		];
		expect(options.url).toBe('https://oauth2.googleapis.com/token');
		expect(options.method).toBe('POST');
		const form = new URLSearchParams(options.body);
		expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
		const claims = jwt.verify(form.get('assertion') ?? '', publicPem, { algorithms: ['RS256'] });
		expect(claims).toMatchObject({
			iss: credential.email,
			scope: 'https://www.googleapis.com/auth/cloud-platform',
			aud: 'https://oauth2.googleapis.com/token',
		});
	});

	it('keeps the token until 5 minutes before it expires, and shares one request', async () => {
		vi.useFakeTimers({ now: new Date('2026-10-15T10:00:00Z') });
		let counter = 0;
		const { service, request } = setup(async () => ({
			access_token: `ya29.${++counter}`,
			expires_in: 3600,
		}));

		const [first, second] = await Promise.all([
			service.accessToken(credential),
			service.accessToken(credential),
		]);
		expect([first, second]).toEqual(['ya29.1', 'ya29.1']);
		expect(request).toHaveBeenCalledTimes(1);

		vi.setSystemTime(new Date('2026-10-15T10:54:00Z'));
		await expect(service.accessToken(credential)).resolves.toBe('ya29.1');
		vi.setSystemTime(new Date('2026-10-15T10:56:00Z'));
		await expect(service.accessToken(credential)).resolves.toBe('ya29.2');

		service.clear();
		await expect(service.accessToken(credential)).resolves.toBe('ya29.3');
	});

	it('gets a new token when the credential changes', async () => {
		let counter = 0;
		const { service } = setup(async () => ({ access_token: `ya29.${++counter}` }));
		await expect(service.accessToken(credential)).resolves.toBe('ya29.1');
		await expect(
			service.accessToken({ ...credential, email: 'other@acme-prod.iam.gserviceaccount.com' }),
		).resolves.toBe('ya29.2');
	});

	it('fails with a sign-in error that has no secret', async () => {
		const { service } = setup(async () => {
			throw new Error('400 invalid_grant: Invalid JWT Signature.');
		});
		const failure = service.accessToken(credential);
		await expect(failure).rejects.toThrow(VertexSignInError);
		await expect(failure).rejects.toThrow('invalid_grant');

		await expect(service.accessToken({ ...credential, privateKey: '' })).rejects.toThrow(
			'The credential has no e-mail or no private key.',
		);
		await expect(service.accessToken({ ...credential, privateKey: 'not a key' })).rejects.toThrow(
			'The private key of the credential is not valid.',
		);

		const { service: noToken } = setup(async () => ({ token_type: 'Bearer' }));
		await expect(noToken.accessToken(credential)).rejects.toThrow('Google gave no access token.');
	});

	it('gives the origin of the API in a location', () => {
		const { service } = setup(async () => ({}));
		expect(service.origin('us-central1')).toBe('https://us-central1-aiplatform.googleapis.com');
		expect(service.origin('global')).toBe('https://aiplatform.googleapis.com');
	});
});
