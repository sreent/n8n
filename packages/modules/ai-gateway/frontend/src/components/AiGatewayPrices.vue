<script setup lang="ts">
import type { AiGatewayPrice } from '@n8n/api-types';
import { useToast } from '@n8n/composables/useToast';
import {
	N8nAlertDialog,
	N8nButton,
	N8nDataTableServer,
	N8nIconButton,
	N8nInput,
	N8nInputLabel,
	N8nInputNumber,
	N8nOption,
	N8nSelect,
	N8nSwitch,
	N8nText,
	type TableHeader,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, ref, watch } from 'vue';

import { useAiGatewayAdminStore } from '../ai-gateway-admin.store';
import { FREE_BY_DEFAULT_PROVIDER, TABLE_PAGE_SIZES } from '../ai-gateway.constants';
import { priceRows, withAdminPrice, type AiGatewayPriceRow } from '../ai-gateway.utils';
import { useTablePage } from '../composables/useTablePage';

const i18n = useI18n();
const toast = useToast();
const store = useAiGatewayAdminStore();

const provider = ref('');
const model = ref('');
const input = ref<number | undefined>(undefined);
const cachedInput = ref<number | undefined>(undefined);
const output = ref<number | undefined>(undefined);
const search = ref('');

/** The OCR prices pages and images, not tokens. */
const pricesPages = (slug: string) =>
	store.providers.find((option) => option.slug === slug)?.priceUnit === 'pages';

/** The OCR prices each processor of Document AI as its own model. */
const OCR_PROVIDER = 'google-ocr';

const estimateUsage = computed(() => store.settings?.estimateUsage ?? true);

async function onEstimateUsageChange(value: boolean) {
	try {
		await store.saveSettings({ estimateUsage: value });
		toast.showMessage({ title: i18n.baseText('settings.forkAiGateway.saved'), type: 'success' });
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.forkAiGateway.saveError'));
	}
}

const description = computed(() =>
	i18n.baseText('settings.forkAiGateway.prices.description', {
		interpolate: { date: store.priceTable?.listPricesDate ?? '' },
	}),
);

const rows = computed(() => {
	const table = store.priceTable;
	if (!table) return [];
	const query = search.value.trim().toLowerCase();
	return priceRows(table.listPrices, table.adminPrices).filter(
		(row) =>
			!query ||
			row.model.toLowerCase().includes(query) ||
			store.providerName(row.provider).toLowerCase().includes(query),
	);
});

const { page, itemsPerPage, pageItems } = useTablePage(rows);

watch(search, () => {
	page.value = 0;
});

const rowId = (row: AiGatewayPriceRow) => `${row.provider}/${row.model}`;

const headers = computed<Array<TableHeader<AiGatewayPriceRow>>>(() => [
	{
		title: i18n.baseText('settings.forkAiGateway.prices.provider'),
		key: 'provider',
		disableSort: true,
		minWidth: 160,
	},
	{
		title: i18n.baseText('settings.forkAiGateway.prices.model'),
		key: 'model',
		disableSort: true,
		minWidth: 220,
	},
	{
		title: i18n.baseText('settings.forkAiGateway.prices.input'),
		key: 'input',
		value: (row) => formatPrice(row.price.input),
		disableSort: true,
		align: 'end',
	},
	{
		title: i18n.baseText('settings.forkAiGateway.prices.cachedInput'),
		key: 'cachedInput',
		value: (row) => formatPrice(row.price.cachedInput),
		disableSort: true,
		align: 'end',
	},
	{
		title: i18n.baseText('settings.forkAiGateway.prices.output'),
		key: 'output',
		value: (row) => formatPrice(row.price.output),
		disableSort: true,
		align: 'end',
	},
	{
		title: i18n.baseText('settings.forkAiGateway.prices.source'),
		key: 'source',
		disableSort: true,
	},
	{
		title: '',
		key: 'actions',
		value: () => undefined,
		disableSort: true,
		align: 'end',
		width: 100,
		resize: false,
	},
]);

const valid = computed(
	() =>
		provider.value !== '' &&
		model.value.trim() !== '' &&
		input.value !== undefined &&
		input.value >= 0 &&
		output.value !== undefined &&
		output.value >= 0 &&
		(cachedInput.value === undefined || cachedInput.value >= 0),
);

