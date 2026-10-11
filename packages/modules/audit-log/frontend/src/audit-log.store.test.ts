import { CalendarDate } from '@internationalized/date';
import { createPinia, setActivePinia } from 'pinia';

import type { AuditLogEventsPage } from './audit-log.api';
import { DEFAULT_PAGE_SIZE } from './audit-log.constants';
import { useAuditLogStore } from './audit-log.store';

vi.mock('@n8n/stores/useRootStore', () => ({
	useRootStore: () => ({ restApiContext: { baseUrl: '/rest', pushRef: '' } }),
}));

type ApiMock = (...args: unknown[]) => Promise<unknown>;
const getEventsMock = vi.fn<ApiMock>();
const getEventNamesMock = vi.fn<ApiMock>();
const exportMock = vi.fn<ApiMock>();
vi.mock('./audit-log.api', () => ({
	getAuditLogEvents: async (...args: unknown[]) => await getEventsMock(...args),
	getAuditLogEventNames: async (...args: unknown[]) => await getEventNamesMock(...args),
	exportAuditLog: async (...args: unknown[]) => await exportMock(...args),
}));

const context = { baseUrl: '/rest', pushRef: '' };

const page = (ids: string[], count = ids.length): AuditLogEventsPage => ({
	count,
	events: ids.map((id) => ({
		id,
		eventName: 'n8n.audit.user.login.success',
		timestamp: '2026-10-01T08:00:00.000Z',
		userId: 'user-1',
		userEmail: 'ann@example.com',
		payload: {},
	})),
});

/** A promise that the test resolves later. */
function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('useAuditLogStore', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setActivePinia(createPinia());
	});

	it('reads the page of events that the filters and the page select', async () => {
		getEventsMock.mockResolvedValue(page(['e1', 'e2'], 120));
		const store = useAuditLogStore();
		store.setFilters({ eventName: 'n8n.audit.user.' });
		store.page = 2;

		await store.fetchEvents();

		expect(getEventsMock).toHaveBeenCalledWith(
			context,
			{ eventName: 'n8n.audit.user.' },
			2 * DEFAULT_PAGE_SIZE,
			DEFAULT_PAGE_SIZE,
		);
		expect(store.events.map(({ id }) => id)).toEqual(['e1', 'e2']);
		expect(store.count).toBe(120);
		expect(store.loading).toBe(false);
	});

	it('keeps the newest list when an older request ends later', async () => {
		const first = deferred<AuditLogEventsPage>();
		const second = deferred<AuditLogEventsPage>();
		getEventsMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const store = useAuditLogStore();

		const firstRequest = store.fetchEvents();
		const secondRequest = store.fetchEvents();
		second.resolve(page(['new']));
		await secondRequest;
		first.resolve(page(['old']));
		await firstRequest;

		expect(store.events.map(({ id }) => id)).toEqual(['new']);
		expect(store.loading).toBe(false);
	});

	it('stops loading when the request fails', async () => {
		getEventsMock.mockRejectedValue(new Error('Database is down'));
		const store = useAuditLogStore();

		await expect(store.fetchEvents()).rejects.toThrow('Database is down');
		expect(store.loading).toBe(false);
	});

	it('goes back to the first page when a filter changes', () => {
		const store = useAuditLogStore();
		store.page = 3;

		store.setFilters({ userId: 'user-1' });
		store.setFilters({ eventName: 'n8n.audit.workflow.updated' });

		expect(store.page).toBe(0);
		expect(store.filters).toEqual({ userId: 'user-1', eventName: 'n8n.audit.workflow.updated' });
		expect(store.hasFilters).toBe(true);
	});

	it('filters by whole local days and includes both days', () => {
		const store = useAuditLogStore();
		const range = { start: new CalendarDate(2026, 10, 1), end: new CalendarDate(2026, 10, 3) };

		store.setDateRange(range);

		expect(store.dateRange).toEqual(range);
		expect(store.filters).toEqual({
			from: new Date(2026, 9, 1).toISOString(),
			to: new Date(new Date(2026, 9, 4).getTime() - 1).toISOString(),
		});
	});

	it('clears the filters, the date range and the page', () => {
		const store = useAuditLogStore();
		store.setDateRange({ start: new CalendarDate(2026, 10, 1), end: undefined });
		store.setFilters({ userId: 'user-1' });
		store.page = 2;

		store.clearFilters();

		expect(store.filters).toEqual({});
		expect(store.dateRange).toEqual({ start: undefined, end: undefined });
		expect(store.page).toBe(0);
		expect(store.hasFilters).toBe(false);
	});

	it('reads the event names', async () => {
		getEventNamesMock.mockResolvedValue(['n8n.audit.user.login.success']);
		const store = useAuditLogStore();

		await store.fetchEventNames();

		expect(store.eventNames).toEqual(['n8n.audit.user.login.success']);
	});

	it('exports the events that match the filters', async () => {
		const file = { blob: new Blob(['[]']), fileName: 'audit-log-2026-10-11.json' };
		const exported = deferred<typeof file>();
		exportMock.mockReturnValue(exported.promise);
		const store = useAuditLogStore();
		store.setFilters({ eventName: 'n8n.audit.user.' });

		const request = store.exportEvents('json');
		expect(store.exporting).toBe(true);
		exported.resolve(file);

		await expect(request).resolves.toBe(file);
		expect(exportMock).toHaveBeenCalledWith(context, { eventName: 'n8n.audit.user.' }, 'json');
		expect(store.exporting).toBe(false);
	});
});
