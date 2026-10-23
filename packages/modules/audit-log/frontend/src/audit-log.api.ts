import type { AuditLogEventsPage, AuditLogExportFormat } from '@n8n/api-types';
import { getBrowserId } from '@n8n/constants';
import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest, ResponseError } from '@n8n/rest-api-client';
import { isRecord } from '@n8n/utils/is-record';

/** The filters of the list and of the export. The backend uses each filter that is set. */
export interface AuditLogFilters {
	/** A time in ISO 8601 with an offset. The bound is included. */
	from?: string;
	/** A time in ISO 8601 with an offset. The bound is included. */
	to?: string;
	/** An event name, or a prefix that ends with a dot, for example `n8n.audit.user.`. */
	eventName?: string;
	userId?: string;
	/** `personal` gives the events of the personal spaces of users. */
	projectType?: AuditLogProjectType;
}

export type AuditLogProjectType = 'personal' | 'team';

export interface AuditLogExportFile {
	blob: Blob;
	fileName: string;
}

const FILTER_KEYS = ['from', 'to', 'eventName', 'userId', 'projectType'] as const;

const definedFilters = (filters: AuditLogFilters) => {
	const defined: Partial<Record<(typeof FILTER_KEYS)[number], string>> = {};
	for (const key of FILTER_KEYS) {
		const value = filters[key];
		if (value) defined[key] = value;
	}
	return defined;
};

export async function getAuditLogEvents(
	context: IRestApiContext,
	filters: AuditLogFilters,
	skip: number,
	take: number,
): Promise<AuditLogEventsPage> {
	return await makeRestApiRequest(context, 'GET', '/audit-log/events', {
		...definedFilters(filters),
		skip,
		take,
	});
}

export async function getAuditLogEventNames(context: IRestApiContext): Promise<string[]> {
	return await makeRestApiRequest(context, 'GET', '/audit-log/event-names');
}

/** The message of an error response of the REST API, else the status text. */
async function errorMessage(response: Response) {
	try {
		const body: unknown = await response.json();
		if (isRecord(body) && typeof body.message === 'string') return body.message;
	} catch {
		// The body is not JSON. The status text follows.
	}
	return response.statusText || String(response.status);
}

/** The file name from the `Content-Disposition` header, else a default name. */
function fileNameOf(response: Response, format: AuditLogExportFormat) {
	const header = response.headers.get('content-disposition') ?? '';
	return /filename="([^"]+)"/.exec(header)?.[1] ?? `audit-log.${format}`;
}

/**
 * Reads the export file of the events that match the filters. A download link cannot send the
 * `browser-id` header that the REST API needs, so this function uses `fetch`.
 */
export async function exportAuditLog(
	context: IRestApiContext,
	filters: AuditLogFilters,
	format: AuditLogExportFormat,
): Promise<AuditLogExportFile> {
	const query = new URLSearchParams({ ...definedFilters(filters), format });
	const response = await fetch(`${context.baseUrl}/audit-log/export?${query.toString()}`, {
		credentials: 'include',
		headers: { 'browser-id': getBrowserId() },
	});
	if (!response.ok) {
		throw new ResponseError(await errorMessage(response), { httpStatusCode: response.status });
	}
	return { blob: await response.blob(), fileName: fileNameOf(response, format) };
}
