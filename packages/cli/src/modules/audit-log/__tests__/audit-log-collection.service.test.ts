import type { Logger } from '@n8n/backend-common';
import { mockLogger } from '@n8n/backend-test-utils';
import { DateTime } from 'luxon';
import { mock } from 'vitest-mock-extended';

import { EventMessageAudit } from '@/eventbus/event-message-classes/event-message-audit';
import { EventMessageWorkflow } from '@/eventbus/event-message-classes/event-message-workflow';
import type { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';

import { AuditLogCollectionService, toAuditLogEventRow } from '../audit-log-collection.service';
import type { AuditLogProjectsService } from '../audit-log-projects.service';
import { AuditLogConfig } from '../audit-log.config';
import { FLUSH_BATCH_SIZE, MAX_BUFFERED_EVENTS } from '../audit-log.constants';
import type { AuditLogEventRepository } from '../database/audit-log-event.repository';

const loginEvent = (id = 'event-1') =>
	new EventMessageAudit({
		id,
		eventName: 'n8n.audit.user.login.success',
		ts: DateTime.fromISO('2026-10-01T10:00:00.000Z'),
		payload: {
			userId: 'user-1',
			_email: 'ann@example.com',
			_firstName: 'Ann',
			authenticationMethod: 'email',
		},
	});

describe('toAuditLogEventRow', () => {
	it('keeps the name, the time, the user and the payload', () => {
		expect(toAuditLogEventRow(loginEvent())).toEqual({
			id: 'event-1',
			eventName: 'n8n.audit.user.login.success',
			timestamp: new Date('2026-10-01T10:00:00.000Z'),
			userId: 'user-1',
			userEmail: 'ann@example.com',
			projectId: null,
			projectType: null,
			payload: {
				userId: 'user-1',
				_email: 'ann@example.com',
				_firstName: 'Ann',
				authenticationMethod: 'email',
			},
		});
	});

	it('keeps the project that the payload names', () => {
		const event = new EventMessageAudit({
			eventName: 'n8n.audit.user.credentials.created',
			payload: { credentialId: 'cred-1', projectId: 'project-1', projectType: 'personal' },
		});
		expect(toAuditLogEventRow(event)).toMatchObject({
			projectId: 'project-1',
			projectType: 'personal',
		});
	});

	it('keeps no project type without a project, and no id that does not fit its column', () => {
		const withoutProject = new EventMessageAudit({
			eventName: 'n8n.audit.user.credentials.created',
			payload: { projectType: 'team' },
		});
		expect(toAuditLogEventRow(withoutProject)).toMatchObject({
			projectId: null,
			projectType: null,
		});

		const longProjectId = new EventMessageAudit({
			eventName: 'n8n.audit.workflow.executed',
			payload: { projectId: 'p'.repeat(37) },
		});
		expect(toAuditLogEventRow(longProjectId)).toMatchObject({ projectId: null });
	});

	it('takes the e-mail address from userEmail when the payload has no _email', () => {
		const event = new EventMessageAudit({
			eventName: 'n8n.audit.user.login.failed',
			payload: { userEmail: 'bob@example.com' },
		});
		expect(toAuditLogEventRow(event)).toMatchObject({
			userId: null,
			userEmail: 'bob@example.com',
		});
	});

	it('gives null for a payload without a user', () => {
		const event = new EventMessageAudit({ eventName: 'n8n.audit.package.installed' });
		expect(toAuditLogEventRow(event)).toMatchObject({ userId: null, userEmail: null, payload: {} });
	});

	it('gives null for a user id or an e-mail address that does not fit its column', () => {
		const longUserId = 'u'.repeat(37);
		const longEmail = `${'a'.repeat(243)}@example.com`;
		const event = new EventMessageAudit({
			eventName: 'n8n.audit.user.login.failed',
			payload: { userId: longUserId, _email: longEmail, userEmail: 'bob@example.com' },
		});
		expect(toAuditLogEventRow(event)).toMatchObject({
			userId: null,
			userEmail: 'bob@example.com',
			payload: { userId: longUserId, _email: longEmail },
		});
	});
});

describe('AuditLogCollectionService', () => {
	let config: AuditLogConfig;
	let repository: ReturnType<typeof mock<AuditLogEventRepository>>;
	let eventBus: ReturnType<typeof mock<MessageEventBus>>;
	let projects: ReturnType<typeof mock<AuditLogProjectsService>>;
	let service: AuditLogCollectionService;

	beforeEach(() => {
		config = new AuditLogConfig();
		repository = mock<AuditLogEventRepository>();
		eventBus = mock<MessageEventBus>();
		projects = mock<AuditLogProjectsService>();
		service = new AuditLogCollectionService(mockLogger(), eventBus, repository, config, projects);
	});

	afterEach(async () => {
		await service.shutdown();
	});

	it('listens to each sent message of the event bus, and stops on shutdown', async () => {
		service.init();
		expect(eventBus.on).toHaveBeenCalledWith('metrics.eventBus.event', expect.any(Function));
		expect(projects.init).toHaveBeenCalled();

		await service.shutdown();
		expect(eventBus.off).toHaveBeenCalledWith('metrics.eventBus.event', expect.any(Function));
		expect(projects.shutdown).toHaveBeenCalled();
	});

	it('finds the projects of a batch before it writes the batch', async () => {
		projects.addProjects.mockImplementation(async (rows) => {
			for (const row of rows) {
				row.projectId = 'project-1';
				row.projectType = 'team';
			}
		});
		service.collect(loginEvent());
		await service.flush();

		expect(projects.addProjects).toHaveBeenCalledTimes(1);
		expect(repository.insertIgnoringDuplicates).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'event-1', projectId: 'project-1', projectType: 'team' }),
		]);
	});

	it('stores the events without a project when the search for the projects fails', async () => {
		const scopedLogger = mock<Logger>();
		const logger = mock<Logger>({ scoped: vi.fn().mockReturnValue(scopedLogger) });
		service = new AuditLogCollectionService(logger, eventBus, repository, config, projects);
		projects.addProjects.mockRejectedValue(new Error('query failed'));
		service.collect(loginEvent('event-1'));
		await service.flush();
		service.collect(loginEvent('event-2'));
		await service.flush();

		const stored = repository.insertIgnoringDuplicates.mock.calls.flatMap(([batch]) => batch);
		expect(stored).toEqual([
			expect.objectContaining({ id: 'event-1', projectId: null }),
			expect.objectContaining({ id: 'event-2', projectId: null }),
		]);
		// One warning until a search works again, not one for each flush.
		expect(scopedLogger.warn).toHaveBeenCalledTimes(1);
	});

	it('stores audit events and leaves out other events', async () => {
		service.collect(loginEvent());
		service.collect(new EventMessageWorkflow({ eventName: 'n8n.workflow.started' }));
		await service.flush();

		expect(repository.insertIgnoringDuplicates).toHaveBeenCalledTimes(1);
		expect(repository.insertIgnoringDuplicates).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'event-1', eventName: 'n8n.audit.user.login.success' }),
		]);
	});

	it('leaves out excluded names and prefixes', async () => {
		config.excludedEvents = ['n8n.audit.workflow.executed', 'n8n.audit.package.'];
		service.collect(new EventMessageAudit({ eventName: 'n8n.audit.workflow.executed' }));
		service.collect(new EventMessageAudit({ eventName: 'n8n.audit.package.installed' }));
		service.collect(
			new EventMessageAudit({ eventName: 'n8n.audit.workflow.executedLater' as never }),
		);
		await service.flush();

		expect(repository.insertIgnoringDuplicates).toHaveBeenCalledWith([
			expect.objectContaining({ eventName: 'n8n.audit.workflow.executedLater' }),
		]);
	});

	it('writes at once when the buffer holds a full batch', async () => {
		for (let index = 0; index < FLUSH_BATCH_SIZE; index++) {
			service.collect(loginEvent(`event-${index}`));
		}
		await vi.waitFor(() => expect(repository.insertIgnoringDuplicates).toHaveBeenCalledTimes(1));
		expect(repository.insertIgnoringDuplicates.mock.calls[0][0]).toHaveLength(FLUSH_BATCH_SIZE);
	});

	it('writes large buffers in batches', async () => {
		repository.insertIgnoringDuplicates.mockResolvedValue();
		vi.spyOn(service, 'flush').mockImplementationOnce(async () => {});
		for (let index = 0; index < FLUSH_BATCH_SIZE + 1; index++) {
			service.collect(loginEvent(`event-${index}`));
		}
		await service.flush();

		const sizes = repository.insertIgnoringDuplicates.mock.calls.map(([batch]) => batch.length);
		expect(sizes).toEqual([FLUSH_BATCH_SIZE, 1]);
	});

	it('keeps the events after a failed write, and writes them in the next flush', async () => {
		repository.insertIgnoringDuplicates.mockRejectedValueOnce(new Error('database is locked'));
		service.collect(loginEvent());
		await service.flush();
		await service.flush();

		expect(repository.insertIgnoringDuplicates).toHaveBeenCalledTimes(2);
		expect(repository.insertIgnoringDuplicates.mock.calls[1][0]).toEqual([
			expect.objectContaining({ id: 'event-1' }),
		]);
	});

	it('drops new events while the buffer is full', async () => {
		repository.insertIgnoringDuplicates.mockRejectedValue(new Error('database is down'));
		for (let index = 0; index < MAX_BUFFERED_EVENTS + 5; index++) {
			service.collect(loginEvent(`event-${index}`));
		}
		await service.flush();

		repository.insertIgnoringDuplicates.mockReset();
		repository.insertIgnoringDuplicates.mockResolvedValue();
		await service.flush();

		const stored = repository.insertIgnoringDuplicates.mock.calls.flatMap(([batch]) => batch);
		expect(stored).toHaveLength(MAX_BUFFERED_EVENTS);
	});
});
