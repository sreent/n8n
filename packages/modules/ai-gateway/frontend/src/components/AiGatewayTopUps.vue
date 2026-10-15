<script setup lang="ts">
import { useToast } from '@n8n/composables/useToast';
import { N8nButton, N8nInput, N8nInputLabel, N8nInputNumber, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, ref } from 'vue';

import { useAiGatewayAdminStore } from '../ai-gateway-admin.store';
import { formatDateTime, formatUsd } from '../ai-gateway.utils';

/** The backend accepts top-ups up to one million dollars. */
const MAX_TOP_UP = 1_000_000;

const i18n = useI18n();
const toast = useToast();
const store = useAiGatewayAdminStore();

const amount = ref<number | undefined>(undefined);
const note = ref('');
const adding = ref(false);

const valid = computed(
	() => amount.value !== undefined && amount.value > 0 && amount.value <= MAX_TOP_UP,
);

async function add() {
	if (!valid.value || amount.value === undefined) return;
	adding.value = true;
	try {
		await store.addTopUp(amount.value, note.value);
		amount.value = undefined;
		note.value = '';
		toast.showMessage({
			title: i18n.baseText('settings.forkAiGateway.topUps.added'),
			type: 'success',
		});
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.forkAiGateway.topUps.addError'));
	} finally {
		adding.value = false;
	}
}
</script>

<template>
	<div :class="$style.topUps" data-test-id="ai-gateway-top-ups">
		<N8nText size="small" color="text-light">
			{{ i18n.baseText('settings.forkAiGateway.topUps.description') }}
		</N8nText>
		<div :class="$style.form">
			<N8nInputLabel
				:label="i18n.baseText('settings.forkAiGateway.topUps.amount')"
				:bold="false"
				size="medium"
			>
				<N8nInputNumber
					v-model="amount"
					:class="$style.amount"
					:min="0"
					:max="MAX_TOP_UP"
					:precision="2"
					data-test-id="ai-gateway-top-up-amount"
				/>
			</N8nInputLabel>
			<N8nInputLabel
				:class="$style.note"
				:label="i18n.baseText('settings.forkAiGateway.topUps.note')"
				:bold="false"
				size="medium"
			>
				<N8nInput v-model="note" :maxlength="255" data-test-id="ai-gateway-top-up-note" />
			</N8nInputLabel>
			<N8nButton
				variant="solid"
				size="medium"
				icon="hand-coins"
				:label="i18n.baseText('settings.forkAiGateway.topUps.add')"
				:disabled="!valid"
				:loading="adding"
				data-test-id="ai-gateway-top-up-add"
				@click="add"
			/>
		</div>

		<N8nText v-if="store.topUps.length === 0" size="small" color="text-light">
			{{ i18n.baseText('settings.forkAiGateway.topUps.empty') }}
		</N8nText>
		<table v-else :class="$style.table" data-test-id="ai-gateway-top-up-list">
			<thead>
				<tr>
					<th>{{ i18n.baseText('settings.forkAiGateway.topUps.date') }}</th>
					<th>{{ i18n.baseText('settings.forkAiGateway.topUps.amount') }}</th>
					<th>{{ i18n.baseText('settings.forkAiGateway.topUps.by') }}</th>
					<th>{{ i18n.baseText('settings.forkAiGateway.topUps.note') }}</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="topUp in store.topUps" :key="topUp.id">
					<td>{{ formatDateTime(topUp.createdAt) }}</td>
					<td>{{ formatUsd(topUp.amount) }}</td>
					<td>{{ topUp.createdByEmail ?? topUp.createdById ?? '—' }}</td>
					<td>{{ topUp.note ?? '' }}</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>

<style lang="scss" module>
.topUps {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.form {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	gap: var(--spacing--sm);
}

.amount {
	width: 12rem;
}

.note {
	flex: 1;
	min-width: 16rem;
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
