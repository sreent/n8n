import type { Logger } from '@n8n/backend-common';
import type { ChatTriggerConfig } from '@n8n/config';
import type { User } from '@n8n/db';
import { ForbiddenError } from '@n8n/errors';
import type { Request } from 'express';
import { WEBHOOK_NODE_TYPE, type INode, type IWorkflowBase } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import type { AuthService } from '@/auth/auth.service';
import { userHasScopes } from '@/permissions/check-access';

import type { OpenTriggerRepository } from '../database/open-trigger.repository';
import {
	OpenTriggerTestCallGuard,
	TEST_CALL_REFUSED_MESSAGE,
} from '../open-trigger-test-call.guard';
import type { OpenTriggersConfig } from '../open-triggers.config';
import { OpenTriggersService } from '../open-triggers.service';

vi.mock('@/permissions/check-access', () => ({ userHasScopes: vi.fn() }));

const webhook = (authentication?: string): INode => ({
	id: 'n1',
	name: 'Orders',
	type: WEBHOOK_NODE_TYPE,
	typeVersion: 2,
	position: [0, 0],
	parameters: authentication ? { authentication } : {},
});

const workflow = { id: 'wf-1', name: 'Orders', nodes: [webhook()] } as IWorkflowBase;

const request = (cookie?: string) =>
	({ headers: cookie === undefined ? {} : { cookie } }) as Request;

describe('OpenTriggerTestCallGuard', () => {
	const repository = mock<OpenTriggerRepository>();
	const authService = mock<AuthService>();
	const config = { needApproval: true } as OpenTriggersConfig;
	const service = new OpenTriggersService(
		repository,
		mock<ChatTriggerConfig>({ disablePublicChat: false }),
		mock(),
		mock(),
	);
	const guard = new OpenTriggerTestCallGuard(config, service, authService, mock<Logger>());
	const user = mock<User>();

	beforeEach(() => {
		vi.resetAllMocks();
		config.needApproval = true;
		repository.findPublishedVersionNodes.mockResolvedValue(null);
		repository.findApprovedVersionNodes.mockResolvedValue([]);
	});

	it('should do nothing while N8N_OPEN_TRIGGERS_NEED_APPROVAL is false', async () => {
		config.needApproval = false;

		await expect(guard.check(request(), workflow, webhook())).resolves.toBeUndefined();
		expect(repository.findApprovedVersionNodes).not.toHaveBeenCalled();
	});

	it('should leave a trigger with authentication to the check of the node', async () => {
		await expect(guard.check(request(), workflow, webhook('headerAuth'))).resolves.toBeUndefined();
		expect(repository.findApprovedVersionNodes).not.toHaveBeenCalled();
	});

	it('should refuse a call without an n8n session to an open trigger', async () => {
		const call = guard.check(request('other=1'), workflow, webhook());

		await expect(call).rejects.toThrow(ForbiddenError);
		await expect(guard.check(request(), workflow, webhook())).rejects.toThrow(
			TEST_CALL_REFUSED_MESSAGE,
		);
		expect(authService.authenticateUserByCookie).not.toHaveBeenCalled();
	});

	it('should let an n8n user who may run the workflow call', async () => {
		authService.authenticateUserByCookie.mockResolvedValue(user);
		vi.mocked(userHasScopes).mockResolvedValue(true);

		const call = guard.check(request('other=1; n8n-auth=token%2Evalue'), workflow, webhook());

		await expect(call).resolves.toBeUndefined();
		expect(authService.authenticateUserByCookie).toHaveBeenCalledWith('token.value');
		expect(userHasScopes).toHaveBeenCalledWith(user, ['workflow:execute'], false, {
			workflowId: 'wf-1',
		});
	});

	it('should refuse an n8n user who may not run the workflow', async () => {
		authService.authenticateUserByCookie.mockResolvedValue(user);
		vi.mocked(userHasScopes).mockResolvedValue(false);

		const call = guard.check(request('n8n-auth=token'), workflow, webhook());

		await expect(call).rejects.toThrow(ForbiddenError);
	});

	it('should refuse a session that is not valid', async () => {
		authService.authenticateUserByCookie.mockRejectedValue(new Error('Unauthorized'));

		const call = guard.check(request('n8n-auth=signed-out'), workflow, webhook());

		await expect(call).rejects.toThrow(ForbiddenError);
	});

	it('should let any caller reach an open trigger that a workflow review approved', async () => {
		repository.findApprovedVersionNodes.mockResolvedValue([
			{ workflowId: 'wf-1', versionId: 'v2', nodes: [webhook()] },
		]);

		await expect(guard.check(request(), workflow, webhook())).resolves.toBeUndefined();
	});

	it('should let any caller reach an open trigger of the published version', async () => {
		repository.findPublishedVersionNodes.mockResolvedValue([webhook()]);

		await expect(guard.check(request(), workflow, webhook())).resolves.toBeUndefined();
	});
});
