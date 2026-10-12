/**
 * Fork code (not in upstream n8n): helpers of the settings page of log streaming. The FORK.md of
 * this folder describes them.
 */
import type { BaseTextKey, useI18n } from '@n8n/i18n';
import type { EventDestination, EventDestinationInput } from '@n8n/rest-api-client/api/eventbus';
import {
	defaultMessageEventBusDestinationSentryOptions,
	defaultMessageEventBusDestinationSyslogOptions,
	defaultMessageEventBusDestinationWebhookOptions,
	deepCopy,
	type IDataObject,
} from 'n8n-workflow';

/** An entry of `subscribedEvents` that subscribes to all events. */
export const ALL_EVENTS = '*';

/** The group of the audit events, whose payloads the anonymization changes. */
export const AUDIT_GROUP = 'n8n.audit';

/** The destination types of the settings page, in the order of the type select. */
export const DESTINATION_TYPES = [
	'$$MessageEventBusDestinationWebhook',
	'$$MessageEventBusDestinationSentry',
	'$$MessageEventBusDestinationSyslog',
] as const;

export type DestinationType = (typeof DESTINATION_TYPES)[number];

export const isDestinationType = (value: unknown): value is DestinationType =>
	DESTINATION_TYPES.some((type) => type === value);

const DEFAULTS: Record<DestinationType, object> = {
	$$MessageEventBusDestinationWebhook: defaultMessageEventBusDestinationWebhookOptions,
	$$MessageEventBusDestinationSentry: defaultMessageEventBusDestinationSentryOptions,
	$$MessageEventBusDestinationSyslog: defaultMessageEventBusDestinationSyslogOptions,
};

/**
 * A new destination of a type: the defaults of the type, off. The backend gives it an id when
 * the page saves it.
 */
export function newDestination(type: DestinationType, label: string): EventDestinationInput {
	const { id: _id, ...defaults }: IDataObject = deepCopy({ ...DEFAULTS[type] });
	return { ...defaults, __type: type, label, enabled: false };
}

/** The type of a destination, else `undefined`. */
export function destinationType(destination: EventDestination | EventDestinationInput) {
	return isDestinationType(destination.__type) ? destination.__type : undefined;
}

export interface EventGroup {
	/** The first two parts of the event names, for example `n8n.audit`. */
	name: string;
	events: string[];
}

/** The group of an event: the first two parts of its name. */
export function groupOf(eventName: string) {
	return eventName.split('.').slice(0, 2).join('.');
}

/** The events by group, in the order of the first event of each group. */
export function eventGroups(eventNames: readonly string[]): EventGroup[] {
	const groups = new Map<string, string[]>();
	for (const name of eventNames) {
		const group = groupOf(name);
		groups.set(group, [...(groups.get(group) ?? []), name]);
	}
	return [...groups].map(([name, events]) => ({ name, events }));
}

/** Whether the destination subscribes to the whole group. */
export function isGroupSubscribed(subscribedEvents: readonly string[], group: string) {
	return (
		subscribedEvents.includes(ALL_EVENTS) ||
		subscribedEvents.includes(group) ||
		subscribedEvents.includes(`${group}.`)
	);
}

/** Whether the destination subscribes to the event, by its name or by its group. */
export function isEventSubscribed(subscribedEvents: readonly string[], eventName: string) {
	return (
		isGroupSubscribed(subscribedEvents, groupOf(eventName)) || subscribedEvents.includes(eventName)
	);
}

/**
 * The subscriptions with a group on or off. On replaces the single events of the group with the
 * group. When the destination subscribes to all events, off keeps all other groups.
 */
export function withGroup(
	subscribedEvents: readonly string[],
	group: string,
	on: boolean,
	allGroups: readonly string[],
): string[] {
	const entries = subscribedEvents.includes(ALL_EVENTS)
		? [...allGroups]
		: subscribedEvents.filter((entry) => entry !== ALL_EVENTS);
	const others = entries.filter(
		(entry) => entry !== group && entry !== `${group}.` && groupOf(entry) !== group,
	);
	return on ? [...others, group] : others;
}

/** The subscriptions with one event on or off. */
export function withEvent(subscribedEvents: readonly string[], eventName: string, on: boolean) {
	const others = subscribedEvents.filter((entry) => entry !== eventName);
	return on ? [...others, eventName] : others;
}

/** The text of a key that the code builds, else the fallback. */
export function textOrFallback(
	i18n: ReturnType<typeof useI18n>,
	key: string,
	fallback: string,
): string {
	const isKey = (candidate: string): candidate is BaseTextKey => i18n.exists(candidate);
	return isKey(key) ? i18n.baseText(key) : fallback;
}

/** The name of a destination type, for example "Webhook". */
export function typeLabel(i18n: ReturnType<typeof useI18n>, type: string) {
	return textOrFallback(i18n, `settings.log-streaming.${type}`, type);
}
