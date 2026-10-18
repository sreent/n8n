<script lang="ts" setup>
import { useClipboard } from '@n8n/composables/useClipboard';
import { useToast } from '@n8n/composables/useToast';
import {
	N8nButton,
	N8nCallout,
	N8nDialog,
	N8nDialogFooter,
	N8nIconButton,
	N8nText,
} from '@n8n/design-system';
import { capabilityRegistry } from '@n8n/frontend-module-sdk';
import { useI18n, type BaseTextKey } from '@n8n/i18n';
import { computed, ref, watch } from 'vue';

import { openTriggerActions, openTriggersModalCloser } from '../open-triggers.capabilities';
import type {
	OpenTriggerFix,
	OpenTriggerFixesModalData,
	OpenTriggerFixItem,
	OpenTriggerSecret,
} from '../open-triggers.fixes';

const props = defineProps<{
	modalName: string;
	open?: boolean;
	data?: OpenTriggerFixesModalData;
}>();

const i18n = useI18n();
const toast = useToast();
const clipboard = useClipboard();

const FIX_LABEL_KEY: Record<OpenTriggerFix, BaseTextKey> = {
	signIn: 'openTriggers.fixes.signIn',
	headerAuth: 'openTriggers.fixes.headerAuth',
	bearerAuth: 'openTriggers.fixes.bearerAuth',
};

/** The nodes that got their fix, and the token of each new credential. */
const fixed = ref<Record<string, OpenTriggerSecret | null>>({});
const applying = ref<string | null>(null);

const workflowId = computed(() => props.data?.workflowId ?? '');
const items = computed(() => props.data?.items ?? []);
const otherMessages = computed(() => props.data?.otherMessages ?? []);
const allFixed = computed(
	() => items.value.length > 0 && items.value.every((item) => item.nodeId in fixed.value),
);

watch(
	() => props.open,
	(isOpen) => {
		if (!isOpen) return;
		fixed.value = {};
		applying.value = null;
	},
	{ immediate: true },
);

const actions = () => capabilityRegistry.use(openTriggerActions);

function close() {
	capabilityRegistry.use(openTriggersModalCloser)(props.modalName);
}

function onOpenChange(isOpen: boolean) {
	if (!isOpen) close();
}

async function applyFix(item: OpenTriggerFixItem) {
	if (!item.fix || applying.value) return;
	applying.value = item.nodeId;
	try {
		const { secret } = await actions().applyFix(workflowId.value, item.nodeId, item.fix);
		fixed.value = { ...fixed.value, [item.nodeId]: secret ?? null };
	} catch (error) {
		toast.showError(error, i18n.baseText('openTriggers.fixes.error'));
	} finally {
		applying.value = null;
	}
}

const secretOf = (nodeId: string): OpenTriggerSecret | null => fixed.value[nodeId] ?? null;

async function copySecret(nodeId: string) {
	const secret = secretOf(nodeId);
	if (!secret) return;
	await clipboard.copy(secret.value);
	toast.showMessage({ title: i18n.baseText('openTriggers.fixes.copied'), type: 'success' });
}

function showNode(item: OpenTriggerFixItem) {
	actions().showNode(workflowId.value, item.nodeId);
	close();
}

function publish() {
	close();
	actions().publish(workflowId.value);
}

function requestApproval() {
	close();
	actions().requestApproval(workflowId.value);
}
</script>

