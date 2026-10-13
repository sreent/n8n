// Fork test (not in upstream n8n): the last activity of each user in `GET /api/v1/users`. See
// packages/cli/src/governance/README.md.
import { testDb } from '@n8n/backend-test-utils';
import { UserRepository, type User } from '@n8n/db';
import { Container } from '@n8n/di';
import { DateTime } from 'luxon';

import { createMember, createOwnerWithApiKey } from '@test-integration/db/users';
import { setupTestServer } from '@test-integration/utils';

const testServer = setupTestServer({ endpointGroups: ['publicApi'] });

let owner: User;
let active: User;
let neverActive: User;

beforeAll(async () => {
	await testDb.truncate(['User']);
	owner = await createOwnerWithApiKey();
	active = await createMember();
	neverActive = await createMember();
	await Container.get(UserRepository).update(active.id, {
		lastActiveAt: new Date(2026, 9, 1, 12, 0, 0),
	});
	await Container.get(UserRepository).update(neverActive.id, { lastActiveAt: null });
});

describe('the last activity of users in the public API', () => {
	test('GET /users gives the day of the last activity, or null', async () => {
		const response = await testServer.publicApiAgentFor(owner).get('/users').expect(200);

		const lastActive = Object.fromEntries(
			response.body.data.map((user: { id: string; lastActiveAt: string | null }) => [
				user.id,
				user.lastActiveAt,
			]),
		);
		expect(lastActive[active.id]).toBe('2026-10-01');
		expect(lastActive[neverActive.id]).toBeNull();
		// The request with the API key of the owner is an activity of the owner.
		await vi.waitFor(async () => {
			const again = await testServer.publicApiAgentFor(owner).get(`/users/${owner.id}`);
			expect(again.body.lastActiveAt).toBe(DateTime.now().toISODate());
		});
	});

	test('GET /users/:id gives it too', async () => {
		const response = await testServer
			.publicApiAgentFor(owner)
			.get(`/users/${active.id}`)
			.expect(200);

		expect(response.body.lastActiveAt).toBe('2026-10-01');
	});
});
