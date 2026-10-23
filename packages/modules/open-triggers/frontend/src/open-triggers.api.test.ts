import { getOpenTriggers, getPublishViolations } from './open-triggers.api';

const makeRestApiRequest = vi.fn();
vi.mock('@n8n/rest-api-client', async (importOriginal) => ({
	...(await importOriginal<object>()),
	makeRestApiRequest: async (...args: unknown[]) => await makeRestApiRequest(...args),
}));

const context = { baseUrl: 'http://localhost:5678/rest', pushRef: '' };

describe('open triggers API', () => {
	it('reads the open triggers of the published workflows', async () => {
		makeRestApiRequest.mockResolvedValue([]);

		expect(await getOpenTriggers(context)).toEqual([]);
		expect(makeRestApiRequest).toHaveBeenCalledWith(context, 'GET', '/open-triggers');
	});

	it('reads the violations that would stop a publish of a workflow', async () => {
		makeRestApiRequest.mockResolvedValue([]);

		expect(await getPublishViolations(context, 'wf-1')).toEqual([]);
		expect(makeRestApiRequest).toHaveBeenCalledWith(
			context,
			'GET',
			'/open-triggers/workflows/wf-1/violations',
		);
	});
});
