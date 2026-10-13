// The login requests of a SAML config with `authnRequestsSigned`. n8n makes its service provider
// once in a process, at the first use, so this test runs in its own process: the service provider
// comes from a stored config with signed requests, as after a restart. For each case, the snapshot
// records the metadata, the login request, and the check of its signature by the fake identity
// provider, or the error.
// packages/cli/src/modules/sso-saml/FORK.md tells how the fork made the snapshot.
import { testDb } from '@n8n/backend-test-utils';
import { GLOBAL_OWNER_ROLE, type User } from '@n8n/db';
import { Container } from '@n8n/di';
import { inflateRawSync } from 'node:zlib';
import * as samlify from 'samlify';
import request from 'supertest';

import {
	RSA_TEST_CERTIFICATE,
	RSA_TEST_PRIVATE_KEY,
} from '@/modules/sso-saml/__tests__/saml-signing-test-fixtures';

import { createUser } from '@test-integration/db/users';
import { GoldenRecorder } from '@test-integration/golden-recorder';
import { setupTestServer } from '@test-integration/utils';

// The code under test. To record the snapshot against the original files in a checkout of upstream
// n8n, point these imports at `@/modules/sso-saml/saml.service.ee` and
// `@/modules/sso-saml/saml.controller.ee`.
import { SamlService } from '@/modules/sso-saml/saml.service';
import '@/modules/sso-saml/saml.controller';

const testServer = setupTestServer({ endpointGroups: ['auth'], enabledFeatures: ['feat:saml'] });
const recorder = new GoldenRecorder();
const { label, labelString, normalize } = recorder;

const { binding } = samlify.Constants.namespace;
const SIGNED_REQUESTS_FLAG = 'N8N_ENV_FEAT_SIGNED_SAML_REQUESTS';
const IDP_SSO_URL = 'https://idp.example.test/sso';
const certificateBody = (pem: string) => pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');

/** A fake identity provider that wants signed requests. It signs nothing: the test sends no response. */
const identityProvider = samlify.IdentityProvider({
	entityID: 'https://idp.example.test/metadata',
	signingCert: RSA_TEST_CERTIFICATE,
	wantAuthnRequestsSigned: true,
	singleSignOnService: [
		{ Binding: binding.redirect, Location: IDP_SSO_URL },
		{ Binding: binding.post, Location: IDP_SSO_URL },
	],
});

// samlify checks each message against the schema of the validator that the SAML service sets.

/** The XML of a SAML message, with its generated values replaced. */
function describeXml(xml: string) {
	return labelString(
		xml
			.replace(/\b(ID|InResponseTo)="_[0-9a-f-]{8,}"/g, '$1="<generated id>"')
			.replace(/\b(IssueInstant|NotBefore|NotOnOrAfter)="[^"]*"/g, '$1="<time>"')
			.replace(/<(ds:)?SignatureValue>[^<]*</g, '<$1SignatureValue><signature><')
			.replace(/<(ds:)?DigestValue>[^<]*</g, '<$1DigestValue><digest><'),
	);
}

/** The service provider as the identity provider knows it: from the metadata of n8n. */
async function serviceProviderOfMetadata() {
	const response = await request(testServer.app).get('/rest/sso/saml/metadata');
	return samlify.ServiceProvider({ metadata: response.text });
}

async function checkRedirectRequest(url: string) {
	const query = url.slice(url.indexOf('?') + 1);
	const octetString = query.slice(0, query.indexOf('&Signature='));
	const parameters = Object.fromEntries(new URL(url).searchParams);
	try {
		await identityProvider.parseLoginRequest(await serviceProviderOfMetadata(), 'redirect', {
			query: parameters,
			octetString,
		});
		return 'the identity provider accepts the request';
	} catch (error) {
		return `the identity provider refuses the request: ${String(error)}`;
	}
}

