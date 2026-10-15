<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the modal "Commit and push changes". It lists the resources that
 * a push can commit, by type, with the workflows in their folders. The user selects workflows,
 * credentials and data tables, writes a commit message and pushes. Variables, tags, folders and
 * projects always go with a push. The route opens the modal (`?sourceControl=push`), and it closes
 * with `router.back()`. `../FORK.md` describes it.
 */
import {
	N8nBadge,
	N8nButton,
	N8nCallout,
	N8nCheckbox,
	N8nHeading,
	N8nIcon,
	N8nIconButton,
	N8nInfoTip,
	N8nInput,
	N8nInputLabel,
	N8nLink,
	N8nNotice,
	N8nOption,
	N8nPopover,
	N8nSelect,
	N8nText,
} from '@n8n/design-system';
import type { BaseTextKey } from '@n8n/i18n';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { useTelemetry } from '@n8n/composables/useTelemetry';
import { hasPermission } from '@/app/utils/rbac/permissions';
import { useSettingsStore } from '@n8n/stores/settings.store';
import type { EventBus } from '@n8n/utils/event-bus';
import { useDebounceFn } from '@vueuse/core';
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller';
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css';

import type { CredentialsResource, WorkflowResource } from '@/Interface';
import Modal from '@/app/components/Modal.vue';
import ProjectCardBadge from '@/features/collaboration/projects/components/ProjectCardBadge.vue';
import ProjectSharing from '@/features/collaboration/projects/components/ProjectSharing.vue';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';
import type {
	ProjectListItem,
	ProjectSharingData,
} from '@/features/collaboration/projects/projects.types';
import {
	ResourceType,
	useAvailableProjectSearch,
} from '@/features/collaboration/projects/projects.utils';

import { useSourceControlStore } from '../sourceControl.store';
import type { SourceControlledFile } from '../sourceControl.types';
import {
	buildTree,
	filesInFolder,
	folderKey,
	PUSH_SUMMARY_ORDER,
	sortFiles,
	STATUS_LABEL_KEYS,
	type TreeRow,
	useChangesSummary,
	useLastUpdated,
} from '../sourceControl.utils';

type Tab = 'workflow' | 'credential' | 'datatable';

const NO_RESULTS_KEYS: Record<Tab, BaseTextKey> = {
	workflow: 'workflows.noResults',
	credential: 'credentials.noResults',
	datatable: 'dataTables.noResults',
};

/** The resources of a tab, in the text of the active filters. */
const FILTER_ENTITY_KEYS: Record<Tab, BaseTextKey> = {
	workflow: 'generic.workflows',
	credential: 'generic.credentials',
	datatable: 'generic.datatable',
};

type StatusFilter = 'created' | 'modified' | 'deleted';

const props = defineProps<{
	modalName: string;
	data?: { eventBus?: EventBus };
}>();

const SEARCH_DEBOUNCE_MS = 300;

const i18n = useI18n();
const toast = useToast();
const telemetry = useTelemetry();
const route = useRoute();
const router = useRouter();
const settingsStore = useSettingsStore();
const projectsStore = useProjectsStore();
const sourceControlStore = useSourceControlStore();
const lastUpdated = useLastUpdated();
const changesSummary = useChangesSummary();
const searchProjects = useAvailableProjectSearch();

/** The owner filter lists only the projects that the user can push. */
const canPushProject = (project: ProjectListItem) =>
	!!project.scopes?.includes('sourceControl:push');

const files = ref<SourceControlledFile[]>([]);
const activeTab = ref<Tab>('workflow');
const commitMessage = ref('');
const selected = ref(new Set<string>());
const collapsedFolders = ref(new Set<string>());
const scroller = ref<{ scrollToItem: (index: number) => void } | null>(null);
const isAdminCalloutVisible = ref(true);

const searchInput = ref('');
const search = ref('');
const statusFilter = ref<StatusFilter | ''>('');
const ownerFilter = ref<ProjectSharingData | null>(null);
const folderFilter = ref('');

/** A user with the global scope pushes the resources of all projects. */
const canPushEverywhere = computed(() =>
	hasPermission(['rbac'], { rbac: { scope: 'sourceControl:push' } }),
);

const isWorkflowDiffsEnabled = computed(() => !!settingsStore.settings.enterprise.workflowDiffs);

const currentWorkflowId = computed(() => {
	const id = route.params.workflowId;
	return typeof id === 'string' ? id : undefined;
});

