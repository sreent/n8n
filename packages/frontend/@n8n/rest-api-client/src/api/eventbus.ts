import type { IDataObject } from 'n8n-workflow';

import type { IRestApiContext } from '../types';
import { makeRestApiRequest } from '../utils';

/**
 * Fork code (not in upstream n8n): the client of the REST API of log streaming (`/eventbus`). It
 * replaces the enterprise `eventbus.ee.ts`.
 * packages/frontend/editor-ui/src/features/integrations/logStreaming/FORK.md describes it.
 */

/**
 * A log streaming destination to store. The other fields depend on `__type`. Without an id, the
 * backend adds a new destination.
 */
export interface EventDestinationInput extends IDataObject {
	id?: string;
	__type: string;
	label?: string;
	enabled?: boolean;
	subscribedEvents?: string[];
	anonymizeAuditMessages?: boolean;
}

/** A stored log streaming destination. */
export interface EventDestination extends EventDestinationInput {
	id: string;
}

/** The stored destinations, oldest first. */
export const getEventDestinations = async (
	context: IRestApiContext,
): Promise<EventDestination[]> => {
	return await makeRestApiRequest(context, 'GET', '/eventbus/destination');
};

/** Adds a destination, or changes the destination with the id. Gives the stored destination. */
export const saveEventDestination = async (
	context: IRestApiContext,
	destination: EventDestinationInput,
): Promise<EventDestination> => {
	return await makeRestApiRequest(context, 'POST', '/eventbus/destination', destination);
};

export const deleteEventDestination = async (
	context: IRestApiContext,
	id: string,
): Promise<boolean> => {
	return await makeRestApiRequest(context, 'DELETE', '/eventbus/destination', { id });
};

/** Sends a test event to a destination. Gives whether the destination took it. */
export const sendTestEventToDestination = async (
	context: IRestApiContext,
	id: string,
): Promise<boolean> => {
	return await makeRestApiRequest(context, 'GET', '/eventbus/testmessage', { id });
};

/** The names of the events that a destination can subscribe to. */
export const getEventNames = async (context: IRestApiContext): Promise<string[]> => {
	return await makeRestApiRequest(context, 'GET', '/eventbus/eventnames');
};
