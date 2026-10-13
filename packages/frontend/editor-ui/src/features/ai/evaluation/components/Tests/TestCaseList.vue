<script setup lang="ts">
// Fork code (not in upstream n8n): the new case view of the Tests panel: a case from a recent
// execution, or a case from scratch. See `../../FORK.md`.
import { N8nButton, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';

import ExecutionRow from './ExecutionRow.vue';
import { injectTestsPanel } from './testsPanel.context';

const i18n = useI18n();
const panel = injectTestsPanel();
</script>

<template>
	<div :class="$style.list" data-test-id="tests-list">
		<div :class="$style.breadcrumb">
			<button
				type="button"
				:class="$style.root"
				data-test-id="tests-list-breadcrumb-root"
				@click="panel.openList()"
			>
				<N8nText size="small" color="text-base">{{ i18n.baseText('generic.tests') }}</N8nText>
			</button>
			<N8nText size="small" color="text-light">/</N8nText>
			<N8nText size="small" color="text-dark" bold>{{
				i18n.baseText('evaluations.tests.newCase.title')
			}}</N8nText>
		</div>
		<N8nText size="small" color="text-base">{{
			i18n.baseText('evaluations.tests.chooseExecution')
		}}</N8nText>
		<div v-if="panel.executions.value.length" data-test-id="tests-list-executions">
			<ExecutionRow
				v-for="execution in panel.executions.value"
				:key="execution.id"
				:execution="execution"
			/>
		</div>
		<N8nText v-else size="small" color="text-light">{{
			i18n.baseText('evaluations.tests.executions.empty')
		}}</N8nText>
		<N8nText size="small" color="text-base">{{
			i18n.baseText('evaluations.tests.createManually.hint')
		}}</N8nText>
		<div>
			<N8nButton
				type="secondary"
				size="small"
				data-test-id="tests-list-create-manual"
				@click="panel.createManually()"
				>{{ i18n.baseText('evaluations.tests.createManually') }}</N8nButton
			>
		</div>
	</div>
</template>

<style module lang="scss">
.list {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--xs);
}

.breadcrumb {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
}

.root {
	border: none;
	background: none;
	padding: 0;
	cursor: pointer;
}
</style>
