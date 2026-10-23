<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the settings page of external secrets with one connection for
 * each provider type. The router shows it when the module settings turn off multiple connections
 * and project connections. `../FORK.md` describes it.
 */
import { N8nCallout, N8nEmptyState, N8nHeading } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, onMounted } from 'vue';

import { useDocumentTitle } from '@/app/composables/useDocumentTitle';
import { hasPermission } from '@/app/utils/rbac/permissions';

import ExternalSecretsProviderCard from '../components/ExternalSecretsProviderCard.vue';
import { useExternalSecretsStore } from '../externalSecrets.store';

const externalSecretsStore = useExternalSecretsStore();
const documentTitle = useDocumentTitle();
const i18n = useI18n();

/** The cards in reverse order of the provider name, as on the enterprise page. */
const sortedProviders = computed(() =>
	[...externalSecretsStore.providers].sort((a, b) => b.name.localeCompare(a.name)),
);

async function loadProviders() {
	try {
		await externalSecretsStore.getProviders();
	} catch {
		// As on the enterprise page: without the providers, the page shows no cards and no message.
		return;
	}
	for (const provider of externalSecretsStore.providers) {
		externalSecretsStore.setConnectionState(provider.name, provider.state);
	}
}

onMounted(async () => {
	documentTitle.set(i18n.baseText('settings.externalSecrets.title'));
	if (!externalSecretsStore.isEnterpriseExternalSecretsEnabled) return;

	// As on the enterprise page, the request for the secret names starts first. Both requests run at
	// the same time.
	const loads: Array<Promise<void>> = [];
	if (hasPermission(['rbac'], { rbac: { scope: 'externalSecret:list' } })) {
		loads.push(externalSecretsStore.fetchGlobalSecrets());
	}
	loads.push(loadProviders());
	await Promise.all(loads);
});
</script>

<template>
	<div :class="$style.container">
		<N8nHeading size="2xlarge">{{ i18n.baseText('settings.externalSecrets.title') }}</N8nHeading>
		<div
			v-if="externalSecretsStore.isEnterpriseExternalSecretsEnabled"
			:class="$style.content"
			data-test-id="external-secrets-content-licensed"
		>
			<N8nCallout theme="secondary">
				{{ i18n.baseText('settings.externalSecrets.info') }}
				<a :href="i18n.baseText('settings.externalSecrets.docs')" target="_blank">
					{{ i18n.baseText('settings.externalSecrets.info.link') }}
				</a>
			</N8nCallout>
			<ExternalSecretsProviderCard
				v-for="provider in sortedProviders"
				:key="provider.name"
				:provider="provider"
			/>
		</div>
		<!-- As on the enterprise page, the button opens nothing. While the fork switch is on, the licence has external secrets, so the box does not show. -->
		<N8nEmptyState
			v-else
			data-test-id="external-secrets-content-unlicensed"
			:button-text="i18n.baseText('settings.externalSecrets.actionBox.buttonText')"
		>
			<template #heading>
				<span>{{ i18n.baseText('settings.externalSecrets.actionBox.title') }}</span>
			</template>
		</N8nEmptyState>
	</div>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--lg);
	padding-bottom: var(--spacing--2xl);
}

.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}
</style>
