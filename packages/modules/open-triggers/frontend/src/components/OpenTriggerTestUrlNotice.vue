<script lang="ts" setup>
import { openTriggerKindOf } from '@n8n/api-types';
import { useClipboard } from '@n8n/composables/useClipboard';
import { useToast } from '@n8n/composables/useToast';
import { N8nButton, N8nCallout, N8nIconButton, N8nText } from '@n8n/design-system';
import { capabilityRegistry } from '@n8n/frontend-module-sdk';
import { useI18n } from '@n8n/i18n';
import { useSettingsStore } from '@n8n/stores/settings.store';
import type { INode } from 'n8n-workflow';
import { computed, ref, watch } from 'vue';

import { openTriggerActions } from '../open-triggers.capabilities';
import { OPEN_TRIGGERS_MODULE_ID } from '../open-triggers.constants';
import {
	OPEN_TRIGGER_FIX_LABEL_KEYS,
	openTriggerFixFor,
	type OpenTriggerSecret,
} from '../open-triggers.fixes';

/**
 * While a trigger listens for a test event, tells the builder that its test URL refuses calls from
 * outside n8n, and offers the one-click fix. The backend refuses these calls while the publish
 * check of open triggers is on (`OpenTriggerTestCallGuard`).
 */
const props = defineProps<{
	workflowId: string;
	node: Pick<INode, 'id' | 'type' | 'typeVersion' | 'parameters'>;
}>();

const i18n = useI18n();
const toast = useToast();
const clipboard = useClipboard();
const settingsStore = useSettingsStore();

const moduleSettings = computed(() => settingsStore.moduleSettings[OPEN_TRIGGERS_MODULE_ID]);

// The same rule as the backend check, from `@n8n/api-types`.
const isRefused = computed(
	() =>
		moduleSettings.value?.needApproval === true &&
		openTriggerKindOf(props.node, {
			publicChatDisabled: moduleSettings.value.publicChatDisabled,
		}) !== null,
);
const fix = computed(() => openTriggerFixFor(props.node));

const fixed = ref(false);
const secret = ref<OpenTriggerSecret | null>(null);
const applying = ref(false);

// The panel can show another node. The token of a fix is for one node only.
watch(
	() => props.node.id,
	() => {
		fixed.value = false;
		secret.value = null;
	},
);

async function applyFix() {
	if (!fix.value || applying.value) return;
	applying.value = true;
	try {
		const result = await capabilityRegistry
			.use(openTriggerActions)
			.applyFix(props.workflowId, props.node.id, fix.value);
		secret.value = result.secret ?? null;
		fixed.value = true;
	} catch (error) {
		toast.showError(error, i18n.baseText('openTriggers.fixes.error'));
	} finally {
		applying.value = false;
	}
}

async function copySecret() {
	if (!secret.value) return;
	await clipboard.copy(secret.value.value);
	toast.showMessage({ title: i18n.baseText('openTriggers.fixes.copied'), type: 'success' });
}
</script>

<template>
	<div v-if="isRefused || fixed" :class="$style.notice" data-test-id="open-trigger-test-url-notice">
		<N8nCallout v-if="fixed" theme="success" data-test-id="open-trigger-test-url-fixed">
			{{ i18n.baseText('openTriggers.testUrl.fixed') }}
		</N8nCallout>
		<N8nCallout v-else theme="warning" data-test-id="open-trigger-test-url-refused">
			{{ i18n.baseText('openTriggers.testUrl.refused') }}
			<template #trailingContent>
				<N8nButton
					v-if="fix"
					variant="outline"
					size="small"
					:label="i18n.baseText(OPEN_TRIGGER_FIX_LABEL_KEYS[fix])"
					:loading="applying"
					data-test-id="open-trigger-test-url-apply-fix"
					@click="applyFix"
				/>
			</template>
		</N8nCallout>
		<N8nText
			v-if="!fixed && !fix"
			size="small"
			color="text-light"
			data-test-id="open-trigger-no-fix"
		>
			{{ i18n.baseText('openTriggers.fixes.noFix') }}
		</N8nText>
		<div v-if="secret" :class="$style.secret" data-test-id="open-trigger-secret">
			<N8nText size="small">{{ i18n.baseText('openTriggers.fixes.secret') }}</N8nText>
			<div :class="$style.secretValue">
				<code>{{ secret.header }}: {{ secret.value }}</code>
				<N8nIconButton
					icon="copy"
					variant="ghost"
					size="small"
					:aria-label="i18n.baseText('openTriggers.fixes.copy')"
					:title="i18n.baseText('openTriggers.fixes.copy')"
					data-test-id="open-trigger-copy-secret"
					@click="copySecret"
				/>
			</div>
		</div>
	</div>
</template>

<style lang="scss" module>
.notice {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
	width: 100%;
	margin-bottom: var(--spacing--lg);
	text-align: left;
}

.secret {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.secretValue {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);

	code {
		word-break: break-all;
		font-size: var(--font-size--2xs);
	}
}
</style>
