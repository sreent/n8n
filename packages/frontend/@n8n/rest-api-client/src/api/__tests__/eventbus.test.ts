import type { IRestApiContext } from '../../types';
import { makeRestApiRequest } from '../../utils';
import {
	deleteEventDestination,
	getEventDestinations,
	getEventNames,
	saveEventDestination,
	sendTestEventToDestination,
} from '../eventbus';

vi.mock('../../utils', () => ({ makeRestApiRequest: vi.fn() }));

const context: IRestApiContext = { baseUrl: 'http://localhost:5678/rest', pushRef: 'push-ref' };

describe('the REST client of log streaming', () => {
	beforeEach(() => {
		vi.mocked(makeRestApiRequest).mockReset().mockResolvedValue(undefined);
	});

	it('sends each request to the REST API of log streaming', async () => {
		const destination = { __type: '$$MessageEventBusDestinationSyslog', host: 'logs' };

		await getEventDestinations(context);
		await saveEventDestination(context, destination);
		await deleteEventDestination(context, 'id-1');
		await sendTestEventToDestination(context, 'id-1');
		await getEventNames(context);

		expect(vi.mocked(makeRestApiRequest).mock.calls).toEqual([
			[context, 'GET', '/eventbus/destination'],
			[context, 'POST', '/eventbus/destination', destination],
			[context, 'DELETE', '/eventbus/destination', { id: 'id-1' }],
			[context, 'GET', '/eventbus/testmessage', { id: 'id-1' }],
			[context, 'GET', '/eventbus/eventnames'],
		]);
	});
});
