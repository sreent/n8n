import type { DateValue } from '@n8n/design-system';

import { AUDIT_EVENT_PREFIX } from './audit-log.constants';

export interface EventNameOption {
	/** An event name, or a prefix that ends with a dot. */
	value: string;
	label: string;
}

/** The group of an event: its name up to the dot after the prefix, for example `n8n.audit.user.`. */
function groupOf(eventName: string) {
	if (!eventName.startsWith(AUDIT_EVENT_PREFIX)) return eventName;
	const dot = eventName.indexOf('.', AUDIT_EVENT_PREFIX.length);
	return dot === -1 ? eventName : eventName.slice(0, dot + 1);
}

/**
 * The options of the event filter, in the order of the names. Each group of two or more events
 * starts with an option for the full group (`n8n.audit.user.*`).
 */
export function toEventNameOptions(eventNames: string[]): EventNameOption[] {
	const groups = new Map<string, string[]>();
	for (const name of [...eventNames].sort()) {
		const group = groupOf(name);
		groups.set(group, [...(groups.get(group) ?? []), name]);
	}
	return [...groups].flatMap(([group, names]) => [
		...(names.length > 1 ? [{ value: group, label: `${group}*` }] : []),
		...names.map((name) => ({ value: name, label: name })),
	]);
}

const localDate = (day: DateValue) => new Date(day.year, day.month - 1, day.day);

/** The start of a calendar day in the local time zone, in ISO 8601. */
export function startOfDay(day: DateValue) {
	return localDate(day).toISOString();
}

/** The last millisecond of a calendar day in the local time zone, in ISO 8601. */
export function endOfDay(day: DateValue) {
	const nextDay = new Date(day.year, day.month - 1, day.day + 1);
	return new Date(nextDay.getTime() - 1).toISOString();
}

/** A time in the format of the locale of the browser, with seconds. */
export function formatTimestamp(timestamp: string, locale?: string) {
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(
		new Date(timestamp),
	);
}

/** A calendar day in the format of the locale of the browser. */
export function formatDay(day: DateValue, locale?: string) {
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(localDate(day));
}

/** How long the browser keeps the file of a download, so that the download can start. */
const DOWNLOAD_URL_LIFETIME_MS = 60_000;

/** Saves a file in the browser, as a download. */
export function saveFile(blob: Blob, fileName: string) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = fileName;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
}
