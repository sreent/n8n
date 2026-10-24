<script setup lang="ts">
// Fork code (not in upstream n8n): the dialog of a new collection: its name, its dataset, the
// versions to compare, and the metrics of the dataset. It replaces the enterprise component of
// the same name. See `../../FORK.md`.
import type { EvalVersionEntry } from '@n8n/api-types';
import { useToast } from '@n8n/composables/useToast';
import {
	N8nButton,
	N8nDialog,
	N8nDialogBody,
	N8nDialogDescription,
	N8nDialogFooter,
	N8nIcon,
	N8nInput,
	N8nOption,
	N8nSelect,
	N8nText,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, ref, watch } from 'vue';

import { useEvalCollectionsStore } from '../../evalCollections.store';
import { useEvaluationStore } from '../../evaluation.store';
import DatasetPicker from './DatasetPicker.vue';
import VersionsTable, { type VersionRow } from './VersionsTable.vue';

const props = defineProps<{ workflowId: string }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ created: [collectionId: string] }>();

const i18n = useI18n();
const toast = useToast();
const evaluationStore = useEvaluationStore();
const collectionsStore = useEvalCollectionsStore();

type Order = 'recent' | 'oldest';
const ALL_SOURCES = 'all';

const name = ref('');
const configId = ref<string>();
const selected = ref<string[]>([]);
const source = ref(ALL_SOURCES);
const order = ref<Order>('recent');
const isCreating = ref(false);

const configs = computed(
	() => evaluationStore.evaluationConfigsByWorkflowId[props.workflowId] ?? [],
);
const config = computed(() => configs.value.find((item) => item.id === configId.value));
const datasetName = computed(() => config.value?.name ?? '');

/** The versions in the order of the server. Their letters and the request keep this order. */
const allRows = computed((): VersionRow[] =>
	(configId.value ? (collectionsStore.getVersions(configId.value)?.versions ?? []) : []).map(
		(version, index) => ({ key: version.workflowVersionId ?? 'draft', index, version }),
	),
);

const sources = computed(() => [...new Set(allRows.value.map((row) => row.version.sourceLabel))]);

const runTime = (version: EvalVersionEntry) =>
	version.lastRun ? Date.parse(version.lastRun.runAt) : 0;

/** The current version stays on top. The others go by the time of their last run. */
const rows = computed(() =>
	allRows.value
		.filter((row) => source.value === ALL_SOURCES || row.version.sourceLabel === source.value)
		.sort((a, b) => {
			if (a.version.isCurrent !== b.version.isCurrent) return a.version.isCurrent ? -1 : 1;
			const difference = runTime(a.version) - runTime(b.version);
			return order.value === 'recent' ? -difference : difference;
		}),
);

const chosen = computed(() => allRows.value.filter((row) => selected.value.includes(row.key)));
const newCount = computed(() => chosen.value.filter((row) => !row.version.lastRun).length);
const canCreate = computed(
	() => !!name.value.trim() && !!configId.value && chosen.value.length >= 2 && !isCreating.value,
);

const summary = computed(() => {
	const count = chosen.value.length;
	if (count < 2) return i18n.baseText('evaluation.setup.footer.summary.pickMore');
	if (newCount.value === 0) {
		return i18n.baseText('evaluation.setup.footer.summary.reuse', {
			adjustToNumber: count,
			interpolate: { count },
		});
	}
	return i18n.baseText('evaluation.setup.footer.summary.mixed', {
		interpolate: { total: count, newCount: newCount.value },
	});
});

const runsExplain = computed(() => {
	if (chosen.value.length < 2) return undefined;
	return newCount.value === 0
		? i18n.baseText('evaluation.setup.footer.runsExplain.reuse', {
				interpolate: { dataset: datasetName.value },
			})
		: i18n.baseText('evaluation.setup.footer.runsExplain.mixed', {
				interpolate: { newCount: newCount.value, dataset: datasetName.value },
			});
});

const submitLabel = computed(() => {
	const count = chosen.value.length;
	return i18n.baseText(
		newCount.value === 0
			? 'evaluation.setup.footer.cta.compare'
			: 'evaluation.setup.footer.cta.runAndCompare',
		{ adjustToNumber: count, interpolate: { count } },
	);
});

const sourceOptions = computed(() => [
	{ value: ALL_SOURCES, label: i18n.baseText('evaluation.setup.versions.filter.all') },
	...sources.value.map((label) => ({ value: label, label })),
]);

const orderOptions = computed(() => [
	{ value: 'recent', label: i18n.baseText('evaluation.setup.versions.sort.recent') },
	{ value: 'oldest', label: i18n.baseText('evaluation.setup.versions.sort.oldest') },
]);

function pickSource(value: unknown) {
	if (typeof value === 'string') source.value = value;
}

function pickOrder(value: unknown) {
	if (value === 'recent' || value === 'oldest') order.value = value;
}

function toggle(key: string, checked: boolean) {
	selected.value = checked
		? [...selected.value, key]
		: selected.value.filter((item) => item !== key);
}

async function loadConfigs() {
	try {
		await evaluationStore.fetchEvaluationConfigs(props.workflowId);
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluation.setup.errors.loadDatasetsFailed'));
	}
}

async function loadVersions(id: string) {
	try {
		await collectionsStore.fetchEvalVersions(props.workflowId, id);
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluation.setup.errors.loadVersionsFailed'));
	}
}

