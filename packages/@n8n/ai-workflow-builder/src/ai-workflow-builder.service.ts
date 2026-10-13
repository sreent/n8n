// Fork code (not in upstream n8n): a stand-in for the chat of the AI workflow builder. The chat needs
// a service of n8n, so the fork does not have it. The ordinary `WorkflowBuilderService` of cli
// still makes this class, and the REST routes of the chat stay behind the licence feature
// `feat:aiBuilder`. Each call of the chat fails with a clear message. See `../FORK.md`.
import type { AiAssistantSDK } from '@n8n_io/ai-assistant-sdk';
import type { INodeTypeDescription, IUser } from 'n8n-workflow';
import { UserError } from 'n8n-workflow';

import type { ISessionStorage } from './session.types';
import type { SsrfGuard } from './ssrf-guard';

/** A message to the chat of the AI builder, as the REST route gives it. */
export interface ChatPayload {
	id: string;
	message: string;
	workflowContext?: Record<string, unknown>;
	featureFlags?: Record<string, unknown>;
	versionId?: string;
	mode?: string;
	resumeData?: unknown;
}

/** One part of the answer of the chat, as the REST route streams it. */
export interface ChatStreamChunk {
	messages: unknown[];
}

/** Makes a function that loads the values of a resource locator for a user. */
export type ResourceLocatorCallbackFactory = (userId: string) => (...args: never[]) => unknown;

const NOT_AVAILABLE = 'The AI workflow builder chat is not available in this n8n.';

export class AiWorkflowBuilderService {
	constructor(
		_nodeTypeDescriptions: INodeTypeDescription[],
		_sessionStorage?: ISessionStorage,
		_client?: unknown,
		_logger?: unknown,
		_instanceId?: string,
		_instanceUrl?: string,
		_n8nVersion?: string,
		_onCreditsUpdated?: (userId: string, creditsQuota: number, creditsClaimed: number) => void,
		_onTelemetryEvent?: (event: string, properties: Record<string, unknown>) => void,
		_nodeDefinitionDirs?: string[],
		_resourceLocatorCallbackFactory?: ResourceLocatorCallbackFactory,
		_webFetchSsrfGuard?: SsrfGuard,
		_modelFetch?: typeof fetch,
	) {}

	updateNodeTypes(_nodeTypeDescriptions: INodeTypeDescription[]): void {}

	// eslint-disable-next-line require-yield
	async *chat(
		_payload: ChatPayload,
		_user: IUser,
		_abortSignal?: AbortSignal,
	): AsyncGenerator<ChatStreamChunk> {
		throw new UserError(NOT_AVAILABLE);
	}

	async getSessions(_workflowId: string | undefined, _user: IUser, _isCodeBuilder?: boolean) {
		return { sessions: [] };
	}

	async getBuilderInstanceCredits(
		_user: IUser,
	): Promise<AiAssistantSDK.BuilderInstanceCreditsResponse> {
		throw new UserError(NOT_AVAILABLE);
	}

	async clearSession(_workflowId: string, _user: IUser): Promise<void> {}

	async truncateMessagesAfter(
		_workflowId: string,
		_user: IUser,
		_messageId: string,
		_versionCardId?: string,
	): Promise<boolean> {
		return false;
	}
}
