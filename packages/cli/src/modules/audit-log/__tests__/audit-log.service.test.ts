import { mock } from 'vitest-mock-extended';
import { text } from 'node:stream/consumers';

import { AuditLogService } from '../audit-log.service';
import { EXPORT_BATCH_SIZE } from '../audit-log.constants';
import type { AuditLogEvent } from '../database/audit-log-event.entity';
import type { AuditLogEventRepository } from '../database/audit-log-event.repository';

const event = (index: number, overrides: Partial<AuditLogEvent> = {}): AuditLogEvent =>
	({
		id: `event-${index}`,
		eventName: 'n8n.audit.workflow.updated',
		timestamp: new Date(Date.UTC(2026, 9, 1, 10, 0, 0) - index * 1000),
		userId: 'user-1',
		userEmail: 'ann@example.com',
		payload: { workflowId: 'wf-1', workflowName: 'Report' },
		...overrides,
	}) as AuditLogEvent;

describe('AuditLogService', () => {
	let repository: ReturnType<typeof mock<AuditLogEventRepository>>;
	let service: AuditLogService;

	beforeEach(() => {
		repository = mock<AuditLogEventRepository>();
		service = new AuditLogService(repository);
	});

	it('lists a page of events with ISO times', async () => {
		repository.findPage.mockResolvedValue({ count: 7, events: [event(0)] });

		const result = await service.listEvents({ userId: 'user-1' }, 5, 1);

		expect(repository.findPage).toHaveBeenCalledWith({ userId: 'user-1' }, 5, 1);
		expect(result).toEqual({
			count: 7,
			events: [
				{
					id: 'event-0',
					eventName: 'n8n.audit.workflow.updated',
					timestamp: '2026-10-01T10:00:00.000Z',
					userId: 'user-1',
					userEmail: 'ann@example.com',
					payload: { workflowId: 'wf-1', workflowName: 'Report' },
				},
			],
		});
	});

	it('gives the names of the audit events', () => {
		const names = service.eventNames();
		expect(names).toContain('n8n.audit.user.login.success');
		expect(names).toContain('n8n.audit.mcp.tool.called');
		expect(names.every((name) => name.startsWith('n8n.audit.'))).toBe(true);
	});

	describe('export', () => {
		const now = new Date('2026-10-11T08:00:00.000Z');

		it('names the file after the date and the format', () => {
			repository.findBatch.mockResolvedValue([]);
			expect(service.exportEvents({}, 'csv', now)).toMatchObject({
				contentType: 'text/csv; charset=utf-8',
				fileName: 'audit-log-2026-10-11.csv',
			});
			expect(service.exportEvents({}, 'json', now)).toMatchObject({
				contentType: 'application/json; charset=utf-8',
				fileName: 'audit-log-2026-10-11.json',
			});
		});

		it('writes a CSV file with quoted cells and safe formulas', async () => {
			repository.findBatch.mockResolvedValueOnce([
				event(0, { userEmail: '=HYPERLINK("x")', payload: { note: 'a,b' } }),
				event(1, { userId: null, userEmail: null }),
			]);

			const csv = await text(service.exportEvents({}, 'csv', now).stream);

			expect(csv.split('\r\n')).toEqual([
				'timestamp,eventName,userId,userEmail,payload',
				'2026-10-01T10:00:00.000Z,n8n.audit.workflow.updated,user-1,"\'=HYPERLINK(""x"")","{""note"":""a,b""}"',
				'2026-10-01T09:59:59.000Z,n8n.audit.workflow.updated,,,"{""workflowId"":""wf-1"",""workflowName"":""Report""}"',
				'',
			]);
		});

		it('writes a JSON array of all batches', async () => {
			const firstBatch = Array.from({ length: EXPORT_BATCH_SIZE }, (_, index) => event(index));
			repository.findBatch
				.mockResolvedValueOnce(firstBatch)
				.mockResolvedValueOnce([event(EXPORT_BATCH_SIZE)]);

			const json = await text(
				service.exportEvents({ eventName: 'n8n.audit.' }, 'json', now).stream,
			);
			const events = JSON.parse(json) as Array<{ id: string }>;

			expect(events).toHaveLength(EXPORT_BATCH_SIZE + 1);
			expect(events[EXPORT_BATCH_SIZE].id).toBe(`event-${EXPORT_BATCH_SIZE}`);
			const last = firstBatch[firstBatch.length - 1];
			expect(repository.findBatch).toHaveBeenNthCalledWith(
				1,
				{ eventName: 'n8n.audit.' },
				undefined,
				EXPORT_BATCH_SIZE,
			);
			expect(repository.findBatch).toHaveBeenNthCalledWith(
				2,
				{ eventName: 'n8n.audit.' },
				{ timestamp: last.timestamp, id: last.id },
				EXPORT_BATCH_SIZE,
			);
			expect(repository.findBatch).toHaveBeenCalledTimes(2);
		});

		it('writes an empty JSON array when no event matches', async () => {
			repository.findBatch.mockResolvedValue([]);
			expect(await text(service.exportEvents({}, 'json', now).stream)).toBe('[]');
		});
	});
});
