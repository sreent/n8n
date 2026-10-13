<script setup lang="ts">
// Fork code (not in upstream n8n): the modal that adds an execution to the dataset of an evaluation
// config. The user maps each column of the data table to a field of the input or the output of the
// execution, or leaves it empty. It replaces the enterprise component of the same name. See
// `../../FORK.md`.
import type { DatasetCandidateResponse, DatasetColumnMapping } from '@n8n/api-types';
import { useTelemetry } from '@n8n/composables/useTelemetry';
import { useToast } from '@n8n/composables/useToast';
import { N8nButton, N8nInputLabel, N8nOption, N8nSelect, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, onMounted, ref } from 'vue';

import Modal from '@/app/components/Modal.vue';
import { ADD_EXECUTION_TO_DATASET_MODAL_KEY } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';

import { useEvaluationStore } from '../../evaluation.store';
import type { EvaluationConfig } from '../../evaluation.types';
import { fieldText } from '../../wizard.utils';

/** The modal data: the configs with a data table, the execution and its workflow. */
const props = defineProps<{
	modalName: string;
	data: Record<string, unknown>;
}>();

const isConfig = (value: unknown): value is EvaluationConfig =>
	typeof value === 'object' &&
	value !== null &&
	'id' in value &&
	typeof value.id === 'string' &&
	'name' in value &&
	typeof value.name === 'string';

/** The value of "Leave empty" in a select. */
const EMPTY = '';

const i18n = useI18n();
const toast = useToast();
const telemetry = useTelemetry();
const uiStore = useUIStore();
const evaluationStore = useEvaluationStore();

const configs = computed(() =>
	Array.isArray(props.data.configs) ? props.data.configs.filter(isConfig) : [],
);
const executionId = computed(() =>
	typeof props.data.executionId === 'string' ? props.data.executionId : '',
);
const workflowId = computed(() =>
	typeof props.data.workflowId === 'string' ? props.data.workflowId : '',
);

const configId = ref(configs.value[0]?.id ?? '');
const candidate = ref<DatasetCandidateResponse>();
/** The choice for each column: `source:field`, or empty. */
const choices = ref<Record<string, string>>({});
const isSaving = ref(false);

const columns = computed(() => candidate.value?.columns ?? []);

const fieldOptions = computed(() => {
	const fields = candidate.value?.fields;
	if (!fields) return [];
	return [
		...fields.inputs.map((field) => ({ source: 'input' as const, ...field })),
		...fields.outputs.map((field) => ({ source: 'output' as const, ...field })),
	].map((field) => ({
		value: `${field.source}:${field.key}`,
		label: `${field.key} (${i18n.baseText(`evaluations.addToDataset.source.${field.source}`)})`,
		sample: field.sample,
	}));
});

const optionValue = (mapping: DatasetColumnMapping) =>
	mapping ? `${mapping.source}:${mapping.field}` : EMPTY;

function toMapping(choice: string | undefined): DatasetColumnMapping {
	const option = fieldOptions.value.find((item) => item.value === choice);
	if (!option) return null;
	const [source, ...field] = option.value.split(':');
	return { source: source === 'input' ? 'input' : 'output', field: field.join(':') };
}

function preview(column: string) {
	const option = fieldOptions.value.find((item) => item.value === choices.value[column]);
	if (!option) return '';
	const text = fieldText(option.sample);
	return text === '' ? i18n.baseText('evaluations.addToDataset.empty') : text;
}

const mappedCount = computed(
	() => columns.value.filter((column) => toMapping(choices.value[column.name]) !== null).length,
);

async function loadCandidate() {
	candidate.value = undefined;
	choices.value = {};
	if (!configId.value || !executionId.value) return;
	try {
		const result = await evaluationStore.getDatasetCandidate({
			workflowId: workflowId.value,
			configId: configId.value,
			executionId: executionId.value,
		});
		candidate.value = result;
		choices.value = Object.fromEntries(
			result.columns.map((column) => [
				column.name,
				optionValue(result.suggestedMapping[column.name] ?? null),
			]),
		);
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluations.addToDataset.error.candidate'));
	}
}

async function onConfigChange(id: string) {
	configId.value = id;
	await loadCandidate();
}

function close() {
	uiStore.closeModal(ADD_EXECUTION_TO_DATASET_MODAL_KEY);
}

