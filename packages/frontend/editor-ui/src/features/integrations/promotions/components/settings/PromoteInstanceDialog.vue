<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the dialog that promotes all projects of the instance to the
 * promote branch of the instance connection. See `../../FORK.md`.
 */
import { useToast } from '@n8n/composables/useToast';
import {
	N8nButton,
	N8nDialog,
	N8nDialogBody,
	N8nDialogFooter,
	N8nDialogHeader,
	N8nDialogTitle,
	N8nInput,
	N8nInputLabel,
	N8nText,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, ref } from 'vue';

import { promoteInstance } from '../../promotions.api';

const props = defineProps<{
	connectionId: string;
	/** The base branch of Promote. */
	branch: string;
	/** Each promote makes a new branch from the base branch. */
	createBranch: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const i18n = useI18n();
const toast = useToast();
const rootStore = useRootStore();

const commitMessage = ref('');
const promoting = ref(false);

const canPromote = computed(() => !promoting.value && !!commitMessage.value.trim());

async function promote() {
	if (!canPromote.value) return;
	promoting.value = true;
	try {
		const result = await promoteInstance(
			rootStore.publicApiContext,
			props.connectionId,
			commitMessage.value.trim(),
		);
		toast.showMessage({
			title: i18n.baseText('settings.promotions.promote.toast.success.title'),
			message: i18n.baseText('settings.promotions.promote.toast.success.message', {
				interpolate: { branch: result.git.branchName },
			}),
			type: 'success',
		});
		emit('close');
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.promotions.promote.toast.error'));
	} finally {
		promoting.value = false;
	}
}

function onOpenChange(open: boolean) {
	if (!open) emit('close');
}
</script>

<template>
	<N8nDialog
		:open="true"
		:aria-description="i18n.baseText('settings.promotions.promote.dialog.ariaDescription')"
		@update:open="onOpenChange"
	>
		<N8nDialogHeader>
			<N8nDialogTitle>{{
				i18n.baseText('settings.promotions.promote.dialog.title')
			}}</N8nDialogTitle>
		</N8nDialogHeader>
		<form @submit.prevent="promote">
			<N8nDialogBody :class="$style.body">
				<N8nText tag="p" color="text-base">
					{{
						createBranch
							? i18n.baseText('settings.promotions.promote.dialog.body.newBranch')
							: i18n.baseText('settings.promotions.promote.dialog.body.toBranch', {
									interpolate: { branch },
								})
					}}
				</N8nText>
				<N8nInputLabel
					:label="i18n.baseText('settings.promotions.promote.dialog.commitMessage.label')"
					required
				>
					<N8nInput
						v-model="commitMessage"
						type="textarea"
						:rows="3"
						:placeholder="
							i18n.baseText('settings.promotions.promote.dialog.commitMessage.placeholder')
						"
						data-test-id="promote-commit-message"
					/>
				</N8nInputLabel>
			</N8nDialogBody>
			<N8nDialogFooter>
				<N8nButton variant="outline" data-test-id="promote-cancel-button" @click="emit('close')">
					{{ i18n.baseText('generic.cancel') }}
				</N8nButton>
				<N8nButton
					type="submit"
					:disabled="!canPromote"
					:loading="promoting"
					data-test-id="promote-confirm-button"
				>
					{{ i18n.baseText('settings.promotions.promote.dialog.confirm') }}
				</N8nButton>
			</N8nDialogFooter>
		</form>
	</N8nDialog>
</template>

<style module lang="scss">
.body {
	gap: var(--spacing--sm);
}
</style>
