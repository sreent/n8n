<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the logo of a provider type. The logos and their sources are in
 * `../assets/images/README.md`. `../FORK.md` describes the component.
 */
import type { ExternalSecretsProvider } from '@n8n/api-types';
import type { Component } from 'vue';
import { computed } from 'vue';

import AwsSecretsManagerLogo from '../assets/images/aws-secrets-manager.svg?component';
import AzureKeyVaultLogo from '../assets/images/azure-key-vault.svg?component';
import GcpSecretsManagerLogo from '../assets/images/gcp-secrets-manager.svg?component';
import hashicorpLogoUrl from '../assets/images/hashicorp.svg?no-inline';
import infisicalLogoUrl from '../assets/images/infisical.svg?no-inline';
import OnePasswordLogo from '../assets/images/one-password.svg?component';

const props = defineProps<{
	provider: Pick<ExternalSecretsProvider, 'name' | 'displayName'>;
}>();

/** Logos in the page as SVG elements. */
const INLINE_LOGOS: Record<string, Component> = {
	onePassword: OnePasswordLogo,
	awsSecretsManager: AwsSecretsManagerLogo,
	azureKeyVault: AzureKeyVaultLogo,
	gcpSecretsManager: GcpSecretsManagerLogo,
};

/**
 * Logos as images, with the name of the provider type as the alternative text. The files keep their
 * URLs: the build does not inline them.
 */
const IMAGE_LOGOS: Record<string, string> = {
	vault: hashicorpLogoUrl,
	infisical: infisicalLogoUrl,
};

const inlineLogo = computed(() => INLINE_LOGOS[props.provider.name]);
const imageLogo = computed(() => IMAGE_LOGOS[props.provider.name]);
</script>

<template>
	<component :is="inlineLogo" v-if="inlineLogo" :class="$style.logo" />
	<!-- As in the enterprise component: a provider type without a logo gets an image without a source. -->
	<img v-else :src="imageLogo" :alt="provider.displayName" :class="$style.logo" />
</template>

<style lang="scss" module>
.logo {
	width: var(--spacing--xl);
	height: var(--spacing--xl);
	object-fit: contain;
}
</style>
