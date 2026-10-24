<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the selection modal of a project. For promote, it shows the
 * changes of the project that a promote sends to Git (a preview). For apply, it shows the incoming
 * changes, and "Apply all changes" applies the package of the branch to this instance. A blocked
 * apply opens the dialog of the bindings. See `../FORK.md`.
 */
import { useToast } from '@n8n/composables/useToast';
import { N8nButton, N8nCheckbox, N8nInput, N8nText, useMessage } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, ref } from 'vue';

import Modal from '@/app/components/Modal.vue';
import TimeAgo from '@/app/components/TimeAgo.vue';
import { MODAL_CONFIRM } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';
import { useProjectsStore } from '@/features/collaboration/projects/projects.store';

import { applyPackage, continueApplyPackage, getProjectChanges } from '../promotions.api';
import { PROMOTION_SELECT_MODAL_KEY } from '../promotions.constants';
import { promotionEventBus } from '../promotions.eventBus';
import type {
	ApplyResult,
	BindingPreflight,
	PromotionChange,
	PromotionSelectModalData,
} from '../promotions.types';
import PromotionBindingsDialog from './PromotionBindingsDialog.vue';

const props = defineProps<{
	modalName: string;
	data: PromotionSelectModalData;
}>();

const i18n = useI18n();
const toast = useToast();
const message = useMessage();
const rootStore = useRootStore();
const uiStore = useUIStore();
const projectsStore = useProjectsStore();

const direction = computed(() => props.data.direction ?? 'promote');
const isApply = computed(() => direction.value === 'apply');

const changes = ref<PromotionChange[]>([]);
const commitSha = ref<string | null>(null);
const loadFailed = ref(false);
const lastRefreshed = ref<string>();
const search = ref('');
const selected = ref<string[]>([]);
const preflight = ref<BindingPreflight>();
const continueError = ref<string>();
const continuing = ref(false);

const title = computed(() =>
	i18n.baseText(isApply.value ? 'promotions.modal.incoming.title' : 'promotions.modal.title'),
);

const visibleChanges = computed(() => {
	const query = search.value.trim().toLowerCase();
	if (!query) return changes.value;
	return changes.value.filter((change) => change.name.toLowerCase().includes(query));
});

const allSelected = computed(
	() => changes.value.length > 0 && selected.value.length === changes.value.length,
);

const promoteLabel = computed(() =>
	selected.value.length === 1
		? i18n.baseText('promotions.modal.promoteSingle')
		: i18n.baseText('promotions.modal.promote', {
				interpolate: { count: String(selected.value.length) },
			}),
);

function dependenciesText(count: number) {
	return count === 1
		? i18n.baseText('promotions.modal.dependency')
		: i18n.baseText('promotions.modal.dependencies', { interpolate: { count: String(count) } });
}

function isSelected(id: string) {
	return selected.value.includes(id);
}

function setSelected(id: string, value: boolean) {
	selected.value = value
		? [...selected.value.filter((item) => item !== id), id]
		: selected.value.filter((item) => item !== id);
}

function toggleAll(value: boolean) {
	selected.value = value ? changes.value.map(({ id }) => id) : [];
}

async function loadChanges() {
	try {
		const result = await getProjectChanges(
			rootStore.restApiContext,
			props.data.projectId,
			direction.value,
		);
		changes.value = result.changes;
		commitSha.value = result.commitSha;
		loadFailed.value = false;
		lastRefreshed.value = new Date().toISOString();
		const ids = new Set(result.changes.map(({ id }) => id));
		selected.value = selected.value.filter((id) => ids.has(id));
	} catch {
		changes.value = [];
		loadFailed.value = true;
	}
}

function close() {
	uiStore.closeModal(PROMOTION_SELECT_MODAL_KEY);
}

function appliedText(result: Extract<ApplyResult, { status: 'applied' }>) {
	const { workflows } = result.counts;
	const text = i18n.baseText('promotions.modal.incoming.applied.message', {
		interpolate: {
			created: String(workflows.created),
			updated: String(workflows.updated),
			archived: String(workflows.archived),
			deleted: String(workflows.deleted),
		},
	});
	const notPublished = workflows.publishing.blocked + workflows.publishing.failed;
	if (notPublished === 0) return { text, type: 'success' as const };
	const extra = i18n.baseText('promotions.modal.incoming.applied.notPublished', {
		interpolate: { count: String(notPublished) },
	});
	return { text: `${text} ${extra}`, type: 'warning' as const };
}