function edit(row: AiGatewayPriceRow) {
	provider.value = row.provider;
	model.value = row.model;
	input.value = row.price.input;
	cachedInput.value = row.price.cachedInput;
	output.value = row.price.output;
}

async function savePrices(next: Record<string, Record<string, AiGatewayPrice>>) {
	try {
		await store.saveSettings({ prices: next });
		toast.showMessage({ title: i18n.baseText('settings.forkAiGateway.saved'), type: 'success' });
		return true;
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.forkAiGateway.saveError'));
		return false;
	}
}

async function setPrice() {
	if (!valid.value || !store.settings || input.value === undefined || output.value === undefined) {
		return;
	}
	const price: AiGatewayPrice = {
		input: input.value,
		output: output.value,
		...(cachedInput.value !== undefined ? { cachedInput: cachedInput.value } : {}),
	};
	const saved = await savePrices(
		withAdminPrice(store.settings.prices, provider.value, model.value.trim(), price),
	);
	if (saved) {
		model.value = '';
		input.value = undefined;
		cachedInput.value = undefined;
		output.value = undefined;
	}
}

/** The price that waits for a confirmation of its removal. */
const priceToRemove = ref<AiGatewayPriceRow | null>(null);

// Without its price, a model that has no list price is blocked. So the page asks first.
const blocksModel = (row: AiGatewayPriceRow) =>
	!row.listPrice && row.provider !== FREE_BY_DEFAULT_PROVIDER;

async function removePrice(row: AiGatewayPriceRow) {
	if (!store.settings) return;
	await savePrices(withAdminPrice(store.settings.prices, row.provider, row.model, undefined));
}

function onRemoveClick(row: AiGatewayPriceRow) {
	if (blocksModel(row)) {
		priceToRemove.value = row;
		return;
	}
	void removePrice(row);
}

async function confirmRemove() {
	if (!priceToRemove.value) return;
	await removePrice(priceToRemove.value);
	priceToRemove.value = null;
}

function onRemoveDialogOpen(open: boolean) {
	if (!open) priceToRemove.value = null;
}

function formatPrice(value: number | undefined) {
	return value === undefined ? '—' : `$${value}`;
}
</script>

