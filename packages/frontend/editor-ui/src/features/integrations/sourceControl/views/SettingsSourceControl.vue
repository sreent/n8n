<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the settings page "Environments". The fork has no source control
 * backend, so the page shows only the box of an instance without the licence feature, as the
 * original did. Git sync replaces source control. `../FORK.md` describes it.
 */
import { N8nEmptyState, N8nHeading } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { onMounted } from 'vue';

import { useDocumentTitle } from '@/app/composables/useDocumentTitle';
import { usePageRedirectionHelper } from '@/app/composables/usePageRedirectionHelper';

const i18n = useI18n();
const documentTitle = useDocumentTitle();
const pageRedirectionHelper = usePageRedirectionHelper();

const DOCS_URL = 'https://docs.n8n.io/source-control-environments/';

function goToUpgrade() {
	void pageRedirectionHelper.goToUpgrade('source-control', 'upgrade-source-control');
}

onMounted(() => {
	documentTitle.set(i18n.baseText('settings.sourceControl.title'));
});
</script>

<template>
	<div :class="$style.container">
		<N8nHeading size="2xlarge">{{ i18n.baseText('settings.sourceControl.title') }}</N8nHeading>
		<N8nEmptyState
			data-test-id="source-control-content-unlicensed"
			:description="i18n.baseText('settings.sourceControl.actionBox.description')"
			:button-text="i18n.baseText('settings.sourceControl.actionBox.buttonText')"
			@click:button="goToUpgrade"
		>
			<template #heading>
				<span>{{ i18n.baseText('settings.sourceControl.actionBox.title') }}</span>
			</template>
			<template #description>
				{{ i18n.baseText('settings.sourceControl.actionBox.description') }}
				<a :href="DOCS_URL" target="_blank">
					{{ i18n.baseText('settings.sourceControl.actionBox.description.link') }}
				</a>
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
</style>
