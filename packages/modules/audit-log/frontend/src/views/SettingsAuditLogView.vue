<script setup lang="ts">
import { useDocumentTitle } from '@n8n/composables/useDocumentTitle';
import { useToast } from '@n8n/composables/useToast';
import {
	N8nActionDropdown,
	N8nButton,
	N8nDataTableServer,
	N8nDateRangePicker,
	N8nIconButton,
	N8nOption,
	N8nSelect,
	N8nSettingsLayout,
	N8nSettingsPageHeader,
	N8nText,
	type ActionDropdownItem,
	type DateRange,
	type TableHeader,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import type { IUser } from '@n8n/rest-api-client/api/users';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { useUsersStore } from '@n8n/stores/users.store';
import { computed, onMounted, ref, shallowRef, watch } from 'vue';

import type { AuditLogEvent, AuditLogExportFormat, AuditLogProjectType } from '../audit-log.api';
import { AUDIT_LOG_MODULE_ID, PAGE_SIZES, USER_SEARCH_SIZE } from '../audit-log.constants';
import { useAuditLogStore } from '../audit-log.store';
import {
	formatDay,
	formatTimestamp,
	saveFile,
	toEventNameOptions,
	useProjectTypeLabel,
} from '../audit-log.utils';
import AuditLogEventDetails from '../components/AuditLogEventDetails.vue';

const i18n = useI18n();
const toast = useToast();
const settingsStore = useSettingsStore();
const usersStore = useUsersStore();
const rbacStore = useRBACStore();
const store = useAuditLogStore();
const projectTypeLabel = useProjectTypeLabel();
const documentTitle = useDocumentTitle({ releaseChannel: settingsStore.settings.releaseChannel });

/** The locale of the browser, for the times and the date picker. */
const locale =
	typeof navigator !== 'undefined' && navigator.language ? navigator.language : undefined;

const description = computed(() => {
	const text = i18n.baseText('settings.auditLog.description');
	const retentionDays = settingsStore.moduleSettings[AUDIT_LOG_MODULE_ID]?.retentionDays;
	if (retentionDays === undefined) return text;
	const retention =
		retentionDays > 0
			? i18n.baseText('settings.auditLog.retention', {
					adjustToNumber: retentionDays,
					interpolate: { count: retentionDays },
				})
			: i18n.baseText('settings.auditLog.retention.unlimited');
	return `${text} ${retention}`;
});

// ── The list ──────────────────────────────────────────────────────────────

const loadedOnce = ref(false);

async function loadEvents() {
	try {
		await store.fetchEvents();
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.auditLog.loadError'));
	} finally {
		loadedOnce.value = true;
	}
}

// The filters and the page of the store decide the list. A change to one of them in a tick
// reads the list once.
watch(
	() => [store.filters, store.page, store.itemsPerPage],
	() => {
		void loadEvents();
	},
	{ deep: true },
);

const headers = computed<Array<TableHeader<AuditLogEvent>>>(() => [
	{
		title: i18n.baseText('settings.auditLog.column.time'),
		key: 'timestamp',
		disableSort: true,
		minWidth: 200,
	},
	{
		title: i18n.baseText('settings.auditLog.column.event'),
		key: 'eventName',
		disableSort: true,
		minWidth: 280,
	},
	{
		title: i18n.baseText('settings.auditLog.column.user'),
		key: 'user',
		value: (event) => event.userEmail ?? event.userId ?? '',
		disableSort: true,
		minWidth: 220,
	},
	{
		title: i18n.baseText('settings.auditLog.column.project'),
		key: 'project',
		value: (event) => projectTypeLabel(event.projectType) ?? '',
		disableSort: true,
		minWidth: 140,
	},
	{
		title: '',
		key: 'actions',
		value: () => '',
		disableSort: true,
		width: 64,
		align: 'end',
	},
]);

const showEmptyState = computed(() => loadedOnce.value && !store.loading && store.count === 0);

const selectedEvent = shallowRef<AuditLogEvent | null>(null);

function openDetails(event: AuditLogEvent) {
	selectedEvent.value = event;
}

function onRowClick(_event: MouseEvent, { item }: { item: AuditLogEvent }) {
	openDetails(item);
}

// ── Filters ───────────────────────────────────────────────────────────────

const eventNameOptions = computed(() => toEventNameOptions(store.eventNames));

const selectValue = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

function onEventNameChange(value: unknown) {
	store.setFilters({ eventName: selectValue(value) });
}

const canListUsers = computed(() => rbacStore.hasScope('user:list'));
const userQuery = ref('');
const searchingUsers = ref(false);

function userLabel(user: IUser) {
	const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
	if (name && user.email) return `${name} (${user.email})`;
	return user.email ?? (name || user.id);
}

/** The users that match the search. The selected user stays in the list. */
const userOptions = computed(() => {
	const query = userQuery.value.trim().toLowerCase();
	const matching = usersStore.allUsers
		.filter((user) => !query || userLabel(user).toLowerCase().includes(query))
		.sort((a, b) => userLabel(a).localeCompare(userLabel(b)))
		.slice(0, USER_SEARCH_SIZE);
	const selectedId = store.filters.userId;
	const selected = selectedId ? usersStore.usersById[selectedId] : undefined;
	return selected && !matching.includes(selected) ? [selected, ...matching] : matching;
});

async function searchUsers(query: string) {
	userQuery.value = query;
	searchingUsers.value = true;
	try {
		await usersStore.fetchUsers({
			take: USER_SEARCH_SIZE,
			filter: query ? { fullText: query } : undefined,
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.auditLog.filter.user.error'));
	} finally {
		searchingUsers.value = false;
	}
}

function onUserChange(value: unknown) {
	store.setFilters({ userId: selectValue(value) });
}

const projectTypeOptions = computed<Array<{ value: AuditLogProjectType; label: string }>>(() => [
	{ value: 'personal', label: i18n.baseText('settings.auditLog.filter.project.personal') },
	{ value: 'team', label: i18n.baseText('settings.auditLog.filter.project.team') },
]);

function onProjectTypeChange(value: unknown) {
	const projectType = projectTypeOptions.value.find((option) => option.value === value)?.value;
	store.setFilters({ projectType });
}

const isDateFilterOpen = ref(false);
/** The days that the date picker shows until the user applies them. */
const draftRange = shallowRef<DateRange>(store.dateRange);

watch(isDateFilterOpen, (open) => {
	if (open) draftRange.value = store.dateRange;
});

const hasDateRange = computed(() => Boolean(store.dateRange.start ?? store.dateRange.end));

const dateRangeLabel = computed(() => {
	const { start, end } = store.dateRange;
	if (!start && !end) return i18n.baseText('settings.auditLog.filter.date.any');
	const from = start ? formatDay(start, locale) : '…';
	const to = end ? formatDay(end, locale) : '…';
	return `${from} – ${to}`;
});

function onApplyDateRange() {
	store.setDateRange(draftRange.value);
	isDateFilterOpen.value = false;
}

function onClearDateRange() {
	store.setDateRange({ start: undefined, end: undefined });
	isDateFilterOpen.value = false;
}

function onClearFilters() {
	store.clearFilters();
}

// ── Export ────────────────────────────────────────────────────────────────

const exportItems = computed<Array<ActionDropdownItem<AuditLogExportFormat>>>(() => [
	{ id: 'csv', label: i18n.baseText('settings.auditLog.export.csv') },
	{ id: 'json', label: i18n.baseText('settings.auditLog.export.json') },
]);

async function onExport(format: AuditLogExportFormat) {
	try {
		const { blob, fileName } = await store.exportEvents(format);
		saveFile(blob, fileName);
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.auditLog.export.error'));
	}
}

onMounted(async () => {
	documentTitle.set(i18n.baseText('settings.auditLog.title'));
	const eventNames = store.fetchEventNames().catch((error: unknown) => {
		toast.showError(error, i18n.baseText('settings.auditLog.filter.event.error'));
	});
	await Promise.all([
		loadEvents(),
		eventNames,
		canListUsers.value ? searchUsers('') : Promise.resolve(),
	]);
});
</script>

<template>
	<N8nSettingsLayout full-width data-test-id="settings-audit-log">
		<N8nSettingsPageHeader
			:title="i18n.baseText('settings.auditLog.title')"
			:description="description"
			:show-docs-link="false"
		/>

		<div :class="$style.toolbar">
			<div :class="$style.filters">
				<N8nSelect
					:model-value="store.filters.eventName ?? ''"
					:class="$style.eventFilter"
					size="medium"
					filterable
					clearable
					:placeholder="i18n.baseText('settings.auditLog.filter.event.placeholder')"
					data-test-id="audit-log-event-filter"
					@update:model-value="onEventNameChange"
				>
					<N8nOption
						v-for="option in eventNameOptions"
						:key="option.value"
						:value="option.value"
						:label="option.label"
					/>
				</N8nSelect>

				<N8nSelect
					v-if="canListUsers"
					:model-value="store.filters.userId ?? ''"
					:class="$style.userFilter"
					size="medium"
					filterable
					remote
					clearable
					:remote-method="searchUsers"
					:loading="searchingUsers"
					:placeholder="i18n.baseText('settings.auditLog.filter.user.placeholder')"
					data-test-id="audit-log-user-filter"
					@update:model-value="onUserChange"
				>
					<N8nOption
						v-for="user in userOptions"
						:key="user.id"
						:value="user.id"
						:label="userLabel(user)"
					/>
				</N8nSelect>

				<N8nSelect
					:model-value="store.filters.projectType ?? ''"
					:class="$style.projectFilter"
					size="medium"
					clearable
					:placeholder="i18n.baseText('settings.auditLog.filter.project.placeholder')"
					data-test-id="audit-log-project-filter"
					@update:model-value="onProjectTypeChange"
				>
					<N8nOption
						v-for="option in projectTypeOptions"
						:key="option.value"
						:value="option.value"
						:label="option.label"
					/>
				</N8nSelect>

				<N8nDateRangePicker v-model="draftRange" v-model:open="isDateFilterOpen" :locale="locale">
					<template #trigger>
						<N8nButton
							variant="outline"
							size="medium"
							icon="calendar"
							:label="dateRangeLabel"
							data-test-id="audit-log-date-filter"
						/>
					</template>
					<template #footer>
						<div :class="$style.dateFooter">
							<N8nButton
								v-if="hasDateRange"
								variant="ghost"
								size="small"
								:label="i18n.baseText('settings.auditLog.filter.date.clear')"
								data-test-id="audit-log-date-filter-clear"
								@click="onClearDateRange"
							/>
							<N8nButton
								variant="solid"
								size="small"
								:label="i18n.baseText('settings.auditLog.filter.date.apply')"
								data-test-id="audit-log-date-filter-apply"
								@click="onApplyDateRange"
							/>
						</div>
					</template>
				</N8nDateRangePicker>

				<N8nButton
					v-if="store.hasFilters"
					variant="ghost"
					size="medium"
					:label="i18n.baseText('settings.auditLog.filter.clear')"
					data-test-id="audit-log-clear-filters"
					@click="onClearFilters"
				/>
			</div>

			<N8nActionDropdown
				:items="exportItems"
				placement="bottom-end"
				data-test-id="audit-log-export"
				@select="onExport"
			>
				<template #activator>
					<N8nButton
						variant="outline"
						size="medium"
						icon="download"
						:loading="store.exporting"
						:label="i18n.baseText('settings.auditLog.export')"
						data-test-id="audit-log-export-button"
					/>
				</template>
			</N8nActionDropdown>
		</div>

		<N8nDataTableServer
			v-model:page="store.page"
			v-model:items-per-page="store.itemsPerPage"
			:headers="headers"
			:items="store.events"
			:items-length="store.count"
			:loading="store.loading"
			:page-sizes="PAGE_SIZES"
			:row-props="{ class: $style.row }"
			data-test-id="audit-log-table"
			@click:row="onRowClick"
		>
			<template #[`item.timestamp`]="{ item }">
				<span :title="item.timestamp">{{ formatTimestamp(item.timestamp, locale) }}</span>
			</template>
			<template #[`item.eventName`]="{ item }">
				<code :class="$style.eventName">{{ item.eventName }}</code>
			</template>
			<template #[`item.user`]="{ item }">
				<span :title="item.userId ?? undefined">{{ item.userEmail ?? item.userId ?? '—' }}</span>
			</template>
			<template #[`item.project`]="{ item }">
				<span :title="item.projectId ?? undefined">{{
					projectTypeLabel(item.projectType) ?? '—'
				}}</span>
			</template>
			<template #[`item.actions`]="{ item }">
				<N8nIconButton
					icon="eye"
					variant="ghost"
					size="small"
					:aria-label="i18n.baseText('settings.auditLog.details.open')"
					:title="i18n.baseText('settings.auditLog.details.open')"
					:data-test-id="`audit-log-details-${item.id}`"
					@click.stop="openDetails(item)"
				/>
			</template>
		</N8nDataTableServer>

		<div v-if="showEmptyState" :class="$style.emptyState" data-test-id="audit-log-empty">
			<N8nText tag="p" bold>
				{{
					i18n.baseText(
						store.hasFilters
							? 'settings.auditLog.empty.filtered.title'
							: 'settings.auditLog.empty.title',
					)
				}}
			</N8nText>
			<N8nText tag="p" color="text-light">
				{{
					i18n.baseText(
						store.hasFilters
							? 'settings.auditLog.empty.filtered.description'
							: 'settings.auditLog.empty.description',
					)
				}}
			</N8nText>
		</div>

		<AuditLogEventDetails :event="selectedEvent" :locale="locale" @close="selectedEvent = null" />
	</N8nSettingsLayout>
</template>

<style lang="scss" module>
.toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--xs);
	margin-bottom: var(--spacing--sm);
}

.filters {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--spacing--xs);
}

.eventFilter {
	width: 18rem;
}

.userFilter {
	width: 16rem;
}

.projectFilter {
	width: 12rem;
}

.dateFooter {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--2xs);
	margin-top: var(--spacing--2xs);
}

.row {
	cursor: pointer;
}

.eventName {
	font-family: var(--font-family--monospace);
	font-size: var(--font-size--2xs);
}

.emptyState {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--spacing--3xs);
	padding: var(--spacing--xl) 0;
	text-align: center;
}
</style>