const fileKey = (file: SourceControlledFile) => `${file.type}:${file.id}`;

const filesOfType = (type: SourceControlledFile['type']) =>
	files.value.filter((file) => file.type === type);

const workflows = computed(() => sortFiles(filesOfType('workflow'), 'push'));
const credentials = computed(() => sortFiles(filesOfType('credential'), 'push'));
const dataTables = computed(() => sortFiles(filesOfType('datatable'), 'push'));

const tabFiles = (tab: Tab) =>
	tab === 'workflow'
		? workflows.value
		: tab === 'credential'
			? credentials.value
			: dataTables.value;

const statusFilterOptions: Array<{ value: StatusFilter; label: string }> = [
	{ value: 'created', label: i18n.baseText('settings.sourceControl.status.created') },
	{ value: 'modified', label: i18n.baseText('settings.sourceControl.status.modified') },
	{ value: 'deleted', label: i18n.baseText('settings.sourceControl.status.deleted') },
];

/** The folders of the workflows, here and in Git, as "Parent / Child". */
const folderOptions = computed(() => {
	const paths: string[] = [];
	for (const file of workflows.value) {
		for (const path of [file.folderPath, file.remoteFolderPath]) {
			for (let depth = 1; depth <= (path?.length ?? 0); depth++) {
				const name = (path ?? []).slice(0, depth).join(' / ');
				if (!paths.includes(name)) paths.push(name);
			}
		}
	}
	return paths;
});

const activeFilterCount = computed(
	() =>
		[statusFilter.value, ownerFilter.value, folderFilter.value].filter((value) => !!value).length,
);

const hasFilters = computed(() => activeFilterCount.value > 0 || !!searchInput.value);

function matchesFilters(file: SourceControlledFile) {
	if (search.value && !file.name.toLowerCase().includes(search.value.toLowerCase())) return false;
	if (statusFilter.value && file.status !== statusFilter.value) return false;
	if (ownerFilter.value && file.owner?.projectId !== ownerFilter.value.id) return false;
	if (folderFilter.value) {
		const local = (file.folderPath ?? []).join(' / ');
		const remote = (file.remoteFolderPath ?? []).join(' / ');
		const inFolder = (path: string) =>
			path === folderFilter.value || path.startsWith(`${folderFilter.value} / `);
		if (!inFolder(local) && !inFolder(remote)) return false;
	}
	return true;
}

const visibleFiles = computed(() => tabFiles(activeTab.value).filter(matchesFilters));

const rows = computed<TreeRow[]>(() => {
	if (activeTab.value === 'workflow') {
		return buildTree(visibleFiles.value, collapsedFolders.value);
	}
	return visibleFiles.value.map((file) => ({ type: 'file', key: fileKey(file), file, depth: 0 }));
});

const tabs = computed(() =>
	(
		[
			['workflow', 'generic.workflows'],
			['credential', 'generic.credentials'],
			['datatable', 'settings.sourceControl.modals.tabs.dataTables'],
		] as const
	).map(([value, key]) => {
		const all = tabFiles(value);
		return {
			value,
			label: i18n.baseText(key),
			selected: all.filter((file) => selected.value.has(fileKey(file))).length,
			total: all.length,
		};
	}),
);

const filterEntity = computed(() =>
	i18n.baseText(FILTER_ENTITY_KEYS[activeTab.value]).toLowerCase(),
);

const selectedCount = computed(() => tabs.value.reduce((sum, tab) => sum + tab.selected, 0));

const hasListedFiles = computed(
	() => workflows.value.length + credentials.value.length + dataTables.value.length > 0,
);

const otherChanges = computed(() =>
	(
		[
			['variables', 'generic.variable_plural'],
			['tags', 'generic.tag_plural'],
			['folders', 'generic.folders_plural'],
			['project', 'generic.projects'],
		] as const
	)
		.filter(([type]) => files.value.some((file) => file.type === type))
		.map(([, key]) => i18n.baseText(key)),
);

const hasModifiedCredentials = computed(() =>
	credentials.value.some((file) => file.status === 'modified'),
);

const toggleAllState = computed(() => {
	const visible = visibleFiles.value;
	const count = visible.filter((file) => selected.value.has(fileKey(file))).length;
	return {
		checked: visible.length > 0 && count === visible.length,
		indeterminate: count > 0 && count < visible.length,
	};
});

function setSelected(list: SourceControlledFile[], value: boolean) {
	const next = new Set(selected.value);
	for (const file of list) {
		if (value) next.add(fileKey(file));
		else next.delete(fileKey(file));
	}
	selected.value = next;
}