<template>
	<div :class="$style.prices" data-test-id="ai-gateway-prices">
		<N8nText size="small" color="text-light">{{ description }}</N8nText>

		<div :class="$style.estimate">
			<N8nSwitch
				:model-value="estimateUsage"
				:label="i18n.baseText('settings.forkAiGateway.prices.estimate')"
				:disabled="store.saving"
				data-test-id="ai-gateway-estimate-usage"
				@update:model-value="onEstimateUsageChange"
			/>
			<N8nText size="small" color="text-light">
				{{ i18n.baseText('settings.forkAiGateway.prices.estimate.hint') }}
			</N8nText>
		</div>

		<div :class="$style.form">
			<N8nInputLabel
				:label="i18n.baseText('settings.forkAiGateway.prices.provider')"
				:bold="false"
				size="medium"
			>
				<N8nSelect
					v-model="provider"
					:class="$style.provider"
					size="medium"
					data-test-id="ai-gateway-price-provider"
				>
					<N8nOption
						v-for="option in store.providers"
						:key="option.slug"
						:value="option.slug"
						:label="option.displayName"
					/>
				</N8nSelect>
			</N8nInputLabel>
			<N8nInputLabel
				:class="$style.model"
				:label="i18n.baseText('settings.forkAiGateway.prices.model')"
				:bold="false"
				size="medium"
			>
				<N8nInput v-model="model" :maxlength="255" data-test-id="ai-gateway-price-model" />
			</N8nInputLabel>
			<N8nInputLabel
				:label="i18n.baseText('settings.forkAiGateway.prices.input')"
				:bold="false"
				size="medium"
			>
				<N8nInputNumber
					v-model="input"
					:class="$style.amount"
					:min="0"
					data-test-id="ai-gateway-price-input"
				/>
			</N8nInputLabel>
			<N8nInputLabel
				:label="i18n.baseText('settings.forkAiGateway.prices.cachedInput')"
				:bold="false"
				size="medium"
			>
				<N8nInputNumber
					v-model="cachedInput"
					:class="$style.amount"
					:min="0"
					data-test-id="ai-gateway-price-cached-input"
				/>
			</N8nInputLabel>
			<N8nInputLabel
				:label="i18n.baseText('settings.forkAiGateway.prices.output')"
				:bold="false"
				size="medium"
			>
				<N8nInputNumber
					v-model="output"
					:class="$style.amount"
					:min="0"
					data-test-id="ai-gateway-price-output"
				/>
			</N8nInputLabel>
			<N8nButton
				variant="solid"
				size="medium"
				:label="i18n.baseText('settings.forkAiGateway.prices.set')"
				:disabled="!valid"
				:loading="store.saving"
				data-test-id="ai-gateway-price-set"
				@click="setPrice"
			/>
		</div>

		<N8nText
			v-if="provider === OCR_PROVIDER"
			size="small"
			color="text-light"
			data-test-id="ai-gateway-price-document-ai"
		>
			{{ i18n.baseText('settings.forkAiGateway.prices.documentAi') }}
		</N8nText>

		<N8nInput
			v-model="search"
			:class="$style.search"
			size="medium"
			clearable
			:placeholder="i18n.baseText('settings.forkAiGateway.prices.search')"
			data-test-id="ai-gateway-price-search"
		/>

		<N8nText v-if="rows.length === 0" size="small" color="text-light">
			{{ i18n.baseText('settings.forkAiGateway.prices.empty') }}
		</N8nText>
		<N8nDataTableServer
			v-else
			v-model:page="page"
			v-model:items-per-page="itemsPerPage"
			:headers="headers"
			:items="pageItems"
			:items-length="rows.length"
			:page-sizes="TABLE_PAGE_SIZES"
			:item-value="rowId"
			data-test-id="ai-gateway-price-list"
		>
			<template #[`item.provider`]="{ item }">
				<div :data-test-id="`ai-gateway-price-${item.provider}-${item.model}`">
					<div>{{ store.providerName(item.provider) }}</div>
					<N8nText v-if="pricesPages(item.provider)" size="xsmall" color="text-light">
						{{ i18n.baseText('settings.forkAiGateway.prices.perMillionPages') }}
					</N8nText>
				</div>
			</template>
			<template #[`item.model`]="{ item }">
				<code>{{ item.model }}</code>
			</template>
			<template #[`item.source`]="{ item }">
				{{
					item.source === 'admin'
						? i18n.baseText('settings.forkAiGateway.prices.source.admin')
						: i18n.baseText('settings.forkAiGateway.prices.source.list')
				}}
			</template>
			<template #[`item.actions`]="{ item }">
				<div :class="$style.rowActions">
					<N8nIconButton
						icon="pencil"
						variant="ghost"
						size="small"
						:aria-label="i18n.baseText('settings.forkAiGateway.prices.edit')"
						:title="i18n.baseText('settings.forkAiGateway.prices.edit')"
						@click="edit(item)"
					/>
					<N8nIconButton
						v-if="item.source === 'admin'"
						icon="trash-2"
						variant="ghost"
						size="small"
						:aria-label="i18n.baseText('settings.forkAiGateway.prices.remove')"
						:title="i18n.baseText('settings.forkAiGateway.prices.remove')"
						@click="onRemoveClick(item)"
					/>
				</div>
			</template>
		</N8nDataTableServer>

		<N8nAlertDialog
			:open="priceToRemove !== null"
			:title="i18n.baseText('settings.forkAiGateway.prices.removeConfirmTitle')"
			:description="
				i18n.baseText('settings.forkAiGateway.prices.removeConfirmDescription', {
					interpolate: { model: priceToRemove?.model ?? '' },
				})
			"
			:action-label="i18n.baseText('settings.forkAiGateway.prices.removeConfirm')"
			:cancel-label="i18n.baseText('generic.cancel')"
			action-variant="destructive"
			:loading="store.saving"
			size="medium"
			@action="confirmRemove"
			@update:open="onRemoveDialogOpen"
		/>
	</div>
</template>

<style lang="scss" module>
.prices {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.estimate {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.form {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	gap: var(--spacing--sm);
}

.provider {
	width: 12rem;
}

.model {
	flex: 1;
	min-width: 14rem;
}

.amount {
	width: 8rem;
}

.search {
	max-width: 20rem;
}

.rowActions {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--4xs);
}
</style>
