// Fork code (not in upstream n8n): the types of a stored session of the AI builder chat. The
// ordinary repository of the module `workflow-builder` keeps the sessions. See `../FORK.md`.
import { BaseMessage } from '@langchain/core/messages';

export type LangchainMessage = BaseMessage;

/** The messages and the state of one chat thread. */
export interface StoredSession {
	messages: LangchainMessage[];
	previousSummary?: string;
	updatedAt?: Date;
	activeVersionCardId?: string | null;
	resumeAfterRestoreMessageId?: string | null;
}

/** The storage of the chat threads, by thread ID. */
export interface ISessionStorage {
	getSession(threadId: string): Promise<StoredSession | null>;
	saveSession(threadId: string, data: StoredSession): Promise<void>;
	deleteSession(threadId: string): Promise<void>;
}

/** True for a list in which each item is a message of LangChain. An empty list is true. */
export function isLangchainMessagesArray(value: unknown): value is LangchainMessage[] {
	return Array.isArray(value) && value.every((item) => BaseMessage.isInstance(item));
}