function toggleAll() {
	setSelected(visibleFiles.value, !toggleAllState.value.checked);
}

function toggleFile(file: SourceControlledFile) {
	setSelected([file], !selected.value.has(fileKey(file)));
}

function folderState(path: string[]) {
	const inFolder = filesInFolder(visibleFiles.value, path);
	const count = inFolder.filter((file) => selected.value.has(fileKey(file))).length;
	return {
		checked: inFolder.length > 0 && count === inFolder.length,
		indeterminate: count > 0 && count < inFolder.length,
	};
}

function toggleFolderSelection(path: string[]) {
	setSelected(filesInFolder(visibleFiles.value, path), !folderState(path).checked);
}

function toggleFolder(path: string[]) {
	const key = folderKey(path);
	const next = new Set(collapsedFolders.value);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	collapsedFolders.value = next;
}

function statusLabel(file: SourceControlledFile) {
	const key = STATUS_LABEL_KEYS[file.status];
	return key ? i18n.baseText(key) : file.status;
}

/** The resource of the project badge. The badge shows only the home project of the file. */
function badgeResource(file: SourceControlledFile): WorkflowResource | CredentialsResource {
	const owner = file.owner;
	const base = {
		id: file.id,
		name: file.name,
		createdAt: '',
		updatedAt: file.updatedAt,
		homeProject: owner
			? {
					id: owner.projectId,
					name: owner.projectName,
					type: owner.type,
					icon: null,
					createdAt: '',
					updatedAt: '',
				}
			: undefined,
		sharedWithProjects: [],
		readOnly: true,
	};
	if (file.type === 'credential') {
		return { ...base, resourceType: 'credential', type: '', needsSetup: false };
	}
	return {
		...base,
		resourceType: 'workflow',
		active: false,
		activeVersionId: null,
		isArchived: false,
	};
}

const projectsOfUser = computed(() =>
	canPushEverywhere.value ? projectsStore.projects : projectsStore.myProjects,
);

const onSearch = useDebounceFn((value: string) => {
	search.value = value;
	telemetry.track('User searched workflows in commit modal', { search: value });
}, SEARCH_DEBOUNCE_MS);

function onSearchInput(value: string) {
	searchInput.value = value;
	void onSearch(value);
}

function onStatusFilter(value: StatusFilter | '') {
	statusFilter.value = value;
	telemetry.track('User filtered by status in commit modal', { status: value || undefined });
}

function resetFilters() {
	if (statusFilter.value) {
		telemetry.track('User filtered by status in commit modal', { status: undefined });
	}
	statusFilter.value = '';
	ownerFilter.value = null;
	folderFilter.value = '';
	searchInput.value = '';
	search.value = '';
}

function close() {
	router.back();
}

function openDiff(file: SourceControlledFile) {
	telemetry.track('User clicks compare workflows', {
		workflow_id: file.id,
		context: 'source_control_push',
	});
	void router.push({
		query: { ...route.query, diff: file.id, workflowStatus: file.status, direction: 'push' },
	});
}

/** The files of a push: the selected files, and the variables, tags, folders and projects. */
function filesToPush() {
	const isSelected = (file: SourceControlledFile) => selected.value.has(fileKey(file));
	const ofType = (type: SourceControlledFile['type']) => filesOfType(type);
	return [
		...ofType('tags'),
		...ofType('variables'),
		...ofType('datatable').filter(isSelected),
		...ofType('credential').filter(isSelected),
		...ofType('folders'),
		...ofType('project'),
		...ofType('workflow').filter(isSelected),
	].map((file) => ({
		...file,
		project: projectsOfUser.value.find((project) => project.id === file.owner?.projectId),
	}));
}

