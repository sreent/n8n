<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the dialog that adds or edits a Git provider of Git
 * connections. An SSH key provider shows its public key (the deploy key) after a save that made a
 * key. See `../../FORK.md`.
 */
import { useToast } from '@n8n/composables/useToast';
import {
	N8nButton,
	N8nCheckbox,
	N8nCopyInput,
	N8nDialog,
	N8nDialogHeader,
	N8nDialogTitle,
	N8nInput,
	N8nInputLabel,
	N8nNotice,
	N8nOption,
	N8nSelect,
	N8nText,
	useMessage,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRootStore } from '@n8n/stores/useRootStore';
import { computed, ref } from 'vue';

import { MODAL_CONFIRM } from '@/app/constants';

import {
	createProvider,
	deleteProvider,
	updateProvider,
	type ProviderAuthInput,
} from '../../promotions.api';
import type { PromotionProvider, PromotionSshKeyType } from '../../promotions.types';

type AuthType = 'ssh-key' | 'token';

const props = defineProps<{
	/** The provider to edit. Without it, the dialog adds a provider. */
	provider?: PromotionProvider;
	/** The names of the connections that use the provider. */
	usedBy?: string[];
	/** Loads the page again after a change. */
	reload: () => Promise<void>;
}>();

const emit = defineEmits<{ close: []; created: [providerId: string] }>();

const i18n = useI18n();
const toast = useToast();
const message = useMessage();
const rootStore = useRootStore();

const isEdit = computed(() => !!props.provider);
const name = ref(props.provider?.name ?? '');
const authType = ref<AuthType>(props.provider?.authType ?? 'ssh-key');
const keyType = ref<PromotionSshKeyType>('ed25519');
const username = ref('');
const password = ref('');
const regenerateKey = ref(false);
const saving = ref(false);
/** The public key to show after a save that made a key. */
const deployKey = ref<string>();

const currentPublicKey = computed(() => {
	const config = props.provider?.config;
	return config && 'publicKey' in config ? config.publicKey : '';
});

const isInUse = computed(() => (props.usedBy?.length ?? 0) > 0);

const title = computed(() => {
	if (deployKey.value) return i18n.baseText('settings.promotions.provider.dialog.title.key');
	return i18n.baseText(
		isEdit.value
			? 'settings.promotions.provider.dialog.title.edit'
			: 'settings.promotions.provider.dialog.title.add',
	);
});

/** One of the username and the password without the other. */
const credentialsIncomplete = computed(
	() => authType.value === 'token' && !!username.value.trim() !== !!password.value,
);
const hasCredentials = computed(
	() => authType.value === 'token' && !!username.value.trim() && !!password.value,
);

const canSave = computed(() => {
	if (saving.value || !name.value.trim() || credentialsIncomplete.value) return false;
	if (!isEdit.value) return authType.value === 'ssh-key' || hasCredentials.value;
	const renamed = name.value.trim() !== props.provider?.name;
	return renamed || hasCredentials.value || regenerateKey.value;
});

function authInput(): ProviderAuthInput | undefined {
	if (authType.value === 'token') {
		return hasCredentials.value
			? { authType: 'token', username: username.value.trim(), password: password.value }
			: undefined;
	}
	if (!isEdit.value) return { authType: 'ssh-key', keyType: keyType.value };
	return regenerateKey.value ? { authType: 'ssh-key' } : undefined;
}

async function save() {
	if (!canSave.value) return;
	saving.value = true;
	try {
		if (props.provider) {
			const renamed = name.value.trim() !== props.provider.name;
			const auth = authInput();
			const updated = await updateProvider(rootStore.publicApiContext, props.provider.id, {
				...(renamed ? { name: name.value.trim() } : {}),
				...(auth ? { auth } : {}),
			});
			toast.showMessage({
				title: i18n.baseText('settings.promotions.provider.toast.updated'),
				type: 'success',
			});
			await props.reload();
			const config = updated.config;
			if (regenerateKey.value && 'publicKey' in config) deployKey.value = config.publicKey;
			else emit('close');
		} else {
			const auth = authInput();
			if (!auth) return;
			const created = await createProvider(rootStore.publicApiContext, {
				name: name.value.trim(),
				type: 'git',
				auth,
			});
			toast.showMessage({
				title: i18n.baseText('settings.promotions.provider.toast.created'),
				type: 'success',
			});
			emit('created', created.provider.id);
			await props.reload();
			if (created.publicKey) deployKey.value = created.publicKey;
			else emit('close');
		}
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.promotions.provider.toast.error.save'));
	} finally {
		saving.value = false;
	}
}

async function remove() {
	if (!props.provider || isInUse.value) return;
	const answer = await message.confirm(
		i18n.baseText('settings.promotions.provider.delete.confirm.message'),
		i18n.baseText('settings.promotions.provider.delete.confirm.title'),
		{
			type: 'warning',
			showClose: true,
			confirmButtonText: i18n.baseText('settings.promotions.provider.delete.confirm.button'),
			cancelButtonText: i18n.baseText('generic.cancel'),
		},
	);
	if (answer !== MODAL_CONFIRM) return;
	try {
		await deleteProvider(rootStore.publicApiContext, props.provider.id);
		toast.showMessage({
			title: i18n.baseText('settings.promotions.provider.toast.deleted'),
			type: 'success',
		});
		await props.reload();
		emit('close');
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.promotions.provider.toast.error.delete'));
	}
}

function onOpenChange(open: boolean) {
	if (!open) emit('close');
}
</script>

