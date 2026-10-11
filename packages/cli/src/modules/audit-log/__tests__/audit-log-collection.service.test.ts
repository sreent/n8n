import { mockLogger } from '@n8n/backend-test-utils';
import { DateTime } from 'luxon';
import { mock } from 'vitest-mock-extended';

import { EventMessageAudit } from '@/eventbus/event-message-classes/event-message-audit';
import { EventMessageWorkflow } from '@/eventbus/event-message-classes/event-message-workflow';
import type { MessageEventBus } from '@/eventbus/message-event-bus/message-event-bus';

import { AuditLogCollectionService, toAuditLogEventRow } from '../audit-log-collection.service';
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
			payload: {
				userId: 'user-1',
				_email: 'ann@example.com',
				_firstName: 'Ann',
				authenticationMethod: 'email',
			},
		});
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
	let service: AuditLogCollectionService;

	beforeEach(() => {
		config = new AuditLogConfig();
		repository = mock<AuditLogEventRepository>();
		eventBus = mock<MessageEventBus>();
		service = new AuditLogCollectionService(mockLogger(), eventBus, repository, config);
	});

	afterEach(async () => {
		await service.shutdown();
	});

	it('listens to each sent message of the event bus, and stops on shutdown', async () => {
		service.init();
		expect(eventBus.on).toHaveBeenCalledWith('metrics.eventBus.event', expect.any(Function));

		await service.shutdown();
		expect(eventBus.off).toHaveBeenCalledWith('metrics.eventBus.event', expect.any(Function));
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
