<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the message of the toast that the editor shows when it cannot
 * load the source control preferences at start-up (only with the licence feature). The link names
 * the Git configuration, as in the original, and opens nothing. `../FORK.md` describes it.
 */
import { useI18n } from '@n8n/i18n';
import { I18nT } from 'vue-i18n';

const i18n = useI18n();
</script>

<template>
	<div>
		<I18nT keypath="settings.sourceControl.connection.error.message" tag="span" scope="global">
			<template #link>
				<a>{{ i18n.baseText('settings.sourceControl.connection.error.link') }}</a>
			</template>
		</I18nT>
	</div>
</template>
