import type { Logger } from '@n8n/backend-common';
import {
	GLOBAL_CHAT_USER_ROLE,
	GLOBAL_MEMBER_ROLE,
	type Project,
	type ProjectRepository,
	type User,
	type WorkflowEntity,
} from '@n8n/db';
import { NotFoundError } from '@n8n/errors';
import { mock } from 'vitest-mock-extended';

import type { WorkflowCreationService } from '@/workflows/workflow-creation.service';
import type { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import type { SendCopyRecipientRepository } from '../database/repositories/send-copy-recipient.repository';
import { isEligibleRecipient, SendCopyService } from '../send-copy.service';

const makeUser = (overrides: Partial<User> = {}): User =>
	({
		id: 'user-1',
		firstName: 'Ada',
		lastName: 'Lovelace',
		email: 'ada@example.com',
		disabled: false,
		isPending: false,
		role: GLOBAL_MEMBER_ROLE,
		...overrides,
	}) as unknown as User;

const sender = makeUser({ id: 'sender' });

const sourceWorkflow = {
	id: 'wf-1',
	name: 'Daily report',
	description: null,
	nodes: [],
	connections: {},
	settings: {},
	nodeGroups: [],
	tags: [{ id: 'tag-1' }],
} as unknown as WorkflowEntity;

describe('isEligibleRecipient', () => {
	it('accepts an active member', () => {
		expect(isEligibleRecipient(makeUser())).toBe(true);
	});

	it.each([
		['disabled', { disabled: true }],
		['pending', { isPending: true }],
		['chat', { role: GLOBAL_CHAT_USER_ROLE }],
	])('rejects a %s user', (_label, overrides) => {
		expect(isEligibleRecipient(makeUser(overrides as Partial<User>))).toBe(false);
	});
});

describe('SendCopyService', () => {
	const logger = mock<Logger>();
	logger.scoped.mockReturnValue(logger);
	const workflowFinderService = mock<WorkflowFinderService>();
	const workflowCreationService = mock<WorkflowCreationService>();
	const projectRepository = mock<ProjectRepository>();
	const recipientRepository = mock<SendCopyRecipientRepository>();

	const service = new SendCopyService(
		logger,
		workflowFinderService,
		workflowCreationService,
		projectRepository,
		recipientRepository,
	);

	beforeEach(() => {
		vi.clearAllMocks();
		logger.scoped.mockReturnValue(logger);
		workflowFinderService.findWorkflowForUser.mockResolvedValue(sourceWorkflow);
		projectRepository.getPersonalProjectForUserOrFail.mockImplementation(
			async (userId: string) => ({ id: `personal-${userId}` }) as Project,
		);
		workflowCreationService.createWorkflow.mockImplementation(
			async (user, entity) => ({ ...entity, id: `copy-for-${user.id}` }) as WorkflowEntity,
		);
	});

	describe('sendWorkflowCopy', () => {
		it('throws when the sender cannot read the workflow', async () => {
			workflowFinderService.findWorkflowForUser.mockResolvedValue(null);

			await expect(service.sendWorkflowCopy(sender, 'wf-1', ['a'])).rejects.toThrow(NotFoundError);
			expect(workflowCreationService.createWorkflow).not.toHaveBeenCalled();
		});

		it('checks read access for the sender', async () => {
			recipientRepository.findByIdsForCopy.mockResolvedValue([]);

			await service.sendWorkflowCopy(sender, 'wf-1', ['a']);

			expect(workflowFinderService.findWorkflowForUser).toHaveBeenCalledWith(
				'wf-1',
				sender,
				['workflow:read'],
				{ includeTags: true },
			);
		});

		it('creates each copy as the recipient in their personal project', async () => {
			const recipient = makeUser({ id: 'rec-1' });
			recipientRepository.findByIdsForCopy.mockResolvedValue([recipient]);

			const results = await service.sendWorkflowCopy(sender, 'wf-1', ['rec-1']);

			expect(results).toEqual([
				{
					recipientId: 'rec-1',
					status: 'sent',
					workflowId: 'copy-for-rec-1',
					workflowName: 'Daily report (from Ada Lovelace)',
				},
			]);
			const [user, entity, options] = workflowCreationService.createWorkflow.mock.calls[0];
			expect(user).toBe(recipient);
			expect(entity.sourceWorkflowId).toBeUndefined();
			expect(options).toEqual({
				projectId: 'personal-rec-1',
				tagIds: ['tag-1'],
				source: 'ui',
				uiContext: 'send-copy',
			});
		});

		it('reports self, missing, and ineligible recipients without creating copies', async () => {
			recipientRepository.findByIdsForCopy.mockResolvedValue([
				makeUser({ id: 'pending', isPending: true }),
			]);

			const results = await service.sendWorkflowCopy(sender, 'wf-1', [
				'sender',
				'missing',
				'pending',
			]);

			expect(results).toEqual([
				{ recipientId: 'sender', status: 'failed', reason: 'self' },
				{ recipientId: 'missing', status: 'failed', reason: 'not-found' },
				{ recipientId: 'pending', status: 'failed', reason: 'not-eligible' },
			]);
			expect(recipientRepository.findByIdsForCopy).toHaveBeenCalledWith(['missing', 'pending']);
			expect(workflowCreationService.createWorkflow).not.toHaveBeenCalled();
		});

		it('sends one copy per recipient even when an ID is repeated', async () => {
			recipientRepository.findByIdsForCopy.mockResolvedValue([makeUser({ id: 'rec-1' })]);

			const results = await service.sendWorkflowCopy(sender, 'wf-1', ['rec-1', 'rec-1']);

			expect(results).toHaveLength(1);
			expect(workflowCreationService.createWorkflow).toHaveBeenCalledTimes(1);
		});

		it('continues with the other recipients when one copy fails', async () => {
			recipientRepository.findByIdsForCopy.mockResolvedValue([
				makeUser({ id: 'rec-1' }),
				makeUser({ id: 'rec-2' }),
			]);
			workflowCreationService.createWorkflow.mockRejectedValueOnce(new Error('Policy blocked it'));

			const results = await service.sendWorkflowCopy(sender, 'wf-1', ['rec-1', 'rec-2']);

			expect(results[0]).toEqual({
				recipientId: 'rec-1',
				status: 'failed',
				reason: 'error',
				message: 'Policy blocked it',
			});
			expect(results[1]).toMatchObject({ recipientId: 'rec-2', status: 'sent' });
		});
	});

	describe('listRecipients', () => {
		it('returns only the public fields', async () => {
			recipientRepository.findCandidates.mockResolvedValue([
				makeUser({ id: 'rec-1', password: 'hash' } as Partial<User>),
			]);

			const result = await service.listRecipients(sender, { limit: 20 });

			expect(result).toEqual([
				{ id: 'rec-1', firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' },
			]);
			expect(recipientRepository.findCandidates).toHaveBeenCalledWith('sender', { limit: 20 });
		});
	});
});