<template>
	<N8nDialog
		:open="open"
		:header="i18n.baseText('openTriggers.fixes.title')"
		:description="
			i18n.baseText(
				data?.canRequestApproval
					? 'openTriggers.fixes.description'
					: 'openTriggers.fixes.descriptionWithoutReviews',
			)
		"
		size="medium"
		@update:open="onOpenChange"
	>
		<!-- N8nDialog renders no element of its own, so the test id goes on the body. -->
		<div :class="$style.body" data-test-id="open-trigger-fixes-modal">
			<ul :class="$style.list">
				<li
					v-for="item in items"
					:key="item.nodeId"
					:class="$style.item"
					data-test-id="open-trigger-fix-item"
				>
					<div :class="$style.row">
						<div :class="$style.text">
							<N8nText bold>{{ item.nodeName }}</N8nText>
							<N8nText size="small" color="text-base">{{ item.message }}</N8nText>
						</div>
						<div :class="$style.actions">
							<N8nText
								v-if="item.nodeId in fixed"
								size="small"
								color="success"
								data-test-id="open-trigger-fixed"
							>
								{{ i18n.baseText('openTriggers.fixes.fixed') }}
							</N8nText>
							<N8nButton
								v-else-if="item.fix"
								variant="outline"
								size="small"
								:label="i18n.baseText(FIX_LABEL_KEY[item.fix])"
								:loading="applying === item.nodeId"
								:disabled="applying !== null"
								data-test-id="open-trigger-apply-fix"
								@click="applyFix(item)"
							/>
							<N8nIconButton
								icon="crosshair"
								variant="ghost"
								size="small"
								:aria-label="i18n.baseText('openTriggers.fixes.showNode')"
								:title="i18n.baseText('openTriggers.fixes.showNode')"
								data-test-id="open-trigger-show-node"
								@click="showNode(item)"
							/>
						</div>
					</div>
					<N8nText
						v-if="!item.fix && !(item.nodeId in fixed)"
						size="small"
						color="text-light"
						data-test-id="open-trigger-no-fix"
					>
						{{ i18n.baseText('openTriggers.fixes.noFix') }}
					</N8nText>
					<div
						v-if="secretOf(item.nodeId)"
						:class="$style.secret"
						data-test-id="open-trigger-secret"
					>
						<N8nCallout theme="warning" slim>
							{{ i18n.baseText('openTriggers.fixes.secret') }}
						</N8nCallout>
						<div :class="$style.secretValue">
							<code>{{ secretOf(item.nodeId)?.header }}: {{ secretOf(item.nodeId)?.value }}</code>
							<N8nIconButton
								icon="copy"
								variant="ghost"
								size="small"
								:aria-label="i18n.baseText('openTriggers.fixes.copy')"
								:title="i18n.baseText('openTriggers.fixes.copy')"
								data-test-id="open-trigger-copy-secret"
								@click="copySecret(item.nodeId)"
							/>
						</div>
					</div>
				</li>
			</ul>

			<div v-if="otherMessages.length" data-test-id="open-trigger-other-violations">
				<N8nText size="small" bold>{{
					i18n.baseText('openTriggers.fixes.otherViolations')
				}}</N8nText>
				<ul :class="$style.messages">
					<li v-for="message in otherMessages" :key="message">
						<N8nText size="small">{{ message }}</N8nText>
					</li>
				</ul>
			</div>
		</div>

		<N8nDialogFooter>
			<N8nButton
				variant="subtle"
				:label="i18n.baseText('openTriggers.fixes.close')"
				data-test-id="open-trigger-close"
				@click="close"
			/>
			<N8nButton
				v-if="data?.canRequestApproval"
				variant="outline"
				:label="i18n.baseText('openTriggers.fixes.requestApproval')"
				data-test-id="open-trigger-request-approval"
				@click="requestApproval"
			/>
			<N8nButton
				variant="solid"
				:label="i18n.baseText('openTriggers.fixes.publish')"
				:disabled="!allFixed || otherMessages.length > 0"
				data-test-id="open-trigger-publish"
				@click="publish"
			/>
		</N8nDialogFooter>
	</N8nDialog>
</template>

<style lang="scss" module>
.body {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.list {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	margin: 0;
	padding: 0;
	list-style: none;
}

.item {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.row {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: var(--spacing--xs);
}

.text {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--5xs);
}

.actions {
	display: flex;
	flex-shrink: 0;
	align-items: center;
	gap: var(--spacing--4xs);
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

.messages {
	margin: var(--spacing--4xs) 0 0;
	padding-left: var(--spacing--sm);
}
</style>