<template>
	<N8nDialog
		:open="true"
		:aria-description="
			i18n.baseText(
				deployKey
					? 'settings.promotions.provider.dialog.key.ariaDescription'
					: 'settings.promotions.provider.dialog.ariaDescription',
			)
		"
		@update:open="onOpenChange"
	>
		<N8nDialogHeader>
			<N8nDialogTitle>{{ title }}</N8nDialogTitle>
		</N8nDialogHeader>
		<div v-if="deployKey" :class="$style.form" data-test-id="promotion-provider-key-step">
			<N8nInputLabel :label="i18n.baseText('settings.promotions.provider.publicKey.label')">
				<N8nCopyInput
					:value="deployKey"
					:copy-label="i18n.baseText('settings.promotions.provider.publicKey.copy')"
					data-test-id="promotion-provider-public-key"
				/>
				<N8nText size="small" color="text-light">
					{{ i18n.baseText('settings.promotions.provider.publicKey.hint') }}
				</N8nText>
			</N8nInputLabel>
			<footer :class="$style.footer">
				<N8nButton data-test-id="promotion-provider-done-button" @click="emit('close')">
					{{ i18n.baseText('promotions.modal.close') }}
				</N8nButton>
			</footer>
		</div>
		<form
			v-else
			:class="$style.form"
			data-test-id="promotion-provider-form-step"
			@submit.prevent="save"
		>
			<N8nNotice v-if="isInUse" data-test-id="promotion-provider-in-use">
				{{ i18n.baseText('settings.promotions.provider.inUse.warning') }}
				{{
					i18n.baseText('settings.promotions.provider.inUse.connections', {
						interpolate: { names: (usedBy ?? []).join(', ') },
					})
				}}
			</N8nNotice>
			<N8nInputLabel :label="i18n.baseText('settings.promotions.provider.form.name')" required>
				<N8nInput v-model="name" data-test-id="promotion-provider-name-input" />
			</N8nInputLabel>
			<N8nInputLabel
				:label="i18n.baseText('settings.promotions.provider.form.authType')"
				:tooltip-text="
					isEdit ? i18n.baseText('settings.promotions.provider.form.authType.locked') : undefined
				"
			>
				<N8nSelect
					v-model="authType"
					size="large"
					:disabled="isEdit"
					:teleported="false"
					data-test-id="promotion-provider-auth-type-select"
				>
					<N8nOption
						value="ssh-key"
						:label="i18n.baseText('settings.promotions.providers.authType.sshKey')"
					/>
					<N8nOption
						value="token"
						:label="i18n.baseText('settings.promotions.providers.authType.token')"
					/>
				</N8nSelect>
			</N8nInputLabel>
			<template v-if="authType === 'ssh-key'">
				<N8nInputLabel
					v-if="!isEdit"
					:label="i18n.baseText('settings.promotions.provider.form.keyType')"
				>
					<N8nSelect
						v-model="keyType"
						size="large"
						:teleported="false"
						data-test-id="promotion-provider-key-type-select"
					>
						<N8nOption value="ed25519" label="ED25519" />
						<N8nOption value="rsa" label="RSA" />
					</N8nSelect>
				</N8nInputLabel>
				<template v-else>
					<N8nInputLabel :label="i18n.baseText('settings.promotions.provider.publicKey.label')">
						<N8nCopyInput
							:value="currentPublicKey"
							:copy-label="i18n.baseText('settings.promotions.provider.publicKey.copy')"
							data-test-id="promotion-provider-public-key"
						/>
					</N8nInputLabel>
					<N8nCheckbox
						v-model="regenerateKey"
						:label="i18n.baseText('settings.promotions.provider.regenerateKey')"
						data-test-id="promotion-provider-regenerate-key"
					/>
					<N8nText v-if="regenerateKey" size="small" color="text-light">
						{{ i18n.baseText('settings.promotions.provider.regenerateKey.hint') }}
					</N8nText>
				</template>
			</template>
			<template v-else>
				<N8nInputLabel
					:label="i18n.baseText('settings.promotions.provider.form.username')"
					:required="!isEdit"
				>
					<N8nInput v-model="username" data-test-id="promotion-provider-username-input" />
				</N8nInputLabel>
				<N8nInputLabel
					:label="i18n.baseText('settings.promotions.provider.form.password')"
					:required="!isEdit"
				>
					<N8nInput
						v-model="password"
						type="password"
						data-test-id="promotion-provider-password-input"
					/>
				</N8nInputLabel>
				<N8nText v-if="credentialsIncomplete" size="small" color="danger">
					{{ i18n.baseText('settings.promotions.provider.form.credentials.required') }}
				</N8nText>
				<N8nText v-if="isEdit" size="small" color="text-light">
					{{ i18n.baseText('settings.promotions.provider.form.credentials.keepHint') }}
				</N8nText>
			</template>
			<footer :class="$style.footer">
				<N8nButton
					v-if="isEdit"
					variant="destructive"
					:disabled="isInUse"
					:class="$style.delete"
					data-test-id="promotion-provider-delete-button"
					@click="remove"
				>
					{{ i18n.baseText('generic.delete') }}
				</N8nButton>
				<N8nButton
					variant="subtle"
					data-test-id="promotion-provider-cancel-button"
					@click="emit('close')"
				>
					{{ i18n.baseText('generic.cancel') }}
				</N8nButton>
				<N8nButton
					type="submit"
					:disabled="!canSave"
					:loading="saving"
					data-test-id="promotion-provider-save-button"
				>
					{{ i18n.baseText('generic.save') }}
				</N8nButton>
			</footer>
		</form>
	</N8nDialog>
</template>

<style module lang="scss">
.form {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.footer {
	display: flex;
	justify-content: flex-end;
	gap: var(--spacing--2xs);
}

.delete {
	margin-right: auto;
}
</style>
