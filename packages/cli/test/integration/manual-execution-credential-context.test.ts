/**
 * Integration tests for the manual-execution credential context.
 *
 * Verifies that when a workflow is run manually from the editor:
 *  - The auth cookie passed to `executeManually` is encrypted into
 *    `runtimeData.credentials` of the persisted execution.
 *  - Without a cookie, no credential context is stored.
 */

import { LicenseState } from '@n8n/backend-common';
import { testDb, createWorkflow } from '@n8n/backend-test-utils';
import { ExecutionRepository, type IWorkflowDb } from '@n8n/db';
import { Container } from '@n8n/di';
import { Cipher } from 'n8n-core';
import { toCredentialContext, toExecutionContext, type IExecutionContext } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { AuthService } from '@/auth/auth.service';
import { WorkflowExecutionService } from '@/workflows/workflow-execution.service';

import { createOwner } from './shared/db/users';
import * as utils from './shared/utils';
import { loadNodesFromDist } from './shared/utils/node-types-data';
import { createSimpleWorkflowFixture } from './shared/workflow-fixtures';

// MFA enforcement gates inside AuthService.authenticateUserByCookie call into the
// license state; stub it so any feature check returns "not licensed".
const licenseMock = mock<LicenseState>();
licenseMock.isLicensed.mockReturnValue(false);
Container.set(LicenseState, licenseMock);

describe('Manual execution credential context (integration)', () => {
	let owner: Awaited<ReturnType<typeof createOwner>>;
	let workflowExecutionService: WorkflowExecutionService;
	let executionRepository: ExecutionRepository;
	let authService: AuthService;
	let cipher: Cipher;

	beforeAll(async () => {
		await testDb.init();

		const nodeTypes = loadNodesFromDist(['n8n-nodes-base.manualTrigger']);
		await utils.initNodeTypes(nodeTypes);
		await utils.initBinaryDataService();

		owner = await createOwner();

		workflowExecutionService = Container.get(WorkflowExecutionService);
		executionRepository = Container.get(ExecutionRepository);
		authService = Container.get(AuthService);
		cipher = Container.get(Cipher);
	});

	afterEach(async () => {
		await testDb.truncate(['ExecutionEntity', 'WorkflowEntity', 'InvalidAuthToken']);
	});

	afterAll(async () => {
		await testDb.terminate();
	});

	/** Wait until the manual run is persisted with `finished: true`. */
	async function waitForExecution(executionId: string, timeout = 10000): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			const execution = await executionRepository.findOneBy({ id: executionId });
			if (execution?.finished) return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`Execution ${executionId} did not complete within ${timeout}ms`);
	}

	async function getExecutionContext(executionId: string): Promise<IExecutionContext> {
		const executionWithData = await executionRepository.findSingleExecution(executionId, {
			includeData: true,
			unflattenData: true,
		});
		if (!executionWithData) {
			throw new Error(`Execution ${executionId} not found`);
		}
		return executionWithData.data.executionData?.runtimeData as IExecutionContext;
	}

	async function runManually(user: typeof owner, cookie?: string) {
		const workflow = await createWorkflow(
			{
				name: 'Manual Test Workflow',
				...createSimpleWorkflowFixture(),
			} as unknown as IWorkflowDb,
			user,
		);

		const result = await workflowExecutionService.executeManually(
			workflow,
			{ triggerToStartFrom: { name: 'Trigger' } },
			user,
			undefined,
			cookie,
		);

		if (!('executionId' in result)) {
			throw new Error(`Expected an executionId, got ${JSON.stringify(result)}`);
		}

		await waitForExecution(result.executionId);
		return result.executionId;
	}

	describe('credential context injection', () => {
		it('encrypts the running user’s auth cookie into runtimeData.credentials', async () => {
			const cookie = authService.issueJWT(owner, owner.mfaEnabled, 'browser-1');

			const executionId = await runManually(owner, cookie);
			const ctx = await getExecutionContext(executionId);

			expect(ctx.source).toBe('manual');
			expect(typeof ctx.credentials).toBe('string');
			expect(ctx.credentials).not.toBe(cookie); // never persisted in plaintext

			const decrypted = await cipher.decryptV2(ctx.credentials!);
			expect(toCredentialContext(decrypted)).toEqual({
				version: 1,
				identity: cookie,
				metadata: { source: 'manual-execution' },
			});

			// The persisted context itself must still validate against the schema.
			expect(() => toExecutionContext(ctx as unknown as object)).not.toThrow();
		});

		it('does not inject credentials when no cookie is passed', async () => {
			const executionId = await runManually(owner, undefined);
			const ctx = await getExecutionContext(executionId);

			expect(ctx.source).toBe('manual');
			expect(ctx.credentials).toBeUndefined();
		});
	});
});
