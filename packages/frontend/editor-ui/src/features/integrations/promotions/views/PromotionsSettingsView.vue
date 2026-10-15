<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the settings page of Git connections ("Environments v2"). It
 * manages the Git providers, the instance connection with its two directions and their local
 * copies, and the promote of the whole instance. See `../FORK.md`.
 */
import { useToast } from '@n8n/composables/useToast';
import {
	N8nButton,
	N8nEmptyState,
	N8nIcon,
	N8nInput,
	N8nInputLabel,
	N8nNotice,
	N8nOption,
	N8nSelect,
	N8nSettingsLayout,
	N8nSettingsPageHeader,
	N8nSettingsRow,
	N8nSettingsRowConfigure,
	N8nSettingsRowGroup,
	N8nSettingsSaveBar,
	N8nSettingsSection,
	N8nSwitch,
	N8nText,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, onMounted, ref } from 'vue';

import PromoteInstanceDialog from '../components/settings/PromoteInstanceDialog.vue';
import PromotionCheckoutStatus from '../components/settings/PromotionCheckoutStatus.vue';
import PromotionProviderDialog from '../components/settings/PromotionProviderDialog.vue';
import {
	usePromotionConnectionForm,
	type ConnectionPart,
} from '../composables/usePromotionConnectionForm';
import {
	getConnection,
	getInstanceConnections,
	getProvider,
	getProviderConnections,
	getProviders,
} from '../promotions.api';
import type { PromotionProvider, PromotionProviderSummary } from '../promotions.types';

interface ProviderDialogState {
	provider?: PromotionProvider;
	usedBy?: string[];
	/** The dialog opened from the connection form, which selects the new provider. */
	fromForm?: boolean;
}

const i18n = useI18n();
const toast = useToast();
const rootStore = useRootStore();
const form = usePromotionConnectionForm();
const { draft } = form;

const providers = ref<PromotionProviderSummary[]>([]);
const loaded = ref(false);
const loadFailed = ref(false);
const providerDialog = ref<ProviderDialogState>();
const promoteDialogOpen = ref(false);

const savedPromote = computed(() => form.saved.value?.configs.promote);
const canPromoteInstance = computed(() => form.checkoutState('promote') === 'connected');

const authLabel = (provider: PromotionProviderSummary) =>
	i18n.baseText(
		provider.authType === 'ssh-key'
			? 'settings.promotions.providers.authType.sshKey'
			: 'settings.promotions.providers.authType.token',
	);

const partLabels: Record<ConnectionPart, () => string> = {
	connection: () => i18n.baseText('settings.promotions.connection.partialSave.part.connection'),
	apply: () => i18n.baseText('settings.promotions.connection.partialSave.part.apply'),
	promote: () => i18n.baseText('settings.promotions.connection.partialSave.part.promote'),
};

const hasFailedParts = computed(() => form.failedParts.value.length > 0);
const failedPartNames = computed(() =>
	form.failedParts.value.map((part) => partLabels[part]()).join(', '),
);

async function load() {
	const context = rootStore.publicApiContext;
	try {
		const [list, connections] = await Promise.all([
			getProviders(context),
			getInstanceConnections(context),
		]);
		const summary = connections[0];
		const connection = summary ? await getConnection(context, summary.id) : null;
		providers.value = list;
		form.replaceSaved(connection);
		loadFailed.value = false;
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.promotions.providers.error.title'));
		loadFailed.value = true;
	} finally {
		loaded.value = true;
	}
}

async function openProvider(id: string) {
	const context = rootStore.publicApiContext;
	try {
		const [provider, connections] = await Promise.all([
			getProvider(context, id),
			getProviderConnections(context, id),
		]);
		providerDialog.value = { provider, usedBy: connections.map(({ name }) => name) };
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.promotions.provider.toast.error.load'));
	}
}

function onProviderCreated(providerId: string) {
	if (providerDialog.value?.fromForm) draft.providerId = providerId;
}

onMounted(load);
</script>

