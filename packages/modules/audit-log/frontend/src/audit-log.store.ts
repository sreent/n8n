import {
	AUDIT_LOG_DEFAULT_PAGE_SIZE,
	type AuditLogEventResponse,
	type AuditLogExportFormat,
} from '@n8n/api-types';
import type { DateRange } from '@n8n/design-system';
import { useRootStore } from '@n8n/stores/useRootStore';
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';

import {
	exportAuditLog,
	getAuditLogEventNames,
	getAuditLogEvents,
	type AuditLogExportFile,
	type AuditLogFilters,
} from './audit-log.api';
import { AUDIT_LOG_STORE } from './audit-log.constants';
import { endOfDay, startOfDay } from './audit-log.utils';

const emptyDateRange = (): DateRange => ({ start: undefined, end: undefined });

/**
 * The state of the audit log page: the filters, the page of events, and the export. The store
 * keeps the filters when the user leaves the page. The table of the page changes `page` and
 * `itemsPerPage` directly.
 */
export const useAuditLogStore = defineStore(AUDIT_LOG_STORE, () => {
	const rootStore = useRootStore();

	const filters = ref<AuditLogFilters>({});
	/** The days of the date filter, as the date picker shows them. */
	const dateRange = shallowRef<DateRange>(emptyDateRange());
	const page = ref(0);
	const itemsPerPage = ref(AUDIT_LOG_DEFAULT_PAGE_SIZE);

	const events = ref<AuditLogEventResponse[]>([]);
	const count = ref(0);
	const loading = ref(false);
	const eventNames = ref<string[]>([]);
	const exporting = ref(false);

	const hasFilters = computed(() => Object.values(filters.value).some(Boolean));

	// Only the newest request may change the list. An older response that comes later is ignored.
	let latestRequest = 0;

	async function fetchEvents() {
		const request = ++latestRequest;
		loading.value = true;
		try {
			const result = await getAuditLogEvents(
				rootStore.restApiContext,
				filters.value,
				page.value * itemsPerPage.value,
				itemsPerPage.value,
			);
			if (request !== latestRequest) return;
			events.value = result.events;
			count.value = result.count;
		} finally {
			if (request === latestRequest) loading.value = false;
		}
	}

	async function fetchEventNames() {
		eventNames.value = await getAuditLogEventNames(rootStore.restApiContext);
	}

	/** Changes filters, and goes back to the first page. */
	function setFilters(changes: AuditLogFilters) {
		filters.value = { ...filters.value, ...changes };
		page.value = 0;
	}

	/** Filters by the days of the range, in the local time zone. Both days are included. */
	function setDateRange(range: DateRange) {
		dateRange.value = range;
		setFilters({
			from: range.start ? startOfDay(range.start) : undefined,
			to: range.end ? endOfDay(range.end) : undefined,
		});
	}

	function clearFilters() {
		dateRange.value = emptyDateRange();
		filters.value = {};
		page.value = 0;
	}

	/** The export file of all events that match the filters. */
	async function exportEvents(format: AuditLogExportFormat): Promise<AuditLogExportFile> {
		exporting.value = true;
		try {
			return await exportAuditLog(rootStore.restApiContext, filters.value, format);
		} finally {
			exporting.value = false;
		}
	}

	return {
		filters,
		dateRange,
		page,
		itemsPerPage,
		events,
		count,
		loading,
		eventNames,
		exporting,
		hasFilters,
		fetchEvents,
		fetchEventNames,
		setFilters,
		setDateRange,
		clearFilters,
		exportEvents,
	};
});