async function create() {
	if (!configId.value || !canCreate.value) return;
	isCreating.value = true;
	try {
		const collection = await collectionsStore.createCollection(props.workflowId, {
			name: name.value.trim(),
			evaluationConfigId: configId.value,
			versions: chosen.value.map((row) => ({
				workflowVersionId: row.version.workflowVersionId,
				existingTestRunId: row.version.lastRun?.testRunId,
			})),
		});
		open.value = false;
		emit('created', collection.id);
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluation.setup.errors.createFailed'));
	} finally {
		isCreating.value = false;
	}
}

watch(open, (isOpen) => {
	if (!isOpen) return;
	name.value = '';
	configId.value = undefined;
	selected.value = [];
	source.value = ALL_SOURCES;
	order.value = 'recent';
	void loadConfigs();
});

watch(configId, (id) => {
	selected.value = [];
	if (id) void loadVersions(id);
});
</script>

<template>
	<N8nDialog v-model:open="open" size="large" :header="i18n.baseText('evaluation.setup.title')">
		<N8nDialogBody :class="$style.body" data-test-id="setup-collection-wizard">
			<N8nDialogDescription>{{ i18n.baseText('evaluation.setup.subtitle') }}</N8nDialogDescription>
			<div :class="$style.field">
				<N8nText size="small" bold>{{ i18n.baseText('evaluation.setup.collectionName') }}</N8nText>
				<N8nInput
					v-model="name"
					data-test-id="setup-collection-wizard-name"
					:placeholder="i18n.baseText('evaluation.setup.collectionName.placeholder')"
				/>
			</div>
			<div :class="$style.field">
				<N8nText size="small" bold>{{ i18n.baseText('evaluation.setup.dataset') }}</N8nText>
				<N8nText size="xsmall" color="text-light">{{
					i18n.baseText('evaluation.setup.dataset.helper')
				}}</N8nText>
				<DatasetPicker
					v-model="configId"
					:configs="configs"
					:match-count="configId ? allRows.length : undefined"
				/>
			</div>
			<template v-if="configId">
				<div :class="$style.field">
					<div :class="$style.versionsHeading">
						<div>
							<N8nText size="small" bold>{{ i18n.baseText('evaluation.setup.versions') }}</N8nText>
							<N8nText size="xsmall" color="text-light">{{
								i18n.baseText('evaluation.setup.versions.helper')
							}}</N8nText>
						</div>
						<div :class="$style.filters">
							<N8nText size="small" color="text-light">{{
								i18n.baseText('evaluation.setup.versions.filter.source')
							}}</N8nText>
							<N8nSelect :model-value="source" size="small" @update:model-value="pickSource">
								<N8nOption
									v-for="option in sourceOptions"
									:key="option.value"
									:value="option.value"
									:label="option.label"
								/>
							</N8nSelect>
							<N8nText size="small" color="text-light">{{
								i18n.baseText('evaluation.setup.versions.sort.label')
							}}</N8nText>
							<N8nSelect :model-value="order" size="small" @update:model-value="pickOrder">
								<N8nOption
									v-for="option in orderOptions"
									:key="option.value"
									:value="option.value"
									:label="option.label"
								/>
							</N8nSelect>
						</div>
					</div>
					<VersionsTable
						:rows="rows"
						:selected="selected"
						:dataset-name="datasetName"
						:workflow-id="workflowId"
						@toggle="toggle"
					/>
				</div>
				<div :class="$style.field">
					<N8nText size="small" bold>{{ i18n.baseText('evaluation.setup.metrics') }}</N8nText>
					<N8nText size="xsmall" color="text-light">{{
						i18n.baseText('evaluation.setup.metrics.helper')
					}}</N8nText>
					<N8nText v-if="!config?.metrics.length" size="small" color="text-light">{{
						i18n.baseText('evaluation.setup.metrics.empty')
					}}</N8nText>
					<div :class="$style.metrics">
						<span
							v-for="metric in config?.metrics ?? []"
							:key="metric.id"
							:class="$style.metric"
							data-test-id="setup-collection-wizard-metric"
						>
							<N8nIcon icon="check" size="xsmall" />
							<span>{{ metric.name }}</span>
						</span>
						<N8nButton
							data-test-id="setup-collection-wizard-add-metric"
							variant="ghost"
							size="small"
							icon="plus"
							:label="i18n.baseText('evaluation.setup.metrics.addMetric')"
							:title="i18n.baseText('evaluation.setup.metrics.addComingSoon')"
							disabled
						/>
					</div>
				</div>
			</template>
		</N8nDialogBody>
		<N8nDialogFooter :class="$style.footer">
			<div :class="$style.summary">
				<N8nText size="small" bold>{{ summary }}</N8nText>
				<N8nText v-if="runsExplain" size="xsmall" color="text-light">{{ runsExplain }}</N8nText>
			</div>
			<N8nButton
				data-test-id="setup-collection-wizard-cancel"
				variant="outline"
				:label="i18n.baseText('evaluation.setup.footer.cancel')"
				@click="open = false"
			/>
			<N8nButton
				data-test-id="setup-collection-wizard-submit"
				:label="submitLabel"
				:disabled="!canCreate"
				:loading="isCreating"
				@click="create"
			/>
		</N8nDialogFooter>
	</N8nDialog>
</template>

<style module lang="scss">
.body {
	gap: var(--spacing--md);
}

.field {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.versionsHeading {
	display: flex;
	align-items: flex-end;
	justify-content: space-between;
}

.filters {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.metrics {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--spacing--2xs);
}

.metric {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--4xs);
	padding: var(--spacing--4xs) var(--spacing--2xs);
	border: var(--border);
	border-radius: var(--radius);
}

.footer {
	align-items: center;
}

.summary {
	display: flex;
	flex-direction: column;
	margin-right: auto;
}
</style>