async function commitAndPush() {
	if (!commitMessage.value.trim()) return;
	const fileNames = filesToPush();
	try {
		await sourceControlStore.pushWorkfolder({
			commitMessage: commitMessage.value,
			fileNames,
			force: true,
		});
		toast.showToast({
			title: i18n.baseText('settings.sourceControl.modals.push.success.title'),
			message: changesSummary(
				fileNames,
				PUSH_SUMMARY_ORDER,
				'settings.sourceControl.modals.push.success.description',
			),
			type: 'success',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
	}
	close();
}

async function loadStatus() {
	try {
		files.value = await sourceControlStore.getAggregatedStatus({
			direction: 'push',
			preferLocalVersion: true,
			verbose: false,
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
		close();
		return;
	}
	if (files.value.length === 0) {
		toast.showMessage({
			title: i18n.baseText('settings.sourceControl.modals.push.noChanges.title'),
			message: i18n.baseText('settings.sourceControl.modals.push.everythingIsUpToDate'),
			type: 'info',
		});
		close();
		return;
	}
	// Credentials and data tables start selected; workflows only when the page shows them.
	setSelected([...credentials.value, ...dataTables.value], true);
	const current = workflows.value.find((file) => file.id === currentWorkflowId.value);
	if (current) {
		setSelected([current], true);
		await nextTick();
		const index = rows.value.findIndex((row) => row.type === 'file' && row.file.id === current.id);
		if (index >= 0) scroller.value?.scrollToItem(index);
	}
}

onMounted(async () => {
	if (canPushEverywhere.value) void projectsStore.getAllProjects();
	else void projectsStore.getMyProjects();
	await loadStatus();
});
</script>

<template>
	<Modal
		width="812px"
		:event-bus="props.data?.eventBus"
		:name="modalName"
		:before-close="
			() => {
				close();
				return true;
			}
		"
		@enter="commitAndPush"
	>
		<template #header>
			<div :class="$style.header">
				<N8nHeading tag="h1" size="xlarge">{{
					i18n.baseText('settings.sourceControl.modals.push.title')
				}}</N8nHeading>
				<div v-if="hasListedFiles" :class="$style.headerControls">
					<N8nInput
						:model-value="searchInput"
						data-test-id="source-control-push-search"
						:placeholder="i18n.baseText('settings.sourceControl.modals.push.searchPlaceholder')"
						clearable
						:class="$style.search"
						@update:model-value="onSearchInput"
					>
						<template #prefix>
							<N8nIcon icon="search" />
						</template>
					</N8nInput>
					<N8nPopover width="304px" align="end" :teleported="false">
						<template #trigger>
							<N8nButton
								variant="outline"
								icon="funnel"
								data-test-id="source-control-filter-dropdown"
							>
								<N8nBadge v-if="activeFilterCount > 0" variant="primary">{{
									activeFilterCount
								}}</N8nBadge>
							</N8nButton>
						</template>
						<template #content>
							<div :class="$style.filters">
								<N8nInputLabel
									:label="i18n.baseText('settings.sourceControl.modals.push.filters.status')"
									:bold="false"
									size="small"
									color="text-base"
									class="mb-3xs"
								/>
								<N8nSelect
									:model-value="statusFilter"
									data-test-id="source-control-status-filter"
									clearable
									@update:model-value="onStatusFilter"
								>
									<N8nOption
										v-for="option in statusFilterOptions"
										:key="option.value"
										:value="option.value"
										:label="option.label"
										data-test-id="source-control-status-filter-option"
									/>
								</N8nSelect>
								<N8nInputLabel
									:label="i18n.baseText('forms.resourceFiltersDropdown.owner')"
									:bold="false"
									size="small"
									color="text-base"
									class="mb-3xs mt-3xs"
								/>
								<div data-test-id="source-control-push-modal-project-search">
									<ProjectSharing
										v-model="ownerFilter"
										:search-fn="searchProjects"
										:filter-fn="canPushProject"
										:placeholder="i18n.baseText('forms.resourceFiltersDropdown.owner.placeholder')"
										:empty-options-text="i18n.baseText('projects.sharing.noMatchingProjects')"
									/>
								</div>
								<N8nInputLabel
									:label="i18n.baseText('settings.sourceControl.modals.push.filters.folder')"
									:bold="false"
									size="small"
									color="text-base"
									class="mb-3xs mt-3xs"
								/>
								<N8nSelect
									v-model="folderFilter"
									data-test-id="source-control-folder-filter"
									:placeholder="i18n.baseText('settings.sourceControl.modals.push.filters.folder')"
									clearable
									filterable
								>
									<N8nOption
										v-for="folder in folderOptions"
										:key="folder"
										:value="folder"
										:label="folder"
									/>
								</N8nSelect>
								<div v-if="activeFilterCount > 0" class="mt-s">
									<N8nLink @click="resetFilters">{{
										i18n.baseText('forms.resourceFiltersDropdown.reset')
									}}</N8nLink>
								</div>
							</div>
						</template>
					</N8nPopover>
				</div>
				<N8nCallout
					v-if="!canPushEverywhere && isAdminCalloutVisible"
					theme="secondary"
					icon="info"
					class="mt-s"
				>
					{{ i18n.baseText('settings.sourceControl.modals.push.projectAdmin.callout') }}
					<template #trailingContent>
						<N8nIcon
							icon="x"
							size="small"
							:class="$style.calloutClose"
							@click="isAdminCalloutVisible = false"
						/>
					</template>
				</N8nCallout>
			</div>
		</template>
		<template #content>
			<div :class="$style.container">
				<div :class="$style.tabs">
					<button
						v-for="tab in tabs"
						:key="tab.value"
						type="button"
						:class="[$style.tab, { [$style.tabActive]: activeTab === tab.value }]"
						:data-test-id="`source-control-push-modal-tab-${tab.value}`"
						@click="activeTab = tab.value"
					>
						<div>{{ tab.label }}</div>
						<N8nText tag="div" size="small" color="text-light"
							>{{
								i18n.baseText('settings.sourceControl.modals.push.selected', {
									interpolate: { selected: String(tab.selected), total: String(tab.total) },
								})
							}}&nbsp;</N8nText
						>
					</button>
				</div>
				<div :class="$style.table">
					<div :class="$style.tableHeader">
						<N8nCheckbox
							:model-value="toggleAllState.checked"
							:indeterminate="toggleAllState.indeterminate"
							:disabled="visibleFiles.length === 0"
							data-test-id="source-control-push-modal-toggle-all"
							@update:model-value="toggleAll"
						/>
						<N8nText size="small" bold
							>{{
								i18n.baseText('settings.sourceControl.modals.pullResult.tableHeader.title')
							}}&nbsp;</N8nText
						>
					</div>
					<div v-if="hasFilters" :class="$style.filterInfo">
						<N8nInfoTip :bold="false"
							>{{
								i18n.baseText('settings.sourceControl.modals.push.filter', {
									interpolate: {
										count: `${visibleFiles.length} / ${tabFiles(activeTab).length}`,
										entity: filterEntity,
									},
								})
							}}
							<N8nLink
								size="small"
								data-test-id="source-control-filters-reset"
								@click="resetFilters"
								>{{ i18n.baseText('workflows.filters.active.reset') }}</N8nLink
							>
						</N8nInfoTip>
					</div>
					<div v-if="rows.length === 0" :class="$style.empty">
						<N8nInfoTip :bold="false">{{ i18n.baseText(NO_RESULTS_KEYS[activeTab]) }}</N8nInfoTip>
					</div>
					<DynamicScroller
						v-else
						ref="scroller"
						:items="rows"
						:min-item-size="58"
						key-field="key"
						:class="$style.scroller"
					>
						<template #default="{ item, index, active }">
							<DynamicScrollerItem
								:item="item"
								:active="active"
								:size-dependencies="[item.key]"
								:data-index="index"
							>
								<div
									v-if="item.type === 'folder'"
									:class="$style.folderRow"
									:style="{ paddingLeft: `${16 + item.depth * 24}px` }"
								>
									<label :class="$style.folderLabel">
										<N8nCheckbox
											:model-value="folderState(item.path).checked"
											:indeterminate="folderState(item.path).indeterminate"
											data-test-id="source-control-push-modal-folder-checkbox"
											@update:model-value="toggleFolderSelection(item.path)"
										/>
										<N8nIcon icon="folder" size="small" />
										<N8nText size="small" bold>{{ item.name }}</N8nText>
									</label>
									<N8nIconButton
										variant="ghost"
										size="xsmall"
										:icon="
											collapsedFolders.has(folderKey(item.path)) ? 'chevron-right' : 'chevron-down'
										"
										data-test-id="source-control-push-modal-folder-toggle"
										@click="toggleFolder(item.path)"
									/>
								</div>
								<div
									v-else
									:class="$style.fileRow"
									:style="{ paddingLeft: `${16 + item.depth * 24}px` }"
								>
									<label :class="$style.fileLabel">
										<N8nCheckbox
											:model-value="selected.has(`${item.file.type}:${item.file.id}`)"
											data-test-id="source-control-push-modal-file-checkbox"
											@update:model-value="toggleFile(item.file)"
										/>
										<span :class="$style.fileName">
											<N8nText tag="div" size="small" bold>{{ item.file.name }}</N8nText>
											<N8nText tag="p" size="small" color="text-light">{{
												lastUpdated(item.file.updatedAt)
											}}</N8nText>
										</span>
									</label>
									<div :class="$style.badges">
										<N8nBadge
											v-if="item.file.id === currentWorkflowId && item.file.type === 'workflow'"
											>{{
												i18n.baseText('settings.sourceControl.modals.push.currentWorkflow')
											}}</N8nBadge
										>
										<ProjectCardBadge
											v-if="item.file.owner"
											data-test-id="source-control-push-modal-project-badge"
											:resource="badgeResource(item.file)"
											:resource-type="
												item.file.type === 'credential'
													? ResourceType.Credential
													: ResourceType.Workflow
											"
											:resource-type-label="item.file.type"
											:personal-project="projectsStore.personalProject"
											:show-badge-border="false"
										/>
										<N8nBadge>{{ statusLabel(item.file) }}</N8nBadge>
										<N8nIconButton
											v-if="isWorkflowDiffsEnabled && item.file.type === 'workflow'"
											variant="ghost"
											size="small"
											icon="file-diff"
											data-test-id="source-control-workflow-diff-button"
											@click="openDiff(item.file)"
										/>
									</div>
								</div>
							</DynamicScrollerItem>
						</template>
					</DynamicScroller>
				</div>
				<N8nNotice
					v-if="otherChanges.length > 0 || hasModifiedCredentials"
					id="source-control-push-modal-notice"
					theme="info"
					:compact="true"
				>
					<template v-if="otherChanges.length > 0">
						<N8nText tag="div" size="small" bold
							>{{ i18n.baseText('settings.sourceControl.modals.push.otherChanges') }}&nbsp;</N8nText
						>
						<div v-for="label in otherChanges" :key="label">
							<N8nText size="small" bold>{{ label }}</N8nText>
							<N8nText size="small"
								>{{
									i18n.baseText('settings.sourceControl.modals.push.otherChanges.item')
								}}&nbsp;</N8nText
							>
						</div>
					</template>
					<N8nText v-if="hasModifiedCredentials" tag="div" size="small">{{
						i18n.baseText('settings.sourceControl.modals.push.modifiedCredentialsNotice')
					}}</N8nText>
				</N8nNotice>
				<div :class="$style.commit">
					<N8nText tag="p" size="small" bold>{{
						i18n.baseText('settings.sourceControl.modals.push.commitMessage')
					}}</N8nText>
					<N8nInput
						v-model="commitMessage"
						data-test-id="source-control-push-modal-commit"
						:placeholder="
							i18n.baseText('settings.sourceControl.modals.push.commitMessage.placeholder')
						"
					/>
				</div>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton
					:disabled="!commitMessage.trim()"
					data-test-id="source-control-push-modal-submit"
					@click="commitAndPush"
					>{{ i18n.baseText('settings.sourceControl.modals.push.buttons.save')
					}}{{ selectedCount > 0 ? ` (${selectedCount})` : '' }}</N8nButton
				>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.header {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.headerControls {
	display: flex;
	gap: var(--spacing--2xs);
}

.search {
	flex: 1;
}

.filters {
	display: flex;
	flex-direction: column;
	padding: var(--spacing--sm);
}

.calloutClose {
	cursor: pointer;
}

.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.tabs {
	display: flex;
	gap: var(--spacing--2xs);
}

.tab {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--spacing--5xs);
	padding: var(--spacing--2xs) var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius);
	background: transparent;
	color: var(--color--text);
	font-size: var(--font-size--sm);
	cursor: pointer;
}

.tabActive {
	border-color: var(--color--primary);
	background: var(--color--background--light-2);
}

.table {
	border: var(--border);
	border-radius: var(--radius);
}

.tableHeader {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
	padding: var(--spacing--2xs) var(--spacing--sm);
	border-bottom: var(--border);
}

.filterInfo {
	padding: var(--spacing--2xs) var(--spacing--sm);
	border-bottom: var(--border);
}

.scroller {
	max-height: 380px;
}

.folderRow,
.fileRow {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--2xs);
	min-height: 58px;
	padding-right: var(--spacing--sm);
	border-bottom: var(--border);
}

.folderLabel,
.fileLabel {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
	min-width: 0;
	flex: 1;
	cursor: pointer;
}

.fileName {
	display: flex;
	flex-direction: column;
	min-width: 0;

	p {
		margin: 0;
	}
}

.badges {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.empty {
	padding: var(--spacing--sm);
}

.commit {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);

	p {
		margin: 0;
	}
}

.footer {
	display: flex;
	justify-content: flex-end;
}
</style>
