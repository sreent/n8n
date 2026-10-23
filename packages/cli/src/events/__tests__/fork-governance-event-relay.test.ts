import { EventService } from '@n8n/backend-services';
import { mock } from 'vitest-mock-extended';

import { eventNamesAudit } from '@/eventbus/event-message-classes';
import { forkEventNamesAudit } from '@/eventbus/event-message-classes/fork-audit-event-names';
import type { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';
import type { ForkGovernanceEventMap } from '@/events/maps/fork-governance.event-map';
import { ForkGovernanceEventRelay } from '@/events/relays/fork-governance.event-relay';

describe('ForkGovernanceEventRelay', () => {
	const eventBus = mock<MessageEventBus>();
	const eventService = new EventService();
	new ForkGovernanceEventRelay(eventService, eventBus).init();

	const user = () => ({
		id: 'user-1',
		email: 'admin@example.com',
		firstName: 'Ada',
		lastName: 'Admin',
		role: { slug: 'global:admin' },
	});
	const redactedUser = {
		userId: 'user-1',
		_email: 'admin@example.com',
		_firstName: 'Ada',
		_lastName: 'Admin',
		globalRole: 'global:admin',
	};

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('lists each fork audit event once among the audit events of n8n', () => {
		for (const name of forkEventNamesAudit) {
			expect(eventNamesAudit.filter((auditName) => auditName === name)).toHaveLength(1);
		}
	});

	it('sends a Git sync push as an audit event with the user', () => {
		const event: ForkGovernanceEventMap['git-sync-pushed'] = {
			user: user(),
			projectId: 'project-1',
			repositoryUrl: 'https://git.example.com/team/workflows.git',
			branch: 'main',
			commit: 'abc123',
			changedFiles: 3,
			replacedRemoteContent: false,
		};

		eventService.emit('git-sync-pushed', event);

		expect(eventBus.sendAuditEvent).toHaveBeenCalledWith({
			eventName: 'n8n.audit.git-sync.pushed',
			payload: {
				...redactedUser,
				projectId: 'project-1',
				repositoryUrl: 'https://git.example.com/team/workflows.git',
				branch: 'main',
				commit: 'abc123',
				changedFiles: 3,
				replacedRemoteContent: false,
			},
		});
	});

	it('sends a change of the AI gateway settings as an audit event', () => {
		eventService.emit('ai-gateway-settings-updated', {
			user: user(),
			enabled: false,
			changed: ['enabled'],
			providers: ['openai'],
			monthlyBudget: 100,
			userMonthlyLimit: null,
		});

		expect(eventBus.sendAuditEvent).toHaveBeenCalledWith({
			eventName: 'n8n.audit.ai-gateway.settings.updated',
			payload: {
				...redactedUser,
				enabled: false,
				changed: ['enabled'],
				providers: ['openai'],
				monthlyBudget: 100,
				userMonthlyLimit: null,
			},
		});
	});

	it('sends the deletion of a log streaming destination as an audit event', () => {
		eventService.emit('log-streaming-destination-deleted', {
			user: user(),
			destinationId: 'destination-1',
			destinationType: 'webhook',
			label: 'SIEM',
			enabled: true,
		});

		expect(eventBus.sendAuditEvent).toHaveBeenCalledWith({
			eventName: 'n8n.audit.log-streaming.destination.deleted',
			payload: {
				...redactedUser,
				destinationId: 'destination-1',
				destinationType: 'webhook',
				label: 'SIEM',
				enabled: true,
			},
		});
	});

	it('sends an apply of a Git connection as an audit event', () => {
		eventService.emit('git-connection-applied', {
			user: user(),
			connectionId: 'connection-1',
			branchName: 'production',
			commitSha: 'def456',
			counts: { workflows: { created: 1, updated: 2 } },
		});

		expect(eventBus.sendAuditEvent).toHaveBeenCalledWith({
			eventName: 'n8n.audit.git-connection.applied',
			payload: {
				...redactedUser,
				connectionId: 'connection-1',
				branchName: 'production',
				commitSha: 'def456',
				counts: { workflows: { created: 1, updated: 2 } },
			},
		});
	});
});