/** After an apply: the project of the page is new, or the apply removed it. */
async function onApplied(result: Extract<ApplyResult, { status: 'applied' }>) {
	const { text, type } = appliedText(result);
	toast.showMessage({
		title: i18n.baseText('promotions.modal.incoming.applied.title'),
		message: text,
		type,
	});
	const projectId = props.data.projectId;
	try {
		const project = await projectsStore.fetchProject(projectId);
		if (projectsStore.currentProject?.id === projectId) projectsStore.setCurrentProject(project);
		promotionEventBus.emit('applied', { projectId, project });
	} catch {
		toast.showMessage({ title: i18n.baseText('promotions.applied.projectRemoved'), type: 'info' });
		promotionEventBus.emit('projectRemoved', { projectId });
	}
	close();
}

function showSourceChanged() {
	toast.showMessage({
		title: i18n.baseText('promotions.modal.incoming.paused.title'),
		message: i18n.baseText('promotions.modal.incoming.paused.source-changed'),
		type: 'warning',
	});
}

function expectedSource() {
	const apply = props.data.apply;
	if (!apply) return undefined;
	return {
		connectionId: apply.connectionId,
		source: { configId: apply.configId, branchName: apply.branchName, commitSha: commitSha.value },
	};
}

async function applyAll() {
	const source = expectedSource();
	if (!source) return;
	const answer = await message.confirm(
		i18n.baseText('promotions.modal.incoming.confirm.message'),
		i18n.baseText('promotions.modal.incoming.confirm.title'),
		{
			type: 'warning',
			confirmButtonText: i18n.baseText('promotions.modal.incoming.confirm.confirmButtonText'),
			cancelButtonText: i18n.baseText('promotions.modal.close'),
		},
	);
	if (answer !== MODAL_CONFIRM) return;
	try {
		const result = await applyPackage(
			rootStore.publicApiContext,
			source.connectionId,
			source.source,
		);
		if (result.status === 'applied') {
			await onApplied(result);
		} else if (result.status === 'blocked') {
			continueError.value = undefined;
			preflight.value = result.preflight;
		} else {
			showSourceChanged();
			await loadChanges();
		}
	} catch (error) {
		toast.showError(error, i18n.baseText('promotions.modal.incoming.applyError'));
		await loadChanges();
	}
}

async function continueApply() {
	const source = expectedSource();
	if (!source) return;
	continuing.value = true;
	try {
		const result = await continueApplyPackage(
			rootStore.publicApiContext,
			source.connectionId,
			source.source,
		);
		continueError.value = undefined;
		if (result.status === 'applied') {
			preflight.value = undefined;
			await onApplied(result);
		} else if (result.status === 'blocked') {
			preflight.value = result.preflight;
		} else {
			preflight.value = undefined;
			await loadChanges();
			showSourceChanged();
		}
	} catch (error) {
		continueError.value = error instanceof Error ? error.message : String(error);
	} finally {
		continuing.value = false;
	}
}

function backToList() {
	preflight.value = undefined;
	continueError.value = undefined;
}

onMounted(loadChanges);
</script>

