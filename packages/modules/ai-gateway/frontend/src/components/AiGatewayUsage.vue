<script setup lang="ts">
import { useToast } from '@n8n/composables/useToast';
import {
	N8nBadge,
	N8nDataTableServer,
	N8nInput,
	N8nOption,
	N8nSelect,
	N8nText,
	type TableHeader,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, onMounted, ref, watch } from 'vue';

import { useAiGatewayAdminStore } from '../ai-gateway-admin.store';
import type { AiGatewayUsageRow } from '../ai-gateway.api';
import { USAGE_PAGE_SIZES } from '../ai-gateway.constants';
import { formatDateTime, formatUsd } from '../ai-gateway.utils';

const i18n = useI18n();
const toast = useToast();
const store = useAiGatewayAdminStore();

const modelFilter = ref(store.usageFilters.model ?? '');

const headers = computed<Array<TableHeader<AiGatewayUsageRow>>>(() => [
	{
		title: i18n.baseText('settings.forkAiGateway.usage.date'),
		key: 'timestamp',
		disableSort: true,
		minWidth: 170,
	},
	{
		title: i18n.baseText('settings.forkAiGateway.usage.user'),
		key: 'user',
		value: (row) => row.userEmail ?? row.userId ?? '',
		disableSort: true,
		minWidth: 180,
	},
	{
		title: i18n.baseText('settings.forkAiGateway.usage.project'),
		key: 'project',
		value: (row) => row.projectName ?? row.projectId ?? '',
		disableSort: true,
		minWidth: 140,
	},
	{
		title: i18n.baseText('settings.forkAiGateway.usage.provider'),
		key: 'provider',
		disableSort: true,
	},
	{
		title: i18n.baseText('settings.forkAiGateway.usage.model'),
		key: 'model',
		disableSort: true,
		minWidth: 180,
	},
	{
		title: i18n.baseText('settings.forkAiGateway.usage.inputTokens'),
		key: 'inputTokens',
		disableSort: true,
		align: 'end',
	},
	{
		title: i18n.baseText('settings.forkAiGateway.usage.outputTokens'),
		key: 'outputTokens',
		disableSort: true,
		align: 'end',
	},
	{
		title: i18n.baseText('settings.forkAiGateway.usage.cost'),
		key: 'cost',
		disableSort: true,
		align: 'end',
	},
	{
		title: i18n.baseText('settings.forkAiGateway.usage.fromTopUp'),
		key: 'costFromTopUp',
		disableSort: true,
		align: 'end',
	},
]);

async function load() {
	try {
		await store.fetchUsage();
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.forkAiGateway.usage.loadError'));
	}
}

function onProviderChange(value: string) {
	store.setUsageFilters({ ...store.usageFilters, provider: value || undefined });
}

function onProjectChange(value: string) {
	store.setUsageFilters({ ...store.usageFilters, projectId: value || undefined });
}

function onModelChange() {
	const model = modelFilter.value.trim();
	if ((store.usageFilters.model ?? '') === model) return;
	store.setUsageFilters({ ...store.usageFilters, model: model || undefined });
}

watch(
	() => [store.usageFilters, store.usagePage, store.usagePageSize],
	() => {
		void load();
	},
	{ deep: true },
);

onMounted(load);
</script>

<template>
	<div :class="$style.usage" data-test-id="ai-gateway-usage">
		<div :class="$style.filters">
			<N8nSelect
				:model-value="store.usageFilters.provider ?? ''"
				:class="$style.filter"
				size="medium"
				clearable
				:placeholder="i18n.baseText('settings.forkAiGateway.usage.filter.provider')"
				data-test-id="ai-gateway-usage-provider"
				@update:model-value="onProviderChange"
			>
				<N8nOption
					v-for="provider in store.providers"
					:key="provider.slug"
					:value="provider.slug"
					:label="provider.displayName"
				/>
			</N8nSelect>
			<N8nSelect
				:model-value="store.usageFilters.projectId ?? ''"
				:class="$style.filter"
				size="medium"
				filterable
				clearable
				:placeholder="i18n.baseText('settings.forkAiGateway.usage.filter.project')"
				data-test-id="ai-gateway-usage-project"
				@update:model-value="onProjectChange"
			>
				<N8nOption
					v-for="project in store.projects"
					:key="project.id"
					:value="project.id"
					:label="project.name"
				/>
			</N8nSelect>
			<N8nInput
				v-model="modelFilter"
				:class="$style.filter"
				size="medium"
				clearable
				:placeholder="i18n.baseText('settings.forkAiGateway.usage.filter.model')"
				data-test-id="ai-gateway-usage-model"
				@blur="onModelChange"
				@keyup.enter="onModelChange"
				@clear="onModelChange"
			/>
		</div>

		<N8nText
			v-if="!store.loadingUsage && store.usageCount === 0"
			size="small"
			color="text-light"
			data-test-id="ai-gateway-usage-empty"
		>
			{{ i18n.baseText('settings.forkAiGateway.usage.empty') }}
		</N8nText>
		<N8nDataTableServer
			v-else
			v-model:page="store.usagePage"
			v-model:items-per-page="store.usagePageSize"
			:headers="headers"
			:items="store.usage"
			:items-length="store.usageCount"
			:loading="store.loadingUsage"
			:page-sizes="USAGE_PAGE_SIZES"
			data-test-id="ai-gateway-usage-table"
		>
			<template #[`item.timestamp`]="{ item }">
				{{ formatDateTime(item.timestamp) }}
			</template>
			<template #[`item.user`]="{ item }">
				<span :title="item.userId ?? undefined">{{ item.userEmail ?? item.userId ?? '—' }}</span>
			</template>
			<template #[`item.project`]="{ item }">
				<span :title="item.projectId ?? undefined">
					{{ item.projectName ?? item.projectId ?? '—' }}
				</span>
			</template>
			<template #[`item.provider`]="{ item }">
				{{ store.providerName(item.provider) }}
			</template>
			<template #[`item.model`]="{ item }">
				<code>{{ item.model }}</code>
			</template>
			<template #[`item.inputTokens`]="{ item }">
				{{ item.inputTokens ?? '—' }}
			</template>
			<template #[`item.outputTokens`]="{ item }">
				{{ item.outputTokens ?? '—' }}
			</template>
			<template #[`item.cost`]="{ item }">
				{{ formatUsd(item.cost, 6) }}
				<N8nBadge
					v-if="item.estimated"
					variant="warning"
					size="xsmall"
					:title="i18n.baseText('settings.forkAiGateway.usage.estimated.hint')"
					data-test-id="ai-gateway-usage-estimated"
				>
					{{ i18n.baseText('settings.forkAiGateway.usage.estimated') }}
				</N8nBadge>
			</template>
			<template #[`item.costFromTopUp`]="{ item }">
				{{ formatUsd(item.costFromTopUp, 6) }}
			</template>
		</N8nDataTableServer>
	</div>
</template>

<style lang="scss" module>
.usage {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.filters {
	display: flex;
	flex-wrap: wrap;
	gap: var(--spacing--xs);
}

.filter {
	width: 14rem;
}
</style>