<template>
	<N8nSettingsLayout>
		<N8nSettingsPageHeader
			:title="i18n.baseText('settings.promotions.title')"
			:description="i18n.baseText('settings.promotions.description')"
			:show-docs-link="false"
		/>

		<N8nSettingsSection
			v-if="loaded && !loadFailed && savedPromote"
			:title="i18n.baseText('settings.promotions.promote.title')"
			:description="i18n.baseText('settings.promotions.promote.description')"
		>
			<div :class="$style.promote">
				<N8nButton
					:disabled="!canPromoteInstance"
					data-test-id="promote-instance-button"
					@click="promoteDialogOpen = true"
				>
					{{ i18n.baseText('settings.promotions.promote.button') }}
				</N8nButton>
				<N8nText
					v-if="!canPromoteInstance"
					size="small"
					color="text-light"
					data-test-id="promote-instance-not-connected"
				>
					{{ i18n.baseText('settings.promotions.promote.notConnected') }}
				</N8nText>
			</div>
		</N8nSettingsSection>

		<N8nSettingsSection
			:title="i18n.baseText('settings.promotions.providers.title')"
			:description="i18n.baseText('settings.promotions.providers.description')"
		>
			<N8nEmptyState
				v-if="loadFailed"
				:heading="i18n.baseText('settings.promotions.providers.error.title')"
				:description="i18n.baseText('settings.promotions.providers.error.description')"
				:button-text="i18n.baseText('generic.retry')"
				data-test-id="promotion-providers-load-error"
				@click:button="load"
			/>
			<template v-else-if="loaded">
				<N8nSettingsRowGroup v-for="provider in providers" :key="provider.id">
					<N8nSettingsRow
						:title="provider.name"
						:description="authLabel(provider)"
						clickable
						data-test-id="promotion-provider-row"
						@click="openProvider(provider.id)"
					>
						<template #visual>
							<N8nIcon icon="git-branch" />
						</template>
						<template #action>
							<N8nSettingsRowConfigure />
						</template>
					</N8nSettingsRow>
				</N8nSettingsRowGroup>
				<N8nSettingsRowGroup>
					<N8nSettingsRow
						:title="i18n.baseText('settings.promotions.providers.add')"
						:description="i18n.baseText('settings.promotions.providers.add.description')"
						clickable
						data-test-id="promotion-providers-add"
						@click="providerDialog = {}"
					>
						<template #visual>
							<N8nIcon icon="plus" />
						</template>
						<template #action>
							<N8nIcon icon="chevron-right" size="small" />
						</template>
					</N8nSettingsRow>
				</N8nSettingsRowGroup>
			</template>
		</N8nSettingsSection>

		<N8nSettingsSection
			:title="i18n.baseText('settings.promotions.connection.title')"
			:description="i18n.baseText('settings.promotions.connection.description')"
		>
			<div
				v-if="loaded && !loadFailed"
				:class="$style.form"
				data-test-id="promotion-connection-form"
			>
				<N8nInputLabel
					:label="i18n.baseText('settings.promotions.connection.form.provider')"
					required
				>
					<div :class="$style.providerField">
						<N8nSelect
							v-model="draft.providerId"
							size="large"
							:placeholder="
								i18n.baseText('settings.promotions.connection.form.provider.placeholder')
							"
							:class="$style.providerSelect"
							data-test-id="promotion-connection-provider-select"
						>
							<N8nOption
								v-for="provider in providers"
								:key="provider.id"
								:value="provider.id"
								:label="provider.name"
							/>
						</N8nSelect>
						<N8nButton
							variant="subtle"
							data-test-id="promotion-connection-add-provider"
							@click="providerDialog = { fromForm: true }"
						>
							{{ i18n.baseText('settings.promotions.connection.form.provider.add') }}
						</N8nButton>
					</div>
				</N8nInputLabel>
				<N8nInputLabel :label="i18n.baseText('settings.promotions.connection.form.name')" required>
					<N8nInput v-model="draft.name" data-test-id="promotion-connection-name-input" />
				</N8nInputLabel>
				<N8nInputLabel
					:label="i18n.baseText('settings.promotions.connection.form.remoteUrl')"
					required
				>
					<N8nInput
						v-model="draft.remoteUrl"
						data-test-id="promotion-connection-remote-url-input"
					/>
					<N8nText
						size="small"
						color="text-light"
						data-test-id="promotion-connection-remote-url-hint"
					>
						{{ i18n.baseText('settings.promotions.connection.form.remoteUrl.hint') }}
					</N8nText>
				</N8nInputLabel>

				<N8nSettingsRowGroup>
					<N8nSettingsRow
						v-model="draft.apply.enabled"
						:title="i18n.baseText('settings.promotions.connection.apply.title')"
						:description="i18n.baseText('settings.promotions.connection.apply.description')"
						expandable
						:disclosure="false"
					>
						<template #action>
							<N8nSwitch
								v-model="draft.apply.enabled"
								data-test-id="promotion-connection-apply-toggle"
							/>
						</template>
						<template #expanded>
							<div :class="$style.direction">
								<N8nInputLabel
									:label="i18n.baseText('settings.promotions.connection.apply.branchName')"
									required
								>
									<N8nInput
										v-model="draft.apply.branch"
										data-test-id="promotion-connection-apply-branch-input"
									/>
								</N8nInputLabel>
								<PromotionCheckoutStatus
									:state="form.checkoutState('apply')"
									:branch="form.savedBranch('apply')"
									:dirty="form.isDirty.value"
									:busy="form.busyDirections.value.includes('apply')"
									@connect="form.connect('apply')"
									@disconnect="form.disconnect('apply')"
								/>
							</div>
						</template>
					</N8nSettingsRow>
					<N8nSettingsRow
						v-model="draft.promote.enabled"
						:title="i18n.baseText('settings.promotions.connection.promote.title')"
						:description="i18n.baseText('settings.promotions.connection.promote.description')"
						expandable
						:disclosure="false"
					>
						<template #action>
							<N8nSwitch
								v-model="draft.promote.enabled"
								data-test-id="promotion-connection-promote-toggle"
							/>
						</template>
						<template #expanded>
							<div :class="$style.direction">
								<N8nInputLabel
									:label="i18n.baseText('settings.promotions.connection.promote.baseBranchName')"
									required
								>
									<N8nInput
										v-model="draft.promote.branch"
										data-test-id="promotion-connection-promote-branch-input"
									/>
								</N8nInputLabel>
								<div :class="$style.createBranch">
									<N8nSwitch
										v-model="draft.promote.createBranch"
										:label="i18n.baseText('settings.promotions.connection.promote.createBranch')"
										data-test-id="promotion-connection-create-branch-toggle"
									/>
									<N8nText size="small" color="text-light">
										{{
											i18n.baseText(
												'settings.promotions.connection.promote.createBranch.description',
											)
										}}
									</N8nText>
								</div>
								<PromotionCheckoutStatus
									:state="form.checkoutState('promote')"
									:branch="form.savedBranch('promote')"
									:dirty="form.isDirty.value"
									:busy="form.busyDirections.value.includes('promote')"
									@connect="form.connect('promote')"
									@disconnect="form.disconnect('promote')"
								/>
							</div>
						</template>
					</N8nSettingsRow>
				</N8nSettingsRowGroup>

				<N8nNotice v-if="hasFailedParts" data-test-id="promotion-connection-partial-save">
					<strong>{{ i18n.baseText('settings.promotions.connection.partialSave.title') }}</strong>
					{{
						i18n.baseText('settings.promotions.connection.partialSave.description', {
							interpolate: { parts: failedPartNames },
						})
					}}
				</N8nNotice>
			</div>
		</N8nSettingsSection>

		<div v-if="loaded && !loadFailed" data-test-id="promotion-connection-save-bar">
			<N8nSettingsSaveBar
				:visible="form.isDirty.value || hasFailedParts"
				:message="
					hasFailedParts
						? i18n.baseText('settings.promotions.connection.partialSave.title')
						: i18n.baseText('settings.promotions.saveBar.message')
				"
				:save-label="
					hasFailedParts
						? i18n.baseText('generic.retry')
						: i18n.baseText('settings.promotions.saveBar.save')
				"
				:discard-label="i18n.baseText('settings.promotions.saveBar.discard')"
				:saving="form.saving.value"
				:save-disabled="!form.canSave.value"
				@save="form.save"
				@discard="form.discard"
			/>
		</div>

		<PromotionProviderDialog
			v-if="providerDialog"
			:provider="providerDialog.provider"
			:used-by="providerDialog.usedBy"
			:reload="load"
			@created="onProviderCreated"
			@close="providerDialog = undefined"
		/>
		<PromoteInstanceDialog
			v-if="promoteDialogOpen && form.saved.value && savedPromote"
			:connection-id="form.saved.value.id"
			:branch="savedPromote.settings.baseBranchName"
			:create-branch="savedPromote.settings.createBranchOnPromotion"
			@close="promoteDialogOpen = false"
		/>
	</N8nSettingsLayout>
</template>

<style module lang="scss">
.promote {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--spacing--2xs);
}

.form {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.providerField {
	display: flex;
	gap: var(--spacing--2xs);
}

.providerSelect {
	flex: 1;
}

.direction {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
	padding: var(--spacing--sm);
}

.createBranch {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}
</style>
