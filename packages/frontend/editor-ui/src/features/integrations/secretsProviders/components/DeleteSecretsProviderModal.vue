<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the modal that deletes a connection of external secrets. When
 * credentials use the secrets of the connection, the user types the name to confirm.
 * `../FORK.md` describes it.
 */
import { useToast } from '@n8n/composables/useToast';
import { N8nButton, N8nInput, N8nInputLabel, N8nLink, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import {
	deleteProjectSecretProviderConnection,
	deleteSecretProviderConnection,
} from '@n8n/rest-api-client';
import { useRootStore } from '@n8n/stores/useRootStore';
import { createEventBus } from '@n8n/utils/event-bus';
import { computed, onMounted, ref } from 'vue';

import Modal from '@/app/components/Modal.vue';
import { VIEWS } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';
import { getAllCredentials } from '@/features/credentials/credentials.api';

const props = defineProps<{
	modalName: string;
	data: {
		providerKey: string;
		providerName: string;
		secretsCount: number;
		projectId?: string;
		onConfirm?: () => void | Promise<void>;
	};
}>();

const i18n = useI18n();
const toast = useToast();
const uiStore = useUIStore();
const rootStore = useRootStore();
const modalBus = createEventBus();

const credentialsCount = ref(0);
const confirmation = ref('');
const isDeleting = ref(false);

/** Credentials use the secrets of the connection: the delete needs the typed name. */
const hasImpact = computed(() => credentialsCount.value > 0);

const canDelete = computed(
	() => !isDeleting.value && (!hasImpact.value || confirmation.value === props.data.providerName),
);

const secretsText = computed(() =>
	props.data.secretsCount === 1
		? i18n.baseText('settings.secretsProviderConnections.oneSecret')
		: i18n.baseText('settings.secretsProviderConnections.secrets', {
				interpolate: { count: String(props.data.secretsCount) },
			}),
);

const credentialsText = computed(() =>
	credentialsCount.value === 1
		? i18n.baseText('settings.secretsProviderConnections.delete.impact.oneCredential')
		: i18n.baseText('settings.secretsProviderConnections.delete.impact.credentials', {
				interpolate: { count: String(credentialsCount.value) },
			}),
);

/** The credentials page, filtered to the credentials that use secrets of the connection. */
const credentialsRoute = computed(() => ({
	name: VIEWS.CREDENTIALS,
	query: { externalSecretsStore: props.data.providerKey },
}));

/** Count the credentials that use secrets of the connection. */
onMounted(async () => {
	try {
		const credentials = await getAllCredentials(rootStore.restApiContext, {
			includeGlobal: true,
			externalSecretsStore: props.data.providerKey,
		});
		credentialsCount.value = credentials.length;
	} catch (error) {
		toast.showError(error, i18n.baseText('error'));
	}
});

function close() {
	uiStore.closeModal(props.modalName);
}

async function onDelete() {
	if (!canDelete.value) return;

	isDeleting.value = true;
	try {
		if (props.data.projectId) {
			await deleteProjectSecretProviderConnection(
				rootStore.restApiContext,
				props.data.projectId,
				props.data.providerKey,
			);
		} else {
			await deleteSecretProviderConnection(rootStore.restApiContext, props.data.providerKey);
		}
		toast.showMessage({
			type: 'success',
			title: i18n.baseText('settings.secretsProviderConnections.delete.success', {
				interpolate: { name: props.data.providerName },
			}),
		});
		close();
		await props.data.onConfirm?.();
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.secretsProviderConnections.delete.error'));
	} finally {
		isDeleting.value = false;
	}
}
</script>

<template>
	<Modal
		:name="modalName"
		:title="
			i18n.baseText('settings.secretsProviderConnections.delete.title', {
				interpolate: { name: data.providerName },
			})
		"
		width="540px"
		:event-bus="modalBus"
	>
		<template #content>
			<div :class="$style.content">
				<template v-if="hasImpact">
					<N8nText tag="p">
						{{
							i18n.baseText('settings.secretsProviderConnections.delete.description', {
								interpolate: { secretsCount: secretsText },
							})
						}}
					</N8nText>
					<div>
						<N8nText bold>{{
							i18n.baseText('settings.secretsProviderConnections.delete.impact.title')
						}}</N8nText>
						<ul :class="$style.impact">
							<li>
								<N8nText>
									<N8nLink :to="credentialsRoute" target="_blank" data-test-id="credentials-link">
										{{ credentialsText }}
									</N8nLink>
									{{
										i18n.baseText('settings.secretsProviderConnections.delete.impact.description')
									}}
								</N8nText>
							</li>
						</ul>
					</div>
					<div>
						<N8nInputLabel
							:label="
								i18n.baseText('settings.secretsProviderConnections.delete.confirmationLabel', {
									interpolate: { name: data.providerName },
								})
							"
							:bold="false"
						/>
						<N8nInput
							v-model="confirmation"
							:placeholder="data.providerName"
							data-test-id="delete-confirmation-input"
						/>
					</div>
				</template>
				<N8nText v-else tag="p">
					{{ i18n.baseText('settings.secretsProviderConnections.delete.description.noImpact') }}
				</N8nText>
			</div>
		</template>
		<template #footer>
			<div :class="$style.footer">
				<N8nButton variant="outline" @click="close">
					{{ i18n.baseText('generic.cancel') }}
				</N8nButton>
				<N8nButton
					variant="destructive"
					:disabled="!canDelete"
					:loading="isDeleting"
					data-test-id="confirm-delete-button"
					@click="onDelete"
				>
					{{ i18n.baseText('generic.delete') }}
				</N8nButton>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.impact {
	margin: var(--spacing--4xs) 0 0 var(--spacing--md);
	list-style: disc;
}

.footer {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--2xs);
}
</style>
