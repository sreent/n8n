<script setup lang="ts">
import { useToast } from '@n8n/composables/useToast';
import {
	N8nButton,
	N8nIconButton,
	N8nInputLabel,
	N8nInputNumber,
	N8nOption,
	N8nSelect,
	N8nText,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, ref, watch } from 'vue';

import { useAiGatewayAdminStore } from '../ai-gateway-admin.store';

interface ProjectBudgetRow {
	projectId: string;
	amount: number | undefined;
}

const i18n = useI18n();
const toast = useToast();
const store = useAiGatewayAdminStore();

const monthlyBudget = ref<number | undefined>(0);
const userMonthlyLimit = ref<number | undefined>(undefined);
const projectRows = ref<ProjectBudgetRow[]>([]);

function reset() {
	const settings = store.settings;
	if (!settings) return;
	monthlyBudget.value = settings.monthlyBudget;
	userMonthlyLimit.value = settings.userMonthlyLimit ?? undefined;
	projectRows.value = Object.entries(settings.projectBudgets).map(([projectId, amount]) => ({
		projectId,
		amount,
	}));
}

watch(() => store.settings, reset, { immediate: true });

function projectName(projectId: string) {
	return store.projects.find((project) => project.id === projectId)?.name ?? projectId;
}

/** The team projects, and the projects of the rows that are no longer team projects. */
const projectOptions = computed(() => {
	const options = store.projects.map((project) => ({ id: project.id, name: project.name }));
	for (const row of projectRows.value) {
		if (row.projectId && !options.some((option) => option.id === row.projectId)) {
			options.push({ id: row.projectId, name: projectName(row.projectId) });
		}
	}
	return options;
});

function isTaken(projectId: string, rowIndex: number) {
	return projectRows.value.some((row, index) => index !== rowIndex && row.projectId === projectId);
}

function addRow() {
	projectRows.value.push({ projectId: '', amount: undefined });
}

function removeRow(index: number) {
	projectRows.value.splice(index, 1);
}

const valid = computed(
	() =>
		monthlyBudget.value !== undefined &&
		monthlyBudget.value >= 0 &&
		(userMonthlyLimit.value === undefined || userMonthlyLimit.value >= 0) &&
		projectRows.value.every(
			(row) => !row.projectId || (row.amount !== undefined && row.amount >= 0),
		),
);

async function save() {
	if (!valid.value || monthlyBudget.value === undefined) return;
	const projectBudgets: Record<string, number> = {};
	for (const row of projectRows.value) {
		if (row.projectId && row.amount !== undefined) projectBudgets[row.projectId] = row.amount;
	}
	try {
		await store.saveSettings({
			monthlyBudget: monthlyBudget.value,
			userMonthlyLimit: userMonthlyLimit.value ?? null,
			projectBudgets,
		});
		toast.showMessage({ title: i18n.baseText('settings.forkAiGateway.saved'), type: 'success' });
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.forkAiGateway.saveError'));
	}
}
</script>

<template>
	<div :class="$style.budgets" data-test-id="ai-gateway-budgets">
		<div :class="$style.field">
			<N8nInputLabel
				:label="i18n.baseText('settings.forkAiGateway.budgets.monthlyBudget')"
				:bold="false"
				size="medium"
			>
				<N8nInputNumber
					v-model="monthlyBudget"
					:class="$style.amount"
					:min="0"
					:step="10"
					:precision="2"
					data-test-id="ai-gateway-monthly-budget"
				/>
			</N8nInputLabel>
			<N8nText size="small" color="text-light">
				{{ i18n.baseText('settings.forkAiGateway.budgets.monthlyBudget.hint') }}
			</N8nText>
		</div>

		<div :class="$style.field">
			<N8nInputLabel
				:label="i18n.baseText('settings.forkAiGateway.budgets.userLimit')"
				:bold="false"
				size="medium"
			>
				<N8nInputNumber
					v-model="userMonthlyLimit"
					:class="$style.amount"
					:min="0"
					:step="1"
					:precision="2"
					data-test-id="ai-gateway-user-limit"
				/>
			</N8nInputLabel>
			<N8nText size="small" color="text-light">
				{{ i18n.baseText('settings.forkAiGateway.budgets.userLimit.hint') }}
			</N8nText>
		</div>

		<div :class="$style.field">
			<N8nText size="medium" :bold="true">
				{{ i18n.baseText('settings.forkAiGateway.budgets.projects') }}
			</N8nText>
			<N8nText size="small" color="text-light">
				{{ i18n.baseText('settings.forkAiGateway.budgets.projects.hint') }}
			</N8nText>
			<div
				v-for="(row, index) in projectRows"
				:key="index"
				:class="$style.projectRow"
				:data-test-id="`ai-gateway-project-budget-${index}`"
			>
				<N8nSelect
					v-model="row.projectId"
					:class="$style.project"
					size="medium"
					filterable
					:placeholder="i18n.baseText('settings.forkAiGateway.budgets.project.placeholder')"
				>
					<N8nOption
						v-for="option in projectOptions"
						:key="option.id"
						:value="option.id"
						:label="option.name"
						:disabled="isTaken(option.id, index)"
					/>
				</N8nSelect>
				<N8nInputNumber v-model="row.amount" :class="$style.amount" :min="0" :precision="2" />
				<N8nIconButton
					icon="trash-2"
					variant="ghost"
					size="small"
					:aria-label="i18n.baseText('settings.forkAiGateway.budgets.project.remove')"
					:title="i18n.baseText('settings.forkAiGateway.budgets.project.remove')"
					@click="removeRow(index)"
				/>
			</div>
			<div>
				<N8nButton
					variant="ghost"
					size="small"
					icon="plus"
					:label="i18n.baseText('settings.forkAiGateway.budgets.project.add')"
					data-test-id="ai-gateway-project-budget-add"
					@click="addRow"
				/>
			</div>
		</div>

		<div :class="$style.actions">
			<N8nButton
				variant="solid"
				size="medium"
				:label="i18n.baseText('settings.forkAiGateway.save')"
				:disabled="!valid"
				:loading="store.saving"
				data-test-id="ai-gateway-budgets-save"
				@click="save"
			/>
		</div>
	</div>
</template>

<style lang="scss" module>
.budgets {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--lg);
}

.field {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.amount {
	max-width: 12rem;
}

.projectRow {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
}

.project {
	width: 20rem;
}

.actions {
	display: flex;
	justify-content: flex-end;
}
</style>