<template>
	<PromotionBindingsDialog
		v-if="preflight"
		:preflight="preflight"
		:continue-error="continueError"
		:continuing="continuing"
		@back="backToList"
		@continue="continueApply"
	/>
	<Modal v-else :name="PROMOTION_SELECT_MODAL_KEY" :title="title" width="640px">
		<template #content>
			<div :class="$style.toolbar">
				<N8nCheckbox
					:model-value="allSelected"
					data-test-id="promotion-select-all"
					@update:model-value="toggleAll"
				/>
				<N8nInput
					v-model="search"
					:class="$style.search"
					size="small"
					clearable
					:placeholder="i18n.baseText('promotions.modal.search.placeholder')"
					data-test-id="promotion-search"
				/>
				<N8nText
					v-if="lastRefreshed && !loadFailed"
					size="small"
					color="text-light"
					data-test-id="promotion-last-refreshed"
				>
					{{ i18n.baseText('promotions.modal.lastRefreshed') }}
					<TimeAgo :date="lastRefreshed" live />
				</N8nText>
				<N8nButton
					variant="ghost"
					size="small"
					icon="refresh-cw"
					data-test-id="promotion-refresh"
					@click="loadChanges"
				>
					{{ i18n.baseText('promotions.modal.refresh') }}
				</N8nButton>
			</div>
			<div v-if="loadFailed" :class="$style.state" data-test-id="promotion-error">
				<N8nText bold>{{ i18n.baseText('promotions.modal.error') }}</N8nText>
				<N8nText size="small" color="text-light">{{
					i18n.baseText('promotions.modal.error.description')
				}}</N8nText>
				<N8nButton
					variant="outline"
					size="small"
					data-test-id="promotion-retry"
					@click="loadChanges"
				>
					{{ i18n.baseText('promotions.modal.retry') }}
				</N8nButton>
			</div>
			<div v-else-if="changes.length === 0" :class="$style.state">
				<N8nText bold>{{
					i18n.baseText(isApply ? 'promotions.modal.incoming.empty' : 'promotions.modal.empty')
				}}</N8nText>
				<N8nText size="small" color="text-light">{{
					i18n.baseText(
						isApply
							? 'promotions.modal.incoming.empty.description'
							: 'promotions.modal.empty.description',
					)
				}}</N8nText>
			</div>
			<N8nText
				v-else-if="visibleChanges.length === 0"
				tag="p"
				size="small"
				color="text-light"
				data-test-id="promotion-no-results"
			>
				{{ i18n.baseText('promotions.modal.noResults') }}
			</N8nText>
			<div v-else :class="$style.list">
				<div
					v-for="change in visibleChanges"
					:key="change.id"
					:class="$style.row"
					data-test-id="promotion-change-row"
				>
					<N8nCheckbox
						:model-value="isSelected(change.id)"
						@update:model-value="setSelected(change.id, $event)"
					/>
					<N8nText :class="$style.name">{{ change.name }}</N8nText>
					<span
						:class="[$style.status, $style[change.status]]"
						data-test-id="promotion-change-status"
						>{{ i18n.baseText(`promotions.modal.status.${change.status}`) }}</span
					>
					<N8nText v-if="change.updatedAt" size="small" color="text-light">
						<TimeAgo :date="change.updatedAt" />
					</N8nText>
					<template v-if="change.dependencyCount > 0">
						<N8nText size="small" color="text-light">·</N8nText>
						<N8nText size="small" color="text-light">{{
							dependenciesText(change.dependencyCount)
						}}</N8nText>
					</template>
				</div>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nText v-if="!isApply" size="small" color="text-light">
					{{ i18n.baseText('promotions.modal.previewOnly') }}
				</N8nText>
				<N8nText v-else-if="selected.length > 0" size="small" color="text-light">
					{{
						i18n.baseText('promotions.modal.incoming.selected', {
							interpolate: { count: String(selected.length) },
						})
					}}
				</N8nText>
				<div :class="$style.actions">
					<N8nButton variant="outline" @click="close">
						{{ i18n.baseText('promotions.modal.close') }}
					</N8nButton>
					<N8nButton v-if="!isApply" disabled data-test-id="promotion-submit">
						{{ promoteLabel }}
					</N8nButton>
					<N8nButton
						v-else
						:disabled="loadFailed"
						data-test-id="promotion-apply-all"
						@click="applyAll"
					>
						{{ i18n.baseText('promotions.modal.incoming.applyAll') }}
					</N8nButton>
				</div>
			</div>
		</template>
	</Modal>
</template>

<style module lang="scss">
.toolbar {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	margin-bottom: var(--spacing--xs);
}

.search {
	flex: 1;
}

.list {
	display: flex;
	flex-direction: column;
	max-height: 50vh;
	overflow-y: auto;
}

.row {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
	padding: var(--spacing--2xs) 0;
	border-bottom: var(--border);
}

.name {
	flex: 1;
}

.status {
	font-size: var(--font-size--2xs);
	padding: var(--spacing--5xs) var(--spacing--3xs);
	border-radius: var(--radius);
	background-color: var(--color--background--shade-1);
}

.new {
	color: var(--color--success);
}

.deleted,
.archived {
	color: var(--color--danger);
}

.state {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--spacing--3xs);
	padding: var(--spacing--lg) 0;
}

.footer {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.actions {
	display: flex;
	gap: var(--spacing--2xs);
	margin-left: auto;
}
</style>
