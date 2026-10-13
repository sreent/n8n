<script setup lang="ts">
// Fork code (not in upstream n8n): the popover that sets how many test cases a new run runs at
// the same time. See `../../FORK.md`.
import { N8nButton, N8nPopover } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { ElSlider } from 'element-plus';
import { computed } from 'vue';

import { useParallelEvalStore } from '../../parallelEval.store';

const props = defineProps<{ workflowId: string }>();

const i18n = useI18n();
const parallelEvalStore = useParallelEvalStore();

const concurrency = computed({
	get: () => parallelEvalStore.concurrencyValue(props.workflowId),
	set: (value: number) => parallelEvalStore.setConcurrencyValue(props.workflowId, value),
});

/** To open the controls is to run the cases of the workflow in parallel. */
function onOpen(open: boolean) {
	if (open) parallelEvalStore.setParallel(props.workflowId, true);
}
</script>

<template>
	<N8nPopover
		:teleported="false"
		:enable-scrolling="false"
		align="end"
		width="320px"
		@update:open="onOpen"
	>
		<template #trigger>
			<N8nButton
				data-test-id="parallel-eval-toggle"
				variant="subtle"
				icon="chevron-down"
				icon-only
				:aria-label="i18n.baseText('evaluation.runInParallel.popover.ariaLabel')"
			/>
		</template>
		<template #content>
			<div :class="$style.controls" data-test-id="parallel-eval-controls">
				<div :class="$style.heading">
					<span :class="$style.title">{{
						i18n.baseText('evaluation.runInParallel.popover.title')
					}}</span>
					<span :class="$style.pill" data-test-id="run-in-parallel-mode-label">{{
						i18n.baseText('evaluation.runInParallel.popover.valuePill', {
							interpolate: { count: concurrency, max: parallelEvalStore.maxConcurrency },
						})
					}}</span>
				</div>
				<ElSlider
					v-model="concurrency"
					data-test-id="run-in-parallel-concurrency"
					:min="1"
					:max="parallelEvalStore.maxConcurrency"
					:step="1"
					show-stops
				/>
				<div :class="$style.scale">
					<span>{{ i18n.baseText('evaluation.runInParallel.popover.scaleSequential') }}</span>
					<span>{{ i18n.baseText('evaluation.runInParallel.popover.scaleFaster') }}</span>
				</div>
				<p :class="$style.helper">
					{{ i18n.baseText('evaluation.runInParallel.popover.helper') }}
				</p>
			</div>
		</template>
	</N8nPopover>
</template>

<style module lang="scss">
.controls {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
	padding: var(--spacing--sm);
}

.heading {
	display: flex;
	align-items: center;
	justify-content: space-between;
}

.title {
	font-weight: var(--font-weight--bold);
	font-size: var(--font-size--sm);
}

.pill {
	padding: var(--spacing--5xs) var(--spacing--2xs);
	border-radius: var(--radius--full);
	background-color: var(--color--background--shade-1);
	font-size: var(--font-size--2xs);
}

.scale {
	display: flex;
	justify-content: space-between;
	font-size: var(--font-size--3xs);
	color: var(--color--text--tint-1);
}

.helper {
	margin: 0;
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}
</style>
