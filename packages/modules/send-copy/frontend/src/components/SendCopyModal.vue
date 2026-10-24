<script lang="ts" setup>
import {
	SEND_COPY_MAX_RECIPIENTS,
	type CopyRecipient,
	type SendCopyFailureReason,
	type SendCopyResult,
} from '@n8n/api-types';
import { useDebounce } from '@n8n/composables/useDebounce';
import { useToast } from '@n8n/composables/useToast';
import {
	N8nButton,
	N8nCallout,
	N8nDialog,
	N8nDialogFooter,
	N8nIconButton,
	N8nText,
	N8nUserInfo,
	N8nUserSelect,
} from '@n8n/design-system';
import { DEBOUNCE_TIME } from '@n8n/frontend-constants/durations';
import { capabilityRegistry } from '@n8n/frontend-module-sdk';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, ref, useId, watch } from 'vue';

import { getCopyRecipients, sendWorkflowCopy } from '../send-copy.api';
import { sendCopyModalCloser } from '../send-copy.capabilities';
import { SEND_COPY_SEARCH_LIMIT } from '../send-copy.constants';

const props = defineProps<{
	modalName: string;
	open?: boolean;
	data?: { workflowId?: string; workflowName?: string };
}>();

const i18n = useI18n();
const toast = useToast();
const rootStore = useRootStore();
const { debounce } = useDebounce();
const recipientsInputId = useId();

const candidates = ref<CopyRecipient[]>([]);
const selected = ref<CopyRecipient[]>([]);
const isSearching = ref(false);
const isSending = ref(false);
let searchRequestId = 0;

const workflowId = computed(() => props.data?.workflowId ?? '');
const workflowName = computed(() => props.data?.workflowName ?? '');
const selectedIds = computed(() => selected.value.map((user) => user.id));
const limitReached = computed(() => selected.value.length >= SEND_COPY_MAX_RECIPIENTS);

const fullName = (user: CopyRecipient) => [user.firstName, user.lastName].filter(Boolean).join(' ');

const recipientLabel = (user: CopyRecipient) => fullName(user) || user.email;

const candidateUsers = computed(() =>
	candidates.value.map((user) => ({
		id: user.id,
		firstName: user.firstName,
		lastName: user.lastName,
		email: user.email,
		fullName: fullName(user) || undefined,
	})),
);

async function search(query: string) {
	const requestId = ++searchRequestId;
	isSearching.value = true;
	try {
		const result = await getCopyRecipients(rootStore.restApiContext, {
			search: query.trim() || undefined,
			limit: SEND_COPY_SEARCH_LIMIT,
		});
		// A slow response must not replace the result of a newer search.
		if (requestId === searchRequestId) candidates.value = result;
	} catch (error) {
		if (requestId === searchRequestId) {
			toast.showError(error, i18n.baseText('sendCopy.toast.searchError.title'));
		}
	} finally {
		if (requestId === searchRequestId) isSearching.value = false;
	}
}

// `debounce` applies `getDebounceTime` to the time itself.
const debouncedSearch = debounce(search, {
	debounceTime: DEBOUNCE_TIME.INPUT.SEARCH,
	trailing: true,
});

function onSearch(query: string) {
	void debouncedSearch(query);
}

function onSelect(userId: string) {
	if (!userId || limitReached.value || selectedIds.value.includes(userId)) return;
	const user = candidates.value.find((candidate) => candidate.id === userId);
	if (user) selected.value = [...selected.value, user];
}

function remove(userId: string) {
	selected.value = selected.value.filter((user) => user.id !== userId);
}

function close() {
	capabilityRegistry.use(sendCopyModalCloser)(props.modalName);
}

function onOpenChange(isOpen: boolean) {
	if (!isOpen) close();
}

watch(
	() => props.open,
	(isOpen) => {
		if (!isOpen) return;
		selected.value = [];
		candidates.value = [];
		void search('');
	},
	{ immediate: true },
);

const reasonText = (reason: SendCopyFailureReason) => {
	switch (reason) {
		case 'self':
			return i18n.baseText('sendCopy.failure.self');
		case 'not-found':
			return i18n.baseText('sendCopy.failure.notFound');
		case 'not-eligible':
			return i18n.baseText('sendCopy.failure.notEligible');
		default:
			return i18n.baseText('sendCopy.failure.error');
	}
};

