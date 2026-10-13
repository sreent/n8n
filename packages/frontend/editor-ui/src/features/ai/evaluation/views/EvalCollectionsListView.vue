<script setup lang="ts">
// Fork code (not in upstream n8n): the collections of a workflow and its runs that are not in a
// collection. It replaces the enterprise view of the same name. See `../FORK.md`.
import { useToast } from '@n8n/composables/useToast';
import { N8nBadge, N8nButton, N8nIcon, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, onMounted, onUnmounted, ref } from 'vue';

import CollectionCard from '../components/Collections/CollectionCard.vue';
import SetupCollectionWizard from '../components/Collections/SetupCollectionWizard.vue';
import UngroupedRunRow from '../components/Collections/UngroupedRunRow.vue';
import { isActiveCollection, useEvalCollectionsStore } from '../evalCollections.store';
import { useEvaluationStore } from '../evaluation.store';

const props = defineProps<{ workflowId: string }>();

const i18n = useI18n();
const toast = useToast();
const collectionsStore = useEvalCollectionsStore();
const evaluationStore = useEvaluationStore();

const isWizardOpen = ref(false);

const collections = computed(() => collectionsStore.getCollections(props.workflowId));

/** The collections with a loaded detail, which the cards need. */
const cards = computed(() =>
	collections.value.flatMap((collection) => {
		const detail = collectionsStore.getDetail(collection.id);
		return detail ? [{ collection, detail }] : [];
	}),
);

const datasetNameByConfigId = computed(
	() =>
		new Map(
			(evaluationStore.evaluationConfigsByWorkflowId[props.workflowId] ?? []).map((config) => [
				config.id,
				config.name,
			]),
		),
);

const datasetName = (configId: string | null | undefined) =>
	configId ? datasetNameByConfigId.value.get(configId) : undefined;

/** The runs that no collection holds, the newest first. */
const ungroupedRuns = computed(() =>
	(evaluationStore.testRunsByWorkflowId[props.workflowId] ?? [])
		.filter((run) => !run.collectionId)
		.sort((a, b) => Date.parse(b.runAt ?? b.createdAt) - Date.parse(a.runAt ?? a.createdAt)),
);

async function loadDetail(collectionId: string) {
	const detail = await collectionsStore.fetchCollectionDetail(props.workflowId, collectionId);
	if (isActiveCollection(detail)) collectionsStore.startPolling(props.workflowId, collectionId);
}

async function load() {
	const [records] = await Promise.all([
		collectionsStore.fetchCollections(props.workflowId).catch((error: unknown) => {
			toast.showError(error, i18n.baseText('evaluation.collections.errors.fetchFailed'));
			return [];
		}),
		evaluationStore.fetchEvaluationConfigs(props.workflowId).catch(() => []),
		evaluationStore.fetchTestRuns(props.workflowId).catch(() => []),
	]);
	await Promise.all(
		records.map(async (record) => await loadDetail(record.id).catch(() => undefined)),
	);
}

/** A new collection: the list, its detail and the runs again. The dialog stays on the list. */
async function onCreated(collectionId: string) {
	await Promise.all([
		collectionsStore.fetchCollections(props.workflowId).catch(() => []),
		loadDetail(collectionId).catch(() => undefined),
		evaluationStore.fetchTestRuns(props.workflowId).catch(() => []),
	]);
}

onMounted(load);
onUnmounted(() => collectionsStore.cleanupPolling());
</script>

<template>
	<div :class="$style.container" data-test-id="eval-collections-list-view">
		<header :class="$style.header">
			<div>
				<N8nText tag="h2" size="xlarge" bold>{{
					i18n.baseText('evaluation.collections.title')
				}}</N8nText>
				<N8nText tag="p" color="text-light">{{
					i18n.baseText('evaluation.collections.subtitle')
				}}</N8nText>
			</div>
			<N8nButton
				data-test-id="eval-collections-new-button"
				icon="plus"
				:label="i18n.baseText('evaluation.collections.newCollection')"
				@click="isWizardOpen = true"
			/>
		</header>

		<section :class="$style.section">
			<div :class="$style.sectionHeading">
				<N8nText tag="h3" bold>{{
					i18n.baseText('evaluation.collections.section.collections')
				}}</N8nText>
				<N8nBadge>{{ String(collections.length) }}</N8nBadge>
			</div>
			<template v-if="collections.length">
				<CollectionCard
					v-for="card in cards"
					:key="card.collection.id"
					:collection="card.collection"
					:detail="card.detail"
					:workflow-id="workflowId"
					:dataset-name="datasetName(card.collection.evaluationConfigId)"
				/>
			</template>
			<div v-else :class="$style.empty">
				<N8nIcon icon="layers" size="large" color="text-light" />
				<N8nText bold>{{ i18n.baseText('evaluation.collections.empty.title') }}</N8nText>
				<N8nText size="small" color="text-light">{{
					i18n.baseText('evaluation.collections.empty.subtitle')
				}}</N8nText>
			</div>
		</section>

		<section :class="$style.section">
			<div :class="$style.sectionHeading">
				<N8nText tag="h3" bold>{{
					i18n.baseText('evaluation.collections.section.ungrouped')
				}}</N8nText>
				<N8nBadge>{{ String(ungroupedRuns.length) }}</N8nBadge>
			</div>
			<N8nText size="small" color="text-light">{{
				i18n.baseText('evaluation.collections.section.ungrouped.helper')
			}}</N8nText>
			<template v-if="ungroupedRuns.length">
				<UngroupedRunRow
					v-for="run in ungroupedRuns"
					:key="run.id"
					:run="run"
					:dataset-name="datasetName(run.evaluationConfigId)"
				/>
			</template>
			<N8nText v-else size="small" color="text-light">{{
				i18n.baseText('evaluation.collections.section.ungrouped.empty')
			}}</N8nText>
		</section>

		<SetupCollectionWizard
			v-model:open="isWizardOpen"
			:workflow-id="workflowId"
			@created="onCreated"
		/>
	</div>
</template>

<style module lang="scss">
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--lg);
	max-width: 1200px;
	margin: var(--spacing--xl) auto 0;
}

.header {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
}

.section {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.sectionHeading {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.empty {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--spacing--4xs);
	padding: var(--spacing--xl);
	border: var(--border);
	border-style: dashed;
	border-radius: var(--radius--lg);
}
</style>
