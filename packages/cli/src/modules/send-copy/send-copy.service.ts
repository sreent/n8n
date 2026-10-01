import { Logger } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { GLOBAL_CHAT_USER_ROLE, ProjectRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { NotFoundError } from '@n8n/errors';

import { createWorkflowEntityFromPayload } from '@/workflows/workflow-entity-mapper';
import { WorkflowCreationService } from '@/workflows/workflow-creation.service';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import { SendCopyRecipientRepository } from './database/repositories/send-copy-recipient.repository';
import { SEND_COPY_UI_CONTEXT } from './send-copy.constants';
import type { CopyRecipient, SendCopyResult } from './send-copy.types';
import { buildWorkflowCopy } from './workflow-copy.builder';

/** Returns true when the user can receive a copy. */
export function isEligibleRecipient(user: User): boolean {
	return !user.disabled && !user.isPending && user.role?.slug !== GLOBAL_CHAT_USER_ROLE.slug;
}

@Service()
export class SendCopyService {
	constructor(
		private readonly logger: Logger,
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly workflowCreationService: WorkflowCreationService,
		private readonly projectRepository: ProjectRepository,
		private readonly recipientRepository: SendCopyRecipientRepository,
	) {
		this.logger = this.logger.scoped('send-copy');
	}

	async listRecipients(
		sender: User,
		options: { search?: string; limit: number },
	): Promise<CopyRecipient[]> {
		const users = await this.recipientRepository.findCandidates(sender.id, options);
		return users.map(({ id, firstName, lastName, email }) => ({ id, firstName, lastName, email }));
	}

	/**
	 * Sends a copy of a workflow to each recipient. Each copy is a new, unpublished
	 * workflow in the personal project of the recipient.
	 *
	 * The sender must be able to read the workflow. A failure for one recipient does
	 * not stop the copies for the other recipients.
	 */
	async sendWorkflowCopy(
		sender: User,
		workflowId: string,
		recipientIds: string[],
	): Promise<SendCopyResult[]> {
		const source = await this.workflowFinderService.findWorkflowForUser(
			workflowId,
			sender,
			['workflow:read'],
			{ includeTags: true },
		);
		// Do not tell the sender whether a workflow they cannot read exists.
		if (!source) throw new NotFoundError('Could not find the workflow');

		const uniqueIds = [...new Set(recipientIds)];
		const recipients = await this.recipientRepository.findByIdsForCopy(
			uniqueIds.filter((id) => id !== sender.id),
		);
		const recipientsById = new Map(recipients.map((user) => [user.id, user]));
		const sentAt = new Date();
		const results: SendCopyResult[] = [];

		for (const recipientId of uniqueIds) {
			if (recipientId === sender.id) {
				results.push({ recipientId, status: 'failed', reason: 'self' });
				continue;
			}

			const recipient = recipientsById.get(recipientId);
			if (!recipient) {
				results.push({ recipientId, status: 'failed', reason: 'not-found' });
				continue;
			}

			if (!isEligibleRecipient(recipient)) {
				results.push({ recipientId, status: 'failed', reason: 'not-eligible' });
				continue;
			}

			results.push(await this.createCopy(source, sender, recipient, sentAt));
		}

		this.logger.info('Sent copies of a workflow', {
			workflowId,
			senderId: sender.id,
			sent: results.filter((result) => result.status === 'sent').length,
			failed: results.filter((result) => result.status === 'failed').length,
		});

		return results;
	}

	private async createCopy(
		source: Parameters<typeof buildWorkflowCopy>[0],
		sender: User,
		recipient: User,
		sentAt: Date,
	): Promise<SendCopyResult> {
		try {
			const project = await this.projectRepository.getPersonalProjectForUserOrFail(recipient.id);
			const { tagIds, ...fields } = buildWorkflowCopy(source, sender, sentAt);

			// The recipient creates the copy, so the usual permission and policy checks
			// for the personal project of the recipient apply.
			const created = await this.workflowCreationService.createWorkflow(
				recipient,
				createWorkflowEntityFromPayload(fields),
				{ projectId: project.id, tagIds, source: 'ui', uiContext: SEND_COPY_UI_CONTEXT },
			);

			return {
				recipientId: recipient.id,
				status: 'sent',
				workflowId: created.id,
				workflowName: created.name,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.warn('Could not create a copy of a workflow', {
				workflowId: source.id,
				recipientId: recipient.id,
				error: message,
			});
			return { recipientId: recipient.id, status: 'failed', reason: 'error', message };
		}
	}
}
