<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the modal "Pull changes". It lists the resources that a pull
 * changes, and pulls them with `force`. The route opens it (`?sourceControl=pull`), and it closes
 * with `router.back()`. `../FORK.md` describes it.
 */
import {
	N8nBadge,
	N8nButton,
	N8nCallout,
	N8nHeading,
	N8nIconButton,
	N8nInfoTip,
	N8nLink,
	N8nNotice,
	N8nOption,
	N8nSelect,
	N8nText,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { useTelemetry } from '@n8n/composables/useTelemetry';
import { useSettingsStore } from '@n8n/stores/settings.store';
import type { EventBus } from '@n8n/utils/event-bus';
import { computed, h, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller';
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css';

import Modal from '@/app/components/Modal.vue';
import { VIEWS } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';

import { SOURCE_CONTROL_PULL_RESULT_MODAL_KEY } from '../sourceControl.constants';
import { sourceControlEventBus } from '../sourceControl.eventBus';
import { useSourceControlStore } from '../sourceControl.store';
import type { AutoPublishMode, SourceControlledFile } from '../sourceControl.types';
import {
	buildTree,
	folderKey,
	PULL_SUMMARY_ORDER,
	sortFiles,
	STATUS_LABEL_KEYS,
	type TreeRow,
	useChangesSummary,
	useLastUpdated,
} from '../sourceControl.utils';

type Tab = 'workflow' | 'credential' | 'datatable';

const props = defineProps<{
	modalName: string;
	data?: { eventBus?: EventBus };
}>();

const PUSH_PULL_DOCS_URL = 'https://docs.n8n.io/source-control-environments/using/push-pull';

const i18n = useI18n();
const toast = useToast();
const telemetry = useTelemetry();
const route = useRoute();
const router = useRouter();
const uiStore = useUIStore();
const settingsStore = useSettingsStore();
const projectsStore = useProjectsStore();
const sourceControlStore = useSourceControlStore();
const lastUpdated = useLastUpdated();
const changesSummary = useChangesSummary();

const files = ref<SourceControlledFile[]>([]);
const activeTab = ref<Tab>('workflow');
const autoPublish = ref<AutoPublishMode>('none');
const collapsedFolders = ref(new Set<string>());

const autoPublishOptions: Array<{ value: AutoPublishMode; label: string; description: string }> = [
	{
		value: 'none',
		label: i18n.baseText('settings.sourceControl.modals.pull.autoPublish.options.off'),
		description: i18n.baseText(
			'settings.sourceControl.modals.pull.autoPublish.options.off.description',
		),
	},
	{
		value: 'published',
		label: i18n.baseText('settings.sourceControl.modals.pull.autoPublish.options.published'),
		description: i18n.baseText(
			'settings.sourceControl.modals.pull.autoPublish.options.published.description',
		),
	},
	{
		value: 'all',
		label: i18n.baseText('settings.sourceControl.modals.pull.autoPublish.options.on'),
		description: i18n.baseText(
			'settings.sourceControl.modals.pull.autoPublish.options.on.description',
		),
	},
];

const isWorkflowDiffsEnabled = computed(() => !!settingsStore.settings.enterprise.workflowDiffs);

const filesOfType = (type: SourceControlledFile['type']) =>
	sortFiles(
		files.value.filter((file) => file.type === type),
		'pull',
	);

const workflows = computed(() => filesOfType('workflow'));
const credentials = computed(() => filesOfType('credential'));
const dataTables = computed(() => filesOfType('datatable'));

const tabs = computed(() => [
	{
		value: 'workflow' as const,
		label: i18n.baseText('generic.workflows'),
		count: workflows.value.length,
	},
	{
		value: 'credential' as const,
		label: i18n.baseText('generic.credentials'),
		count: credentials.value.length,
	},
	{
		value: 'datatable' as const,
		label: i18n.baseText('workflows.dependencies.type.dataTables'),
		count: dataTables.value.length,
	},
]);

const rows = computed<TreeRow[]>(() => {
	if (activeTab.value === 'workflow') return buildTree(workflows.value, collapsedFolders.value);
	const list = activeTab.value === 'credential' ? credentials.value : dataTables.value;
	return list.map((file) => ({
		type: 'file',
		key: `file:${file.type}:${file.id}`,
		file,
		depth: 0,
	}));
});

/** A workflow in conflict loses its local changes: the button says so. */
const hasWorkflowConflicts = computed(() => workflows.value.some((file) => file.conflict));

const hasModifiedCredentials = computed(() =>
	credentials.value.some((file) => file.status === 'modified'),
);

const conflictingDataTables = computed(() => dataTables.value.filter((file) => file.conflict));

/** "Variables (1), Tags (1)": the resources that the lists do not show. */
const additionalChanges = computed(() =>
	(
		[
			['variables', 'generic.variable_plural'],
			['tags', 'generic.tag_plural'],
			['folders', 'generic.folders_plural'],
			['project', 'generic.projects'],
		] as const
	)
		.map(([type, key]) => ({
			label: i18n.baseText(key),
			count: files.value.filter((file) => file.type === type).length,
		}))
		.filter(({ count }) => count > 0)
		.map(({ label, count }) => `${label} (${count})`)
		.join(', '),
);

function itemCount(count: number) {
	return i18n.baseText('settings.sourceControl.modals.pullResult.itemCount', {
		adjustToNumber: count,
		interpolate: { count: String(count) },
	});
}

function statusLabel(file: SourceControlledFile) {
	const key = STATUS_LABEL_KEYS[file.status];
	return key ? i18n.baseText(key) : file.status;
}

/** A workflow that the chosen mode of automatic publishing publishes after the pull. */
function willBePublished(file: SourceControlledFile, mode: AutoPublishMode = autoPublish.value) {
	if (file.type !== 'workflow' || file.status === 'deleted' || file.isRemoteArchived) return false;
	if (mode === 'all') return true;
	if (mode === 'published') return !!file.isLocalPublished;
	return false;
}

function toggleFolder(path: string[]) {
	const key = folderKey(path);
	const next = new Set(collapsedFolders.value);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	collapsedFolders.value = next;
}

function close() {
	router.back();
}

function openDiff(file: SourceControlledFile) {
	telemetry.track('User clicks compare workflows', {
		workflow_id: file.id,
		context: 'source_control_pull',
	});
	void router.push({ query: { ...route.query, diff: file.id, direction: 'pull' } });
}

function reviewLink(text: string, name: string, query: Record<string, string>) {
	const href = router.resolve({ name, query }).href;
	return h(
		'a',
		{
			href,
			onClick: (event: MouseEvent) => {
				event.preventDefault();
				void router.push(href);
			},
		},
		text,
	);
}

function notifyPulled(pulled: SourceControlledFile[]) {
	if (pulled.some((file) => file.type === 'variables')) {
		toast.showToast({
			title: i18n.baseText('settings.sourceControl.pull.upToDate.variables.title'),
			message: reviewLink(
				i18n.baseText('settings.sourceControl.pull.upToDate.variables.description'),
				VIEWS.HOME_VARIABLES,
				{ incomplete: 'true' },
			),
			type: 'info',
			duration: 0,
		});
	}
	if (pulled.some((file) => file.type === 'credential')) {
		toast.showToast({
			title: i18n.baseText('settings.sourceControl.pull.upToDate.credentials.title'),
			message: reviewLink(
				i18n.baseText('settings.sourceControl.pull.upToDate.credentials.description'),
				VIEWS.CREDENTIALS,
				{ setupNeeded: 'true' },
			),
			type: 'info',
			duration: 0,
		});
	}
	toast.showToast({
		title: i18n.baseText('settings.sourceControl.pull.success.title'),
		message: changesSummary(
			pulled,
			PULL_SUMMARY_ORDER,
			'settings.sourceControl.pull.success.description',
		),
		type: 'success',
	});
}

async function pull() {
	const mode = autoPublish.value;
	try {
		const pulled = await sourceControlStore.pullWorkfolder(true, mode);
		notifyPulled(pulled);
		sourceControlEventBus.emit('pull');
		close();
		if (mode !== 'none') {
			const published = pulled.filter((file) => willBePublished(file, mode));
			if (published.length > 0) {
				uiStore.openModalWithData({
					name: SOURCE_CONTROL_PULL_RESULT_MODAL_KEY,
					data: { workflows: published },
				});
			}
		}
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
		close();
	}
}

async function loadStatus() {
	try {
		files.value = await sourceControlStore.getAggregatedStatus({
			direction: 'pull',
			preferLocalVersion: false,
			verbose: false,
		});
		if (files.value.length === 0) {
			toast.showMessage({
				title: i18n.baseText('settings.sourceControl.pull.upToDate.description'),
				type: 'success',
			});
			close();
		}
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
		close();
	}
}

onMounted(async () => {
	void projectsStore.getAllProjects();
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
	>
		<template #header>
			<N8nHeading tag="h1" size="xlarge">
				{{ i18n.baseText('settings.sourceControl.modals.pull.title') }}
			</N8nHeading>
			<N8nText tag="div" class="mt-xs" color="text-base"
				>{{ i18n.baseText('settings.sourceControl.modals.pull.description') }}
				<N8nLink :to="PUSH_PULL_DOCS_URL" :new-window="true">
					{{ i18n.baseText('settings.sourceControl.modals.pull.description.learnMore') }}
				</N8nLink>
			</N8nText>
		</template>
		<template #content>
			<div :class="$style.container">
				<div :class="$style.autoPublishSection">
					<N8nText tag="div" size="small" bold>{{
						i18n.baseText('settings.sourceControl.modals.pull.autoPublish.title')
					}}</N8nText>
					<N8nSelect
						v-model="autoPublish"
						data-test-id="auto-publish-select"
						:class="$style.select"
					>
						<N8nOption
							v-for="option in autoPublishOptions"
							:key="option.value"
							:value="option.value"
							:label="option.label"
						>
							<N8nText size="small">{{ option.label }}</N8nText>
							<N8nText size="xsmall" color="text-light">{{ option.description }}</N8nText>
						</N8nOption>
					</N8nSelect>
				</div>
				<div :class="$style.tabs">
					<button
						v-for="tab in tabs"
						:key="tab.value"
						type="button"
						:class="[$style.tab, { [$style.tabActive]: activeTab === tab.value }]"
						:data-test-id="`source-control-pull-modal-tab-${tab.value}`"
						@click="activeTab = tab.value"
					>
						<div>{{ tab.label }}</div>
						<N8nText tag="div" size="small" color="text-light">{{ itemCount(tab.count) }}</N8nText>
					</button>
				</div>
				<div :class="$style.table">
					<div :class="$style.tableHeader">
						<N8nText size="small" bold>{{
							i18n.baseText('settings.sourceControl.modals.pullResult.tableHeader.title')
						}}</N8nText>
					</div>
					<div v-if="rows.length === 0" :class="$style.empty">
						<N8nInfoTip :bold="false">{{ i18n.baseText('workflows.noResults') }}</N8nInfoTip>
					</div>
					<DynamicScroller
						v-else
						:items="rows"
						:min-item-size="47"
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
									data-test-id="source-control-pull-modal-folder-row"
								>
									<N8nText size="small" bold>{{ item.name }}</N8nText>
									<N8nIconButton
										variant="ghost"
										size="xsmall"
										:icon="
											collapsedFolders.has(folderKey(item.path)) ? 'chevron-right' : 'chevron-down'
										"
										data-test-id="source-control-pull-modal-folder-toggle"
										@click="toggleFolder(item.path)"
									/>
								</div>
								<div
									v-else
									:class="$style.fileRow"
									:style="{ paddingLeft: `${16 + item.depth * 24}px` }"
									data-test-id="pull-modal-item"
								>
									<div :class="$style.fileName">
										<N8nText tag="div" size="small" bold :class="$style.name">
											<RouterLink
												v-if="item.file.type === 'workflow'"
												:to="{ name: VIEWS.WORKFLOW, params: { workflowId: item.file.id } }"
												target="_blank"
												>{{ item.file.name }}</RouterLink
											>
											<template v-else>{{ item.file.name }}</template>
										</N8nText>
										<N8nText size="small" color="text-light">{{
											lastUpdated(item.file.updatedAt)
										}}</N8nText>
									</div>
									<div :class="$style.badges">
										<N8nText v-if="willBePublished(item.file)" size="small" color="text-light">{{
											i18n.baseText('settings.sourceControl.modals.pull.autoPublishing')
										}}</N8nText>
										<N8nText v-if="item.file.isRemoteArchived" size="small" color="text-light">{{
											i18n.baseText('settings.sourceControl.modals.pull.willBeArchived')
										}}</N8nText>
										<N8nBadge :class="$style.statusBadge">{{ statusLabel(item.file) }}</N8nBadge>
										<N8nIconButton
											v-if="
												isWorkflowDiffsEnabled &&
												item.file.type === 'workflow' &&
												item.file.status === 'modified'
											"
											variant="ghost"
											size="small"
											icon="file-diff"
											@click="openDiff(item.file)"
										/>
									</div>
								</div>
							</DynamicScrollerItem>
						</template>
					</DynamicScroller>
				</div>
				<N8nNotice v-if="hasModifiedCredentials" theme="warning" :compact="true">
					<N8nText size="small">{{
						i18n.baseText('settings.sourceControl.modals.pull.modifiedCredentialsNotice')
					}}</N8nText>
				</N8nNotice>
				<div v-if="additionalChanges" :class="$style.additional">
					<N8nText size="small" bold>{{
						i18n.baseText('settings.sourceControl.modals.pull.additionalChanges')
					}}</N8nText>
					<N8nText size="small">{{ additionalChanges }}</N8nText>
				</div>
				<N8nCallout v-if="conflictingDataTables.length > 0" theme="warning" icon="triangle-alert">
					<div>
						{{
							i18n.baseText('settings.sourceControl.modals.pull.dataTablesWarning', {
								adjustToNumber: conflictingDataTables.length,
								interpolate: { count: String(conflictingDataTables.length) },
							})
						}}
					</div>
					<ul :class="$style.dataTables">
						<li v-for="table in conflictingDataTables" :key="table.id">{{ table.name }}</li>
					</ul>
				</N8nCallout>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton variant="subtle" class="mr-2xs" @click="close">{{
					i18n.baseText('settings.sourceControl.modals.pull.buttons.cancel')
				}}</N8nButton>
				<N8nButton data-test-id="force-pull" @click="pull">{{
					hasWorkflowConflicts
						? i18n.baseText('settings.sourceControl.modals.pull.buttons.save')
						: i18n.baseText('settings.sourceControl.modals.pull.buttons.pull')
				}}</N8nButton>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.autoPublishSection {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
}

.select {
	width: 240px;
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
	gap: var(--spacing--2xs);
	min-height: 47px;
	padding-right: var(--spacing--sm);
	border-bottom: var(--border);
}

.fileRow {
	justify-content: space-between;
}

.fileName {
	display: flex;
	flex-direction: column;
	min-width: 0;
}

.name a {
	color: var(--color--text--shade-1);
}

.badges {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.statusBadge {
	white-space: nowrap;
}

.empty {
	padding: var(--spacing--sm);
}

.additional {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.dataTables {
	margin: var(--spacing--4xs) 0 0;
	padding-left: var(--spacing--sm);
}

.footer {
	display: flex;
	justify-content: flex-end;
}
</style>
