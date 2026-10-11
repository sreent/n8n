<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the logo of a provider type. It uses the logos of the settings
 * page of external secrets. `../FORK.md` describes it.
 */
import type { SecretProviderTypeResponse } from '@n8n/api-types';
import type { Component } from 'vue';
import { computed } from 'vue';

import AwsSecretsManagerLogo from '@/features/integrations/externalSecrets/assets/images/aws-secrets-manager.svg?component';
import AzureKeyVaultLogo from '@/features/integrations/externalSecrets/assets/images/azure-key-vault.svg?component';
import GcpSecretsManagerLogo from '@/features/integrations/externalSecrets/assets/images/gcp-secrets-manager.svg?component';
import hashicorpLogoUrl from '@/features/integrations/externalSecrets/assets/images/hashicorp.svg?no-inline';
import infisicalLogoUrl from '@/features/integrations/externalSecrets/assets/images/infisical.svg?no-inline';
import OnePasswordLogo from '@/features/integrations/externalSecrets/assets/images/one-password.svg?component';

const props = defineProps<{
	provider: Pick<SecretProviderTypeResponse, 'type' | 'displayName'>;
}>();

/** Logos in the page as SVG elements. */
const INLINE_LOGOS: Record<string, Component> = {
	awsSecretsManager: AwsSecretsManagerLogo,
	azureKeyVault: AzureKeyVaultLogo,
	gcpSecretsManager: GcpSecretsManagerLogo,
	onePassword: OnePasswordLogo,
};

/** Logos as images, with the name of the provider type as the alternative text. */
const IMAGE_LOGOS: Record<string, string> = {
	vault: hashicorpLogoUrl,
	infisical: infisicalLogoUrl,
};

const inlineLogo = computed(() => INLINE_LOGOS[props.provider.type]);
const imageLogo = computed(() => IMAGE_LOGOS[props.provider.type]);
</script>

<template>
	<component :is="inlineLogo" v-if="inlineLogo" :class="$style.logo" />
	<img v-else :src="imageLogo" :alt="provider.displayName" :class="$style.logo" />
</template>

<style lang="scss" module>
.logo {
	width: var(--spacing--lg);
	height: var(--spacing--lg);
	object-fit: contain;
}
</style>