async function checkPostRequest(samlRequest: string) {
	try {
		await identityProvider.parseLoginRequest(await serviceProviderOfMetadata(), 'post', {
			body: { SAMLRequest: samlRequest },
		});
		return 'the identity provider accepts the request';
	} catch (error) {
		return `the identity provider refuses the request: ${String(error)}`;
	}
}

/** The login request of a response: its parameters, its XML, and the check of its signature. */
async function describeLoginRequest(response: request.Response) {
	const data = (response.body as { data?: unknown } | undefined)?.data;
	if (typeof data === 'string' && data.startsWith(IDP_SSO_URL)) {
		const url = new URL(data);
		const encoded = url.searchParams.get('SAMLRequest') ?? '';
		return {
			status: response.status,
			binding: 'redirect',
			parameters: [...url.searchParams.keys()],
			relayState: url.searchParams.get('RelayState'),
			sigAlg: url.searchParams.get('SigAlg'),
			request: describeXml(inflateRawSync(Buffer.from(encoded, 'base64')).toString('utf8')),
			check: await checkRedirectRequest(data),
		};
	}
	const form = /name="SAMLRequest" value="([^"]+)"/.exec(response.text ?? '');
	if (form) {
		return {
			status: response.status,
			binding: 'post',
			request: describeXml(Buffer.from(form[1], 'base64').toString('utf8')),
			check: await checkPostRequest(form[1]),
		};
	}
	return { status: response.status, body: normalize(response.body) };
}

let owner: User;
const flagBefore = process.env[SIGNED_REQUESTS_FLAG];

beforeAll(async () => {
	process.env[SIGNED_REQUESTS_FLAG] = 'true';
	label(RSA_TEST_CERTIFICATE, 'the RSA test certificate');
	label(certificateBody(RSA_TEST_CERTIFICATE), 'the body of the RSA test certificate');
	await testDb.truncate(['User']);
	owner = await createUser({ email: 'owner@example.com', role: GLOBAL_OWNER_ROLE });
});

afterAll(() => {
	if (flagBefore === undefined) delete process.env[SIGNED_REQUESTS_FLAG];
	else process.env[SIGNED_REQUESTS_FLAG] = flagBefore;
});

describe('SAML signed requests', () => {
	test('a stored config with signed requests', async () => {
		const outcomes: Record<string, unknown> = {};
		const save = async (body: Record<string, unknown>) => {
			const response = await testServer
				.authAgentFor(owner)
				.post('/sso/saml/config')
				.send({
					metadata: identityProvider.getMetadata(),
					signingPrivateKey: RSA_TEST_PRIVATE_KEY,
					signingCertificate: RSA_TEST_CERTIFICATE,
					authnRequestsSigned: true,
					loginEnabled: true,
					...body,
				});
			return response.status;
		};

		outcomes['the first config'] = await save({});
		// As after a restart: the service takes the stored row before the first use.
		await Container.get(SamlService).init();
		const metadata = await request(testServer.app).get('/rest/sso/saml/metadata');
		outcomes['the metadata of the service provider'] = {
			status: metadata.status,
			body: describeXml(metadata.text),
		};
		outcomes['the login, redirect binding'] = await describeLoginRequest(
			await request(testServer.app).get('/rest/sso/saml/initsso?redirect=%2Fworkflows'),
		);
		outcomes['the connection test, redirect binding'] = await describeLoginRequest(
			await testServer.authAgentFor(owner).post('/sso/saml/config/test').send({}),
		);
		outcomes['a config with the post binding'] = await save({ loginBinding: 'post' });
		outcomes['the login, post binding'] = await describeLoginRequest(
			await request(testServer.app).get('/rest/sso/saml/initsso'),
		);
		outcomes['the connection test, post binding'] = await describeLoginRequest(
			await testServer
				.authAgentFor(owner)
				.post('/sso/saml/config/test')
				.send({ loginBinding: 'post' }),
		);
		expect(outcomes).toMatchSnapshot();
	});
});
