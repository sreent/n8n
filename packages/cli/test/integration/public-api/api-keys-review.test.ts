// Fork test (not in upstream n8n): the list of all API keys in the public API (`/api/v1/api-keys`).
// See packages/cli/src/governance/README.md.
import { ApiKeyRepository, type ApiKey, type User } from '@n8n/db';
import { Container } from '@n8n/di';

import {
	addApiKey,
	createAdminWithApiKey,
	createMemberWithApiKey,
	createOwnerWithApiKey,
} from '../shared/db/users';
import * as utils from '../shared/utils';

const testServer = utils.setupTestServer({ endpointGroups: ['publicApi'] });

type ReviewItem = { id: string } & Record<string, unknown>;

let owner: User;
let ownerWithoutScope: User;
let admin: User;
let member: User;
let expiredKey: ApiKey;
let mcpKey: ApiKey;
let allKeys: ApiKey[];

const DAY_IN_SECONDS = 24 * 60 * 60;

beforeAll(async () => {
	owner = await createOwnerWithApiKey({ scopes: ['apiKey:manage'] });
	ownerWithoutScope = await createOwnerWithApiKey({ scopes: ['workflow:list'] });
	admin = await createAdminWithApiKey({ scopes: ['apiKey:manage'] });
	// A member cannot get this scope through the API, so the test stores it on the key.
	member = await createMemberWithApiKey({ scopes: ['apiKey:manage'] });
	expiredKey = await addApiKey(member, {
		expiresAt: Math.floor(Date.now() / 1000) - DAY_IN_SECONDS,
		scopes: ['workflow:read'],
	});

	const repository = Container.get(ApiKeyRepository);
	mcpKey = await repository.save(
		repository.create({
			userId: admin.id,
			label: 'MCP Server API Key',
			apiKey: 'mcp-server-api-key-value',
			audience: 'mcp-server-api',
			scopes: [],
		}),
	);

	// Fixed creation times give a known order: the last key is the newest.
	allKeys = [
		owner.apiKeys[0],
		ownerWithoutScope.apiKeys[0],
		admin.apiKeys[0],
		member.apiKeys[0],
		expiredKey,
		mcpKey,
	];
	for (const [index, key] of allKeys.entries()) {
		await repository.update(key.id, { createdAt: new Date(Date.UTC(2026, 9, 1, 8 + index)) });
	}
});

const ids = (body: { data: ReviewItem[] }) => body.data.map((key) => key.id);

const newestFirst = () => [...allKeys].reverse().map((key) => key.id);

describe('GET /api-keys', () => {
	test('returns 401 without an API key', async () => {
		await testServer.publicApiAgentWithoutApiKey().get('/api-keys').expect(401);
	});

	test('returns 403 for an API key without the scope apiKey:manage', async () => {
		await testServer.publicApiAgentFor(ownerWithoutScope).get('/api-keys').expect(403);
	});

	test('returns 403 for a member, also with the scope on the key', async () => {
		await testServer.publicApiAgentFor(member).get('/api-keys').expect(403);
	});

	test('lists the keys of all users, newest first, for the owner and an admin', async () => {
		for (const user of [owner, admin]) {
			const response = await testServer.publicApiAgentFor(user).get('/api-keys').expect(200);

			expect(ids(response.body)).toEqual(newestFirst());
			expect(response.body.nextCursor).toBeNull();
		}
	});

	test('gives the user, the scopes and the expiry of a key, but not its value', async () => {
		const response = await testServer.publicApiAgentFor(owner).get('/api-keys').expect(200);

		const expired = response.body.data.find((key: ReviewItem) => key.id === expiredKey.id);
		expect(expired).toEqual({
			id: expiredKey.id,
			label: expiredKey.label,
			audience: 'public-api',
			scopes: ['workflow:read'],
			user: {
				id: member.id,
				email: member.email,
				firstName: member.firstName,
				lastName: member.lastName,
				role: 'global:member',
			},
			createdAt: '2026-10-01T12:00:00.000Z',
			updatedAt: expect.any(String),
			expiresAt: expect.any(String),
			expired: true,
			lastUsedAt: null,
		});
		const expectedExpiry = (Math.floor(Date.now() / 1000) - DAY_IN_SECONDS) * 1000;
		expect(Math.abs(new Date(expired.expiresAt).getTime() - expectedExpiry)).toBeLessThan(60_000);

		const mcp = response.body.data.find((key: ReviewItem) => key.id === mcpKey.id);
		expect(mcp).toMatchObject({
			label: 'MCP Server API Key',
			audience: 'mcp-server-api',
			scopes: [],
			user: { id: admin.id, role: 'global:admin' },
			expiresAt: null,
			expired: false,
		});

		const body = JSON.stringify(response.body);
		for (const key of allKeys) {
			expect(body).not.toContain(key.apiKey);
		}
	});

	test('gives the time of the last use of a key', async () => {
		const repository = Container.get(ApiKeyRepository);
		const usedKey = ownerWithoutScope.apiKeys[0];

		// n8n saves the last use after the request, also when the scope check then fails.
		await testServer.publicApiAgentFor(ownerWithoutScope).get('/api-keys').expect(403);
		await vi.waitFor(
			async () => {
				const saved = await repository.findOneByOrFail({ id: usedKey.id });
				expect(saved.lastUsedAt).not.toBeNull();
			},
			{ timeout: 5_000 },
		);

		const response = await testServer.publicApiAgentFor(owner).get('/api-keys').expect(200);
		const used = response.body.data.find((key: ReviewItem) => key.id === usedKey.id);
		expect(used.lastUsedAt).toEqual(expect.any(String));
		expect(Date.now() - new Date(used.lastUsedAt).getTime()).toBeLessThan(60_000);
	});

	test('filters by user and by audience', async () => {
		const agent = testServer.publicApiAgentFor(owner);

		const ofMember = await agent.get('/api-keys').query({ userId: member.id }).expect(200);
		expect(ids(ofMember.body)).toEqual([expiredKey.id, member.apiKeys[0].id]);

		const mcp = await agent.get('/api-keys').query({ audience: 'mcp-server-api' }).expect(200);
		expect(ids(mcp.body)).toEqual([mcpKey.id]);

		const publicKeysOfAdmin = await agent
			.get('/api-keys')
			.query({ userId: admin.id, audience: 'public-api' })
			.expect(200);
		expect(ids(publicKeysOfAdmin.body)).toEqual([admin.apiKeys[0].id]);

		await agent.get('/api-keys').query({ audience: 'other' }).expect(400);
	});

	test('pages with limit and cursor', async () => {
		const agent = testServer.publicApiAgentFor(owner);

		const first = await agent.get('/api-keys').query({ limit: 4 }).expect(200);
		expect(first.body.nextCursor).toEqual(expect.any(String));

		const second = await agent
			.get('/api-keys')
			.query({ cursor: first.body.nextCursor })
			.expect(200);
		expect(second.body.nextCursor).toBeNull();
		expect([...ids(first.body), ...ids(second.body)]).toEqual(newestFirst());

		// Since n8n 2.45, a limit of 0 gives the default page, as in the other public API routes.
		const defaultPage = await agent.get('/api-keys').query({ limit: 0 }).expect(200);
		expect(ids(defaultPage.body)).toEqual(newestFirst());
		expect(defaultPage.body.nextCursor).toBeNull();
	});

	test('works with the session cookie of the owner', async () => {
		const response = await testServer.publicApiAgentWithCookie(owner).get('/api-keys').expect(200);

		expect(ids(response.body)).toEqual(newestFirst());
	});
});
