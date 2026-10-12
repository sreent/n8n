<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the button of the highlighted data of an execution in the
 * execution preview, with a badge of the count, and a dropdown that lists the custom data. The
 * button needs the `workflow:update` scope. It replaces the enterprise component of the same name.
 * See `packages/cli/src/executions/FORK.md`.
 */
import { N8nBadge, N8nButton, N8nHeading, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { getResourcePermissions } from '@n8n/permissions';
import { ElDropdown } from 'element-plus';
import type { ExecutionSummary } from 'n8n-workflow';
import { computed } from 'vue';

import { useInjectWorkflowId } from '@/app/composables/useInjectWorkflowId';
import { useWorkflowsListStore } from '@/app/stores/workflowsList.store';

const props = defineProps<{
	execution: ExecutionSummary & { customData?: Record<string, string> };
}>();

const i18n = useI18n();
const workflowId = useInjectWorkflowId();
const workflowsListStore = useWorkflowsListStore();

const workflowPermissions = computed(
	() =>
		getResourcePermissions(workflowsListStore.getWorkflowById(workflowId.value)?.scopes).workflow,
);

const customData = computed(() =>
	Object.entries(props.execution.customData ?? {}).map(([key, value]) => ({ key, value })),
);
</script>

<template>
	<ElDropdown trigger="click">
		<N8nButton
			:title="i18n.baseText('executionDetails.additionalActions')"
			data-test-id="execution-preview-ellipsis-button"
			:disabled="!workflowPermissions.update"
			variant="subtle"
			size="small"
			icon="list-checks"
			:class="{
				[$style.highlightDataButton]: true,
				[$style.highlightDataButtonActive]: customData.length > 0,
			}"
		>
			<N8nBadge v-if="customData.length > 0" :class="$style.badge" variant="primary">
				{{ customData.length }}
			</N8nBadge>
		</N8nButton>
		<template #dropdown>
			<div
				:class="['execution-annotation-panel', $style.container]"
				data-test-id="execution-annotation-panel"
			>
				<div :class="$style.section">
					<div :class="$style.heading">
						<N8nHeading tag="h3" size="small" color="text-dark">
							{{ i18n.baseText('generic.annotationData') }}
						</N8nHeading>
					</div>
					<div v-if="customData.length > 0" :class="$style.metadata">
						<div v-for="entry in customData" :key="entry.key" :class="$style.customDataEntry">
							<N8nText :class="$style.key" size="small" color="text-base">
								{{ entry.key }}
							</N8nText>
							<N8nText :class="$style.value" size="small" color="text-base">
								{{ entry.value }}
							</N8nText>
						</div>
					</div>
					<div
						v-else
						:class="$style.noResultsContainer"
						data-test-id="execution-annotation-data-empty"
					>
						<N8nText color="text-base" size="small" align="center">
							<span v-n8n-html="i18n.baseText('executionAnnotationView.data.notFound')" />
						</N8nText>
					</div>
				</div>
			</div>
		</template>
	</ElDropdown>
</template>

<style module lang="scss">
.container {
	max-width: 360px;
	padding: var(--spacing--xs);
}

.section {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.metadata {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
	max-height: 360px;
	overflow-y: auto;
}

.customDataEntry {
	display: flex;
	flex-direction: column;
}

.key {
	font-weight: var(--font-weight--bold);
}

.value {
	word-break: break-word;
}

.noResultsContainer {
	padding: var(--spacing--xs) 0;
}

.highlightDataButton {
	height: 30px;
	width: 30px;
}

.highlightDataButtonActive {
	width: auto;
}

.badge {
	margin-left: var(--spacing--4xs);
}
</style>
