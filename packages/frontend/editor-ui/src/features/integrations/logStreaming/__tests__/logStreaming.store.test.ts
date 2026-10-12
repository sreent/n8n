import * as eventbusApi from '@n8n/rest-api-client/api/eventbus';
import type { EventDestination } from '@n8n/rest-api-client/api/eventbus';
import { createPinia, setActivePinia } from 'pinia';

import { useLogStreamingStore } from '../logStreaming.store';

vi.mock('@n8n/rest-api-client/api/eventbus', () => ({
	getEventDestinations: vi.fn(),
	getEventNames: vi.fn(),
	saveEventDestination: vi.fn(),
	deleteEventDestination: vi.fn(),
	sendTestEventToDestination: vi.fn(),
}));

const webhook = (id: string, label = 'SIEM'): EventDestination => ({
	id,
	__type: '$$MessageEventBusDestinationWebhook',
	label,
	enabled: true,
	url: 'https://example.com/events',
});

describe('useLogStreamingStore', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		vi.resetAllMocks();
	});

	it('loads the destinations and the event names', async () => {
		vi.mocked(eventbusApi.getEventDestinations).mockResolvedValue([webhook('a')]);
		vi.mocked(eventbusApi.getEventNames).mockResolvedValue(['n8n.audit.user.deleted']);
		const store = useLogStreamingStore();

		await Promise.all([store.fetchDestinations(), store.fetchEventNames()]);

		expect(store.destinations).toEqual([webhook('a')]);
		expect(store.eventNames).toEqual(['n8n.audit.user.deleted']);
	});

	it('adds a new destination, and replaces a changed one in place', async () => {
		vi.mocked(eventbusApi.getEventDestinations).mockResolvedValue([webhook('a'), webhook('b')]);
		const store = useLogStreamingStore();
		await store.fetchDestinations();

		vi.mocked(eventbusApi.saveEventDestination).mockResolvedValueOnce(webhook('a', 'Changed'));
		await store.saveDestination({ ...webhook('a'), label: 'Changed' });
		vi.mocked(eventbusApi.saveEventDestination).mockResolvedValueOnce(webhook('c'));
		const saved = await store.saveDestination({ __type: '$$MessageEventBusDestinationWebhook' });

		expect(saved.id).toBe('c');
		expect(store.destinations.map(({ id, label }) => [id, label])).toEqual([
			['a', 'Changed'],
			['b', 'SIEM'],
			['c', 'SIEM'],
		]);
	});

	it('deletes a destination, and sends a test event', async () => {
		vi.mocked(eventbusApi.getEventDestinations).mockResolvedValue([webhook('a'), webhook('b')]);
		vi.mocked(eventbusApi.sendTestEventToDestination).mockResolvedValue(true);
		const store = useLogStreamingStore();
		await store.fetchDestinations();

		await store.deleteDestination('a');

		expect(eventbusApi.deleteEventDestination).toHaveBeenCalledWith(expect.anything(), 'a');
		expect(store.destinations.map(({ id }) => id)).toEqual(['b']);
		await expect(store.sendTestEvent('b')).resolves.toBe(true);
	});

	it('keeps the list when the backend rejects a deletion', async () => {
		vi.mocked(eventbusApi.getEventDestinations).mockResolvedValue([webhook('a')]);
		vi.mocked(eventbusApi.deleteEventDestination).mockRejectedValue(new Error('Conflict'));
		const store = useLogStreamingStore();
		await store.fetchDestinations();

		await expect(store.deleteDestination('a')).rejects.toThrow('Conflict');
		expect(store.destinations).toHaveLength(1);
	});
});
