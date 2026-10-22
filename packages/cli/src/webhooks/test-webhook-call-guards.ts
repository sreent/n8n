import { Service } from '@n8n/di';
import type { Request } from 'express';
import type { INode, IWorkflowBase } from 'n8n-workflow';

/**
 * Fork: a check that can refuse a call of a test URL before its trigger runs. It throws a
 * response error to refuse. The open-triggers module adds one (see its README.md).
 */
export interface TestWebhookCallGuard {
	check(request: Request, workflow: IWorkflowBase, node: INode): Promise<void>;
}

/**
 * Fork: the guards that `TestWebhooks.executeWebhook` asks before a test call runs. It asks them
 * while the request still has its cookies, so that a guard can see who calls.
 */
@Service()
export class TestWebhookCallGuards {
	private readonly guards: TestWebhookCallGuard[] = [];

	register(guard: TestWebhookCallGuard) {
		if (!this.guards.includes(guard)) this.guards.push(guard);
	}

	async check(request: Request, workflow: IWorkflowBase, node: INode) {
		for (const guard of this.guards) await guard.check(request, workflow, node);
	}
}
