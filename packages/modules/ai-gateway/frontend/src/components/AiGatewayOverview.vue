<script setup lang="ts">
import { N8nHeading, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

import type { AiGatewayOverview } from '../ai-gateway.api';
import { formatUsd, formatUtcDay } from '../ai-gateway.utils';

const props = defineProps<{ overview: AiGatewayOverview }>();

const i18n = useI18n();

const period = computed(() =>
	i18n.baseText('settings.forkAiGateway.overview.period', {
		interpolate: {
			start: formatUtcDay(props.overview.periodStart),
			// The period ends before the first moment of the next month.
			end: formatUtcDay(new Date(props.overview.periodEnd).getTime() - 1),
		},
	}),
);

const cards = computed(() => [
	{
		key: 'monthlyBudget',
		label: i18n.baseText('settings.forkAiGateway.overview.monthlyBudget'),
		value: formatUsd(props.overview.monthlyBudget),
	},
	{
		key: 'spentThisMonth',
		label: i18n.baseText('settings.forkAiGateway.overview.spentThisMonth'),
		value: formatUsd(props.overview.spentThisMonth, 4),
	},
	{
		key: 'budgetLeft',
		label: i18n.baseText('settings.forkAiGateway.overview.budgetLeft'),
		value: formatUsd(props.overview.budgetLeft, 4),
	},
	{
		key: 'topUpBalance',
		label: i18n.baseText('settings.forkAiGateway.overview.topUpBalance'),
		value: formatUsd(props.overview.topUpBalance, 4),
	},
	{
		key: 'remaining',
		label: i18n.baseText('settings.forkAiGateway.overview.remaining'),
		value: formatUsd(props.overview.remaining, 4),
	},
]);

const userLimit = computed(() =>
	props.overview.userMonthlyLimit === null
		? i18n.baseText('settings.forkAiGateway.overview.noUserLimit')
		: i18n.baseText('settings.forkAiGateway.overview.userLimit', {
				interpolate: { amount: formatUsd(props.overview.userMonthlyLimit) },
			}),
);

const projects = computed(() =>
	[...props.overview.projects].sort((a, b) => b.spentThisMonth - a.spentThisMonth),
);
</script>

<template>
	<div :class="$style.overview" data-test-id="ai-gateway-overview">
		<N8nText size="small" color="text-light">{{ period }}</N8nText>
		<div :class="$style.cards">
			<div
				v-for="card in cards"
				:key="card.key"
				:class="$style.card"
				:data-test-id="`ai-gateway-overview-${card.key}`"
			>
				<N8nText size="small" color="text-light">{{ card.label }}</N8nText>
				<N8nHeading size="large" :bold="true">{{ card.value }}</N8nHeading>
			</div>
		</div>
		<N8nText size="small" color="text-light" data-test-id="ai-gateway-overview-user-limit">
			{{ userLimit }}
		</N8nText>

		<N8nHeading size="medium" :bold="true">
			{{ i18n.baseText('settings.forkAiGateway.overview.projects') }}
		</N8nHeading>
		<N8nText v-if="projects.length === 0" size="small" color="text-light">
			{{ i18n.baseText('settings.forkAiGateway.overview.noProjects') }}
		</N8nText>
		<table v-else :class="$style.table" data-test-id="ai-gateway-overview-projects">
			<thead>
				<tr>
					<th>{{ i18n.baseText('settings.forkAiGateway.overview.project') }}</th>
					<th>{{ i18n.baseText('settings.forkAiGateway.overview.projectBudget') }}</th>
					<th>{{ i18n.baseText('settings.forkAiGateway.overview.projectSpent') }}</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="project in projects" :key="project.projectId">
					<td :title="project.projectId">
						{{ project.name ?? i18n.baseText('settings.forkAiGateway.overview.deletedProject') }}
					</td>
					<td>
						{{
							project.monthlyBudget === null
								? i18n.baseText('settings.forkAiGateway.overview.noBudget')
								: formatUsd(project.monthlyBudget)
						}}
					</td>
					<td>{{ formatUsd(project.spentThisMonth, 4) }}</td>
				</tr>
			</tbody>
		</table>
		<N8nText v-if="overview.spentWithoutProject > 0" size="small" color="text-light">
			{{
				i18n.baseText('settings.forkAiGateway.overview.withoutProject', {
					interpolate: { amount: formatUsd(overview.spentWithoutProject, 4) },
				})
			}}
		</N8nText>
	</div>
</template>

<style lang="scss" module>
.overview {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.cards {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
	gap: var(--spacing--sm);
}

.card {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
	padding: var(--spacing--sm);
	border: var(--border);
	border-radius: var(--radius--lg);
	background-color: var(--color--background--light-3);
}

.table {
	width: 100%;
	border-collapse: collapse;

	th,
	td {
		padding: var(--spacing--2xs) var(--spacing--xs);
		border-bottom: var(--border);
		text-align: left;
		font-size: var(--font-size--sm);
	}

	th {
		color: var(--color--text--tint-1);
		font-weight: var(--font-weight--bold);
	}
}
</style>
