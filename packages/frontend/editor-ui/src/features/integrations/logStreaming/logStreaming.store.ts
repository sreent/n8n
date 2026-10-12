/**
 * Fork code (not in upstream n8n): the store of the log streaming destinations and of the event
 * names. The FORK.md of this folder describes it.
 */
import {
	deleteEventDestination,
	getEventDestinations,
	getEventNames,
	saveEventDestination,
	sendTestEventToDestination,
	type EventDestination,
	type EventDestinationInput,
} from '@n8n/rest-api-client/api/eventbus';
import { useRootStore } from '@n8n/stores/useRootStore';
import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useLogStreamingStore = defineStore('logStreaming', () => {
	const rootStore = useRootStore();

	/** The stored destinations, in the order of the backend: oldest first. */
	const destinations = ref<EventDestination[]>([]);
	const eventNames = ref<string[]>([]);

	async function fetchDestinations() {
		destinations.value = await getEventDestinations(rootStore.restApiContext);
	}

	async function fetchEventNames() {
		eventNames.value = await getEventNames(rootStore.restApiContext);
	}

	/** Stores a destination, and puts the stored form in the list. */
	async function saveDestination(destination: EventDestinationInput) {
		const saved = await saveEventDestination(rootStore.restApiContext, destination);
		const index = destinations.value.findIndex(({ id }) => id === saved.id);
		if (index === -1) destinations.value.push(saved);
		else destinations.value.splice(index, 1, saved);
		return saved;
	}

	async function deleteDestination(id: string) {
		await deleteEventDestination(rootStore.restApiContext, id);
		destinations.value = destinations.value.filter((destination) => destination.id !== id);
	}

	async function sendTestEvent(id: string) {
		return await sendTestEventToDestination(rootStore.restApiContext, id);
	}

	return {
		destinations,
		eventNames,
		fetchDestinations,
		fetchEventNames,
		saveDestination,
		deleteDestination,
		sendTestEvent,
	};
});
