<script setup lang="ts">
import { useToast } from '@n8n/composables/useToast';
import {
	N8nAlertDialog,
	N8nButton,
	N8nDataTableServer,
	N8nInput,
	N8nInputLabel,
	N8nInputNumber,
	N8nText,
	type TableHeader,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, ref } from 'vue';

import { useAiGatewayAdminStore } from '../ai-gateway-admin.store';
import type { AiGatewayTopUp } from '../ai-gateway.api';
import { TABLE_PAGE_SIZES } from '../ai-gateway.constants';
import { formatDateTime, formatUsd } from '../ai-gateway.utils';
import { useTablePage } from '../composables/useTablePage';

/** The backend accepts top-ups up to one million dollars. */
const MAX_TOP_UP = 1_000_000;

const i18n = useI18n();
const toast = useToast();
const store = useAiGatewayAdminStore();

const amount = ref<number | undefined>(undefined);
const note = ref('');
const adding = ref(false);
const showConfirm = ref(false);
/** The amount that the confirmation shows. It stays while the dialog closes. */
const confirmAmount = ref('');

const valid = computed(
	() => amount.value !== undefined && amount.value > 0 && amount.value <= MAX_TOP_UP,
);

const { page, itemsPerPage, pageItems } = useTablePage(() => store.topUps);

const headers = computed<Array<TableHeader<AiGatewayTopUp>>>(() => [
	{
		title: i18n.baseText('settings.forkAiGateway.topUps.date'),
		key: 'createdAt',
		disableSort: true,
		minWidth: 170,
	},
	{
		title: i18n.baseText('settings.forkAiGateway.topUps.amount'),
		key: 'amount',
		disableSort: true,
		align: 'end',
	},
	{
		title: i18n.baseText('settings.forkAiGateway.topUps.by'),
		key: 'createdBy',
		value: (row) => row.createdByEmail ?? row.createdById ?? '—',
		disableSort: true,
		minWidth: 180,
	},
	{
		title: i18n.baseText('settings.forkAiGateway.topUps.note'),
		key: 'note',
		disableSort: true,
		minWidth: 200,
	},
]);

// A top-up stays on the balance: the backend has no way to remove one. So the page asks first.
function confirmAdd() {
	if (!valid.value || amount.value === undefined) return;
	confirmAmount.value = formatUsd(amount.value);
	showConfirm.value = true;
}

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
		showConfirm.value = false;
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
				@click="confirmAdd"
			/>
		</div>

		<N8nText v-if="store.topUps.length === 0" size="small" color="text-light">
			{{ i18n.baseText('settings.forkAiGateway.topUps.empty') }}
		</N8nText>
		<N8nDataTableServer
			v-else
			v-model:page="page"
			v-model:items-per-page="itemsPerPage"
			:headers="headers"
			:items="pageItems"
			:items-length="store.topUps.length"
			:page-sizes="TABLE_PAGE_SIZES"
			data-test-id="ai-gateway-top-up-list"
		>
			<template #[`item.createdAt`]="{ item }">
				{{ formatDateTime(item.createdAt) }}
			</template>
			<template #[`item.amount`]="{ item }">
				{{ formatUsd(item.amount) }}
			</template>
			<template #[`item.note`]="{ item }">
				{{ item.note ?? '' }}
			</template>
		</N8nDataTableServer>

		<N8nAlertDialog
			:open="showConfirm"
			:title="
				i18n.baseText('settings.forkAiGateway.topUps.confirmTitle', {
					interpolate: { amount: confirmAmount },
				})
			"
			:description="i18n.baseText('settings.forkAiGateway.topUps.confirmDescription')"
			:action-label="i18n.baseText('settings.forkAiGateway.topUps.add')"
			:cancel-label="i18n.baseText('generic.cancel')"
			:loading="adding"
			size="medium"
			@action="add"
			@update:open="showConfirm = $event"
		/>
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
</style>
