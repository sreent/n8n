import { testDb } from '@n8n/backend-test-utils';
import { GLOBAL_MEMBER_ROLE, GLOBAL_OWNER_ROLE, type User } from '@n8n/db';

import type { ILicenseReadResponse } from '@/interfaces';

import { createUserShell } from './shared/db/users';
import type { SuperAgentTest } from './shared/types';
import * as utils from './shared/utils/';

let owner: User;
let member: User;
let authOwnerAgent: SuperAgentTest;
let authMemberAgent: SuperAgentTest;

const testServer = utils.setupTestServer({ endpointGroups: ['license'] });

beforeAll(async () => {
	owner = await createUserShell(GLOBAL_OWNER_ROLE);
	member = await createUserShell(GLOBAL_MEMBER_ROLE);

	authOwnerAgent = testServer.authAgentFor(owner);
	authMemberAgent = testServer.authAgentFor(member);
});

afterEach(async () => {
	await testDb.truncate(['Settings']);
});

describe('GET /license', () => {
	test('should return license information to the instance owner', async () => {
		// No license defined so we just expect the result to be the defaults
		await authOwnerAgent.get('/license').expect(200, DEFAULT_LICENSE_RESPONSE);
	});

	test('should return license information to a regular user', async () => {
		// No license defined so we just expect the result to be the defaults
		await authMemberAgent.get('/license').expect(200, DEFAULT_LICENSE_RESPONSE);
	});
});

// Fork: the fork has no routes that request a trial, register the Community Edition, or activate or
// renew a licence key (packages/cli/src/license/FORK.md).
describe('removed licence routes', () => {
	test.each([
		'/license/enterprise/request_trial',
		'/license/enterprise/community-registered',
		'/license/activate',
		'/license/renew',
	])('POST %s is not found', async (path) => {
		await authOwnerAgent.post(path).send({ activationKey: 'abcde', email: 'a@b.c' }).expect(404);
	});
});

const DEFAULT_LICENSE_RESPONSE: { data: ILicenseReadResponse } = {
	data: {
		usage: {
			activeWorkflowTriggers: {
				value: 0,
				limit: -1,
				warningThreshold: 0.8,
			},
			workflowsHavingEvaluations: {
				value: 0,
				limit: 0,
			},
		},
		license: {
			planId: '',
			planName: 'Community',
		},
	},
};
