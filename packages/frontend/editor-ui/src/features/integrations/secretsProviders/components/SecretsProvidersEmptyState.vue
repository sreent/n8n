<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the settings page of the connections without connections.
 * `../FORK.md` describes it.
 */
import type { SecretProviderTypeResponse } from '@n8n/api-types';
import { N8nButton, N8nEmptyState, N8nHeading, N8nIcon } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';

import SecretsProviderImage from './SecretsProviderImage.vue';

defineProps<{
	providerTypes: SecretProviderTypeResponse[];
	canCreate: boolean;
}>();

const emit = defineEmits<{
	addSecretsStore: [];
}>();

const i18n = useI18n();
</script>

<template>
	<N8nEmptyState description="yes" data-test-id="secrets-provider-connections-empty-state">
		<template #description>
			<div :class="$style.iconCards">
				<div :class="$style.iconCard">
					<SecretsProviderImage v-if="providerTypes[0]" :provider="providerTypes[0]" />
				</div>
				<div :class="$style.iconCard"><N8nIcon icon="vault" /></div>
				<div :class="$style.iconCard">
					<SecretsProviderImage v-if="providerTypes[2]" :provider="providerTypes[2]" />
				</div>
			</div>
			<N8nHeading tag="h2" size="medium" align="center" class="mb-2xs">
				{{ i18n.baseText('settings.secretsProviderConnections.emptyState.heading') }}
			</N8nHeading>
			<div>{{ i18n.baseText('settings.secretsProviderConnections.emptyState.description') }}</div>
		</template>
		<template #additionalContent>
			<N8nButton
				variant="ghost"
				class="mr-2xs"
				element="a"
				:href="i18n.baseText('settings.externalSecrets.docs')"
				target="_blank"
				data-test-id="secrets-provider-connections-learn-more"
			>
				{{ i18n.baseText('generic.learnMore') }} <N8nIcon icon="arrow-up-right" />
			</N8nButton>
			<N8nButton v-if="canCreate" variant="solid" @click="emit('addSecretsStore')">
				{{ i18n.baseText('settings.secretsProviderConnections.buttons.addSecretsStore') }}
			</N8nButton>
		</template>
	</N8nEmptyState>
</template>

<style lang="scss" module>
.iconCards {
	display: flex;
	justify-content: center;
	align-items: center;
	margin-bottom: var(--spacing--lg);
}

.iconCard {
	display: flex;
	justify-content: center;
	align-items: center;
	width: var(--spacing--2xl);
	height: var(--spacing--2xl);
	border: var(--border);
	border-radius: var(--radius);
	background: var(--color--background--light-2);
	box-shadow: var(--shadow--dark);

	&:nth-child(1) {
		transform: rotate(-8deg);
	}

	&:nth-child(2) {
		z-index: 1;
		margin-top: calc(-1 * var(--spacing--4xs));
	}

	&:nth-child(3) {
		transform: rotate(8deg);
	}
}
</style>
