import { ResponseError } from '@n8n/rest-api-client';

import { exportAuditLog, getAuditLogEventNames, getAuditLogEvents } from './audit-log.api';

const makeRestApiRequest = vi.fn();
vi.mock('@n8n/rest-api-client', async (importOriginal) => ({
	...(await importOriginal<object>()),
	makeRestApiRequest: async (...args: unknown[]) => await makeRestApiRequest(...args),
}));

vi.mock('@n8n/constants', async (importOriginal) => ({
	...(await importOriginal<object>()),
	getBrowserId: () => 'browser-1',
}));

const context = { baseUrl: 'http://localhost:5678/rest', pushRef: '' };

describe('audit log API', () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('reads a page of events with the filters that are set', async () => {
		makeRestApiRequest.mockResolvedValue({ count: 0, events: [] });

		await getAuditLogEvents(context, { eventName: 'n8n.audit.user.', userId: '' }, 50, 25);

		expect(makeRestApiRequest).toHaveBeenCalledWith(context, 'GET', '/audit-log/events', {
			eventName: 'n8n.audit.user.',
			skip: 50,
			take: 25,
		});
	});

	it('reads the event names', async () => {
		makeRestApiRequest.mockResolvedValue(['n8n.audit.user.login.success']);

		await expect(getAuditLogEventNames(context)).resolves.toEqual(['n8n.audit.user.login.success']);
		expect(makeRestApiRequest).toHaveBeenCalledWith(context, 'GET', '/audit-log/event-names');
	});

	it('downloads the export with the browser id and the file name of the response', async () => {
		fetchMock.mockResolvedValue(
			new Response('timestamp,eventName\r\n', {
				status: 200,
				headers: { 'Content-Disposition': 'attachment; filename="audit-log-2026-10-11.csv"' },
			}),
		);

		const file = await exportAuditLog(
			context,
			{ from: '2026-10-01T00:00:00.000Z', eventName: 'n8n.audit.user.' },
			'csv',
		);

		expect(fetchMock).toHaveBeenCalledWith(
			'http://localhost:5678/rest/audit-log/export?from=2026-10-01T00%3A00%3A00.000Z&eventName=n8n.audit.user.&format=csv',
			{ credentials: 'include', headers: { 'browser-id': 'browser-1' } },
		);
		expect(file.fileName).toBe('audit-log-2026-10-11.csv');
		expect(file.blob.size).toBe('timestamp,eventName\r\n'.length);
	});

	it('names the file after the format when the response gives no name', async () => {
		fetchMock.mockResolvedValue(new Response('[]', { status: 200 }));

		const file = await exportAuditLog(context, {}, 'json');

		expect(file.fileName).toBe('audit-log.json');
	});

	it('throws the message of an error response', async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ code: 403, message: 'User is missing a scope' }), {
				status: 403,
			}),
		);

		const error = await exportAuditLog(context, {}, 'csv').catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ResponseError);
		expect(error).toMatchObject({ message: 'User is missing a scope', httpStatusCode: 403 });
	});

	it('throws the status text when the error response is not JSON', async () => {
		fetchMock.mockResolvedValue(
			new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
		);

		await expect(exportAuditLog(context, {}, 'csv')).rejects.toMatchObject({
			message: 'Bad Gateway',
			httpStatusCode: 502,
		});
	});
});
