import {
	AUDIT_LOG_DEFAULT_PAGE_SIZE,
	AUDIT_LOG_MAX_PAGE_SIZE,
	AuditLogEventsQueryDto,
	AuditLogExportQueryDto,
} from '../audit-log.dto';

describe('AuditLogEventsQueryDto', () => {
	test('uses the first page by default', () => {
		const result = AuditLogEventsQueryDto.safeParse({});

		expect(result.success).toBe(true);
		expect(result.data).toEqual({ skip: 0, take: AUDIT_LOG_DEFAULT_PAGE_SIZE });
	});

	test('reads the filters and the page from a query string', () => {
		const result = AuditLogEventsQueryDto.safeParse({
			from: '2026-10-01T00:00:00Z',
			to: '2026-10-02T00:00:00+02:00',
			eventName: 'n8n.audit.user.',
			projectType: 'team',
			skip: '50',
			take: '1000',
		});

		expect(result.success).toBe(true);
		expect(result.data).toEqual({
			from: new Date('2026-10-01T00:00:00Z'),
			to: new Date('2026-10-01T22:00:00Z'),
			eventName: 'n8n.audit.user.',
			projectType: 'team',
			skip: 50,
			take: AUDIT_LOG_MAX_PAGE_SIZE,
		});
	});

	test.each([
		{ name: 'a page size of 0', request: { take: '0' } },
		{ name: 'a negative skip', request: { skip: '-1' } },
		{ name: 'a skip that is not a whole number', request: { skip: '1.5' } },
		{ name: 'a time without an offset', request: { from: '2026-10-01T00:00:00' } },
		{ name: 'a time with an impossible offset', request: { from: '2026-10-01T00:00:00+99:99' } },
		{ name: 'an unknown project type', request: { projectType: 'public' } },
	])('rejects $name', ({ request }) => {
		expect(AuditLogEventsQueryDto.safeParse(request).success).toBe(false);
	});
});

describe('AuditLogExportQueryDto', () => {
	test('exports CSV by default', () => {
		expect(AuditLogExportQueryDto.safeParse({}).data).toEqual({ format: 'csv' });
	});

	test('rejects an unknown format', () => {
		expect(AuditLogExportQueryDto.safeParse({ format: 'xml' }).success).toBe(false);
	});
});