function reportResults(results: SendCopyResult[]) {
	const sentCount = results.filter((result) => result.status === 'sent').length;
	const failures = results.flatMap((result) => (result.status === 'failed' ? [result] : []));

	if (failures.length === 0) {
		toast.showMessage({
			type: 'success',
			title: i18n.baseText('sendCopy.toast.success.title'),
			message: i18n.baseText('sendCopy.toast.success.message', {
				adjustToNumber: sentCount,
				interpolate: { count: sentCount },
			}),
		});
		return;
	}

	const byId = new Map(selected.value.map((user) => [user.id, user]));
	const details = failures
		.map((failure) => {
			const user = byId.get(failure.recipientId);
			const who = user ? recipientLabel(user) : failure.recipientId;
			return `${who}: ${reasonText(failure.reason)}`;
		})
		.join('; ');

	toast.showMessage({
		type: sentCount > 0 ? 'warning' : 'error',
		title:
			sentCount > 0
				? i18n.baseText('sendCopy.toast.partial.title', {
						interpolate: { sent: sentCount, total: results.length },
					})
				: i18n.baseText('sendCopy.toast.error.title'),
		// The names come from user input, so show them as plain text.
		message: details,
		dangerouslyUseHTMLString: false,
	});
}

async function onSend() {
	if (!selected.value.length || isSending.value || !workflowId.value) return;
	isSending.value = true;
	try {
		const { results } = await sendWorkflowCopy(
			rootStore.restApiContext,
			workflowId.value,
			selectedIds.value,
		);
		reportResults(results);
		// Keep the modal open when nothing was sent, so the user can change the list.
		if (results.some((result) => result.status === 'sent')) close();
	} catch (error) {
		toast.showError(error, i18n.baseText('sendCopy.toast.error.title'));
	} finally {
		isSending.value = false;
	}
}
</script>

<template>
	<N8nDialog
		:open="open"
		:header="i18n.baseText('sendCopy.modal.title', { interpolate: { name: workflowName } })"
		:description="i18n.baseText('sendCopy.modal.description')"
		size="medium"
		@update:open="onOpenChange"
	>
		<!-- N8nDialog renders no element of its own, so the test id goes on the body. -->
		<div :class="$style.body" data-test-id="send-copy-modal">
			<N8nText tag="label" size="small" bold :for="recipientsInputId">
				{{ i18n.baseText('sendCopy.modal.recipientsLabel') }}
			</N8nText>
			<N8nUserSelect
				:id="recipientsInputId"
				:users="candidateUsers"
				:ignore-ids="selectedIds"
				model-value=""
				:placeholder="i18n.baseText('sendCopy.modal.recipientsPlaceholder')"
				:remote="true"
				:remote-method="onSearch"
				:loading="isSearching"
				:teleported="false"
				:disabled="limitReached"
				data-test-id="send-copy-recipient-select"
				@update:model-value="onSelect"
			/>
			<N8nText v-if="limitReached" size="small" color="text-light">
				{{
					i18n.baseText('sendCopy.modal.limit', {
						interpolate: { count: SEND_COPY_MAX_RECIPIENTS },
					})
				}}
			</N8nText>

			<ul v-if="selected.length" :class="$style.list" data-test-id="send-copy-recipient-list">
				<li v-for="user in selected" :key="user.id" :class="$style.recipient">
					<N8nUserInfo
						:first-name="user.firstName ?? undefined"
						:last-name="user.lastName ?? undefined"
						:email="user.email"
					/>
					<N8nIconButton
						icon="x"
						variant="ghost"
						size="small"
						:aria-label="
							i18n.baseText('sendCopy.modal.remove', {
								interpolate: { name: recipientLabel(user) },
							})
						"
						:data-test-id="`send-copy-remove-${user.id}`"
						@click="remove(user.id)"
					/>
				</li>
			</ul>

			<N8nCallout theme="secondary" slim data-test-id="send-copy-contents">
				{{ i18n.baseText('sendCopy.modal.copied') }}
				{{ i18n.baseText('sendCopy.modal.notCopied') }}
				{{ i18n.baseText('sendCopy.modal.savedVersionNote') }}
			</N8nCallout>
		</div>

		<N8nDialogFooter>
			<N8nButton
				variant="outline"
				:label="i18n.baseText('sendCopy.modal.cancel')"
				data-test-id="send-copy-cancel"
				@click="close"
			/>
			<N8nButton
				variant="solid"
				:label="i18n.baseText('sendCopy.modal.send')"
				:loading="isSending"
				:disabled="!selected.length"
				data-test-id="send-copy-submit"
				@click="onSend"
			/>
		</N8nDialogFooter>
	</N8nDialog>
</template>

<style lang="scss" module>
.body {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--2xs);
}

.list {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
	margin: var(--spacing--2xs) 0;
	padding: 0;
	list-style: none;
}

.recipient {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--xs);
}
</style>