async function submit() {
	if (!candidate.value) return;
	isSaving.value = true;
	try {
		await evaluationStore.addExecutionToDataset({
			workflowId: workflowId.value,
			configId: configId.value,
			row: {
				executionId: executionId.value,
				mapping: Object.fromEntries(
					columns.value.map((column) => [column.name, toMapping(choices.value[column.name])]),
				),
			},
		});
		telemetry.track('User added execution to evaluation dataset', {
			columns_mapped: mappedCount.value,
			config_id: configId.value,
			execution_id: executionId.value,
			workflow_id: workflowId.value,
		});
		toast.showMessage({
			title: i18n.baseText('evaluations.addToDataset.success.title'),
			type: 'success',
		});
		close();
	} catch (error) {
		toast.showError(error, i18n.baseText('evaluations.addToDataset.error.submit'));
	} finally {
		isSaving.value = false;
	}
}

onMounted(async () => {
	telemetry.track('User opened add execution to dataset modal', {
		config_count: configs.value.length,
		execution_id: executionId.value,
		workflow_id: workflowId.value,
	});
	await loadCandidate();
});
</script>

<template>
	<Modal
		:name="ADD_EXECUTION_TO_DATASET_MODAL_KEY"
		:title="i18n.baseText('evaluations.addToDataset.title')"
		width="560px"
		data-test-id="add-execution-to-dataset-modal"
	>
		<template #content>
			<div :class="$style.content">
				<N8nInputLabel :label="i18n.baseText('evaluations.addToDataset.config.label')" />
				<N8nText v-if="configs.length === 1" size="small" color="text-dark">{{
					configs[0].name
				}}</N8nText>
				<N8nSelect
					v-else-if="configs.length > 1"
					:model-value="configId"
					size="small"
					data-test-id="add-execution-to-dataset-config-select"
					@update:model-value="onConfigChange"
				>
					<N8nOption
						v-for="config in configs"
						:key="config.id"
						:label="config.name"
						:value="config.id"
					/>
				</N8nSelect>
				<div
					v-if="columns.length"
					:class="$style.mapping"
					data-test-id="add-execution-to-dataset-mapping"
				>
					<N8nInputLabel :label="i18n.baseText('evaluations.addToDataset.mapping.title')" />
					<div
						v-for="column in columns"
						:key="column.name"
						:class="$style.column"
						:data-test-id="`add-execution-to-dataset-column-${column.name}`"
					>
						<N8nInputLabel :label="column.name" />
						<N8nText size="xsmall" color="text-light">{{ column.type }}</N8nText>
						<N8nSelect
							v-model="choices[column.name]"
							size="small"
							filterable
							:placeholder="i18n.baseText('evaluations.addToDataset.field.placeholder')"
							:data-test-id="`add-execution-to-dataset-select-${column.name}`"
						>
							<N8nOption
								:label="i18n.baseText('evaluations.addToDataset.leaveEmpty')"
								:value="EMPTY"
							/>
							<N8nOption
								v-for="option in fieldOptions"
								:key="option.value"
								:label="option.label"
								:value="option.value"
							/>
						</N8nSelect>
						<N8nText v-if="preview(column.name)" size="xsmall" color="text-base">{{
							preview(column.name)
						}}</N8nText>
					</div>
				</div>
				<N8nText v-else size="small" color="text-light">{{
					i18n.baseText('evaluations.addToDataset.noColumns')
				}}</N8nText>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton
					type="secondary"
					:label="i18n.baseText('generic.cancel')"
					data-test-id="add-execution-to-dataset-cancel"
					@click="close"
				/>
				<N8nButton
					type="primary"
					:label="i18n.baseText('evaluations.addToDataset.submit')"
					:disabled="!candidate || mappedCount === 0 || isSaving"
					data-test-id="add-execution-to-dataset-submit"
					@click="submit"
				/>
			</div>
		</template>
	</Modal>
</template>

<style module lang="scss">
.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.mapping {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
	margin-top: var(--spacing--xs);
}

.column {
	display: grid;
	grid-template-columns: 1fr auto;
	gap: var(--spacing--4xs) var(--spacing--2xs);
	align-items: center;
}

.footer {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--2xs);
}
</style>
