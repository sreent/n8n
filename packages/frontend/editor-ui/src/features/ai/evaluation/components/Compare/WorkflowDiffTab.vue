<script setup lang="ts">
// Fork code (not in upstream n8n): the difference between the workflows of two versions of a
// collection. It shows the ordinary workflow diff view. See `../../FORK.md`.
import { N8nOption, N8nSelect, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, markRaw, ref, shallowRef, watch } from 'vue';

import { useWorkflowsListStore } from '@/app/stores/workflowsList.store';
import WorkflowDiffView from '@/features/workflows/workflowDiff/WorkflowDiffView.vue';
import { useWorkflowHistoryStore } from '@/features/workflows/workflowHistory/workflowHistory.store';
import type { IWorkflowDb } from '@/Interface';

import type { CompareVersion } from '../../composables/useCompareData';
import { versionLetter } from '../shared/versionPalette';

const props = defineProps<{ versions: CompareVersion[]; workflowId: string }>();

const i18n = useI18n();
const workflowsListStore = useWorkflowsListStore();
const workflowHistoryStore = useWorkflowHistoryStore();

const sourceIndex = ref(0);
const targetIndex = ref(1);
const source = shallowRef<IWorkflowDb>();
const target = shallowRef<IWorkflowDb>();
const failed = ref(false);

const labelOf = (version: CompareVersion) => `${versionLetter(version.index)} · ${version.label}`;

const sourceVersion = computed(() => props.versions[sourceIndex.value]);
const targetVersion = computed(() => props.versions[targetIndex.value]);

/** A version picked on one side that the other side shows already swaps the two sides. */
function pickSource(index: number) {
	if (index === targetIndex.value) targetIndex.value = sourceIndex.value;
	sourceIndex.value = index;
}

function pickTarget(index: number) {
	if (index === sourceIndex.value) sourceIndex.value = targetIndex.value;
	targetIndex.value = index;
}

/** The workflow of a version: a saved version, or the current workflow for the draft. */
async function workflowOf(version: CompareVersion, current: Promise<IWorkflowDb>) {
	if (version.workflowVersionId === null) return markRaw(await current);
	const saved = await workflowHistoryStore.getWorkflowVersion(
		props.workflowId,
		version.workflowVersionId,
	);
	return markRaw({
		...(await current),
		versionId: saved.versionId,
		nodes: saved.nodes,
		connections: saved.connections,
	});
}

async function load() {
	const from = sourceVersion.value;
	const to = targetVersion.value;
	if (!from || !to) return;
	failed.value = false;
	try {
		const current = workflowsListStore.fetchWorkflow(props.workflowId);
		const [sourceWorkflow, targetWorkflow] = await Promise.all([
			workflowOf(from, current),
			workflowOf(to, current),
		]);
		source.value = sourceWorkflow;
		target.value = targetWorkflow;
	} catch {
		failed.value = true;
	}
}

watch([sourceIndex, targetIndex, () => props.versions.length], load, { immediate: true });
</script>

<template>
	<div :class="$style.tab" data-test-id="compare-workflow-diff-tab">
		<N8nText v-if="versions.length < 2" size="small" color="text-light">{{
			i18n.baseText('evaluation.compare.workflowDiff.needTwo')
		}}</N8nText>
		<template v-else>
			<div :class="$style.pickers">
				<N8nText size="small" color="text-light">{{
					i18n.baseText('evaluation.compare.workflowDiff.base')
				}}</N8nText>
				<N8nSelect
					:model-value="sourceIndex"
					size="small"
					data-test-id="workflow-diff-source-select"
					@update:model-value="pickSource"
				>
					<N8nOption
						v-for="version in versions"
						:key="version.testRunId"
						:value="version.index"
						:label="labelOf(version)"
					/>
				</N8nSelect>
				<N8nText size="small" color="text-light">{{
					i18n.baseText('evaluation.compare.workflowDiff.compare')
				}}</N8nText>
				<N8nSelect
					:model-value="targetIndex"
					size="small"
					data-test-id="workflow-diff-target-select"
					@update:model-value="pickTarget"
				>
					<N8nOption
						v-for="version in versions"
						:key="version.testRunId"
						:value="version.index"
						:label="labelOf(version)"
					/>
				</N8nSelect>
			</div>
			<N8nText v-if="failed" size="small" color="danger">{{
				i18n.baseText('evaluation.compare.workflowDiff.loadError')
			}}</N8nText>
			<div v-else-if="source && target && sourceVersion && targetVersion" :class="$style.diff">
				<WorkflowDiffView
					:source-workflow="source"
					:target-workflow="target"
					:source-label="labelOf(sourceVersion)"
					:target-label="labelOf(targetVersion)"
				/>
			</div>
		</template>
	</div>
</template>

<style module lang="scss">
.tab {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.pickers {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.diff {
	height: 600px;
}
</style>
