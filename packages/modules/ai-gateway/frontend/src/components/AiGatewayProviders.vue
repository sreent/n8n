<script setup lang="ts">
import { useToast } from '@n8n/composables/useToast';
import { N8nButton, N8nOption, N8nSelect, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, ref, watch } from 'vue';

import { useAiGatewayAdminStore } from '../ai-gateway-admin.store';

const i18n = useI18n();
const toast = useToast();
const store = useAiGatewayAdminStore();

/** The credential id of each provider, by provider slug. An empty id is no credential. */
const selection = ref<Record<string, string>>({});

function reset() {
	selection.value = Object.fromEntries(
		store.providers.map((provider) => [provider.slug, provider.credential?.id ?? '']),
	);
}

watch(() => store.providers, reset, { immediate: true });

const changed = computed(() =>
	store.providers.some(
		(provider) => (selection.value[provider.slug] ?? '') !== (provider.credential?.id ?? ''),
	),
);

async function save() {
	const providers: Record<string, { credentialId: string }> = {};
	for (const [slug, credentialId] of Object.entries(selection.value)) {
		if (credentialId) providers[slug] = { credentialId };
	}
	try {
		await store.saveSettings({ providers });
		toast.showMessage({ title: i18n.baseText('settings.forkAiGateway.saved'), type: 'success' });
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.forkAiGateway.saveError'));
	}
}
</script>

<template>
	<div :class="$style.providers" data-test-id="ai-gateway-providers">
		<N8nText size="small" color="text-light">
			{{ i18n.baseText('settings.forkAiGateway.providers.description') }}
		</N8nText>
		<table :class="$style.table">
			<thead>
				<tr>
					<th>{{ i18n.baseText('settings.forkAiGateway.providers.provider') }}</th>
					<th>{{ i18n.baseText('settings.forkAiGateway.providers.credential') }}</th>
				</tr>
			</thead>
			<tbody>
				<tr
					v-for="provider in store.providers"
					:key="provider.slug"
					:data-test-id="`ai-gateway-provider-${provider.slug}`"
				>
					<td>
						<div>{{ provider.displayName }}</div>
						<code :class="$style.type">{{ provider.credentialType }}</code>
					</td>
					<td>
						<N8nSelect
							v-if="provider.credentialOptions.length > 0"
							v-model="selection[provider.slug]"
							:class="$style.select"
							size="medium"
							clearable
							:placeholder="i18n.baseText('settings.forkAiGateway.providers.none')"
							:data-test-id="`ai-gateway-provider-credential-${provider.slug}`"
						>
							<N8nOption
								v-for="option in provider.credentialOptions"
								:key="option.id"
								:value="option.id"
								:label="option.name"
							/>
						</N8nSelect>
						<N8nText v-else size="small" color="text-light">
							{{
								i18n.baseText('settings.forkAiGateway.providers.noCredentials', {
									interpolate: { type: provider.credentialType },
								})
							}}
						</N8nText>
					</td>
				</tr>
			</tbody>
		</table>
		<div :class="$style.actions">
			<N8nButton
				variant="solid"
				size="medium"
				:label="i18n.baseText('settings.forkAiGateway.save')"
				:disabled="!changed"
				:loading="store.saving"
				data-test-id="ai-gateway-providers-save"
				@click="save"
			/>
		</div>
	</div>
</template>

<style lang="scss" module>
.providers {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.table {
	width: 100%;
	border-collapse: collapse;

	th,
	td {
		padding: var(--spacing--2xs) var(--spacing--xs);
		border-bottom: var(--border);
		text-align: left;
		vertical-align: middle;
		font-size: var(--font-size--sm);
	}

	th {
		color: var(--color--text--tint-1);
		font-weight: var(--font-weight--bold);
	}
}

.type {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.select {
	width: 100%;
	max-width: 24rem;
}

.actions {
	display: flex;
	justify-content: flex-end;
}
</style>
