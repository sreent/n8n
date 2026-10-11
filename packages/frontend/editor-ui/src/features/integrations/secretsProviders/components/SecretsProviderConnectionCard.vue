<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the card of a connection on the settings page of the
 * connections. `../FORK.md` describes it.
 */
import type {
	SecretProviderConnection,
	SecretProviderConnectionListItem,
	SecretProviderTypeResponse,
} from '@n8n/api-types';
import { N8nActionToggle, N8nBadge, N8nCard, N8nText, N8nTooltip } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { useRBACStore } from '@n8n/stores/rbac.store';
import { useSettingsStore } from '@n8n/stores/settings.store';
import dateformat from 'dateformat';
import { computed } from 'vue';

import SecretsProviderImage from './SecretsProviderImage.vue';

type CardAction = 'edit' | 'activate' | 'share' | 'reload' | 'delete';

const props = defineProps<{
	provider: SecretProviderConnection | SecretProviderConnectionListItem;
	providerTypeInfo?: SecretProviderTypeResponse;
	project?: { id: string; name: string | null } | null;
	canUpdate: boolean;
}>();

const emit = defineEmits<{
	edit: [providerKey: string];
	share: [providerKey: string];
	reload: [providerKey: string];
	delete: [providerKey: string];
	activate: [providerKey: string];
}>();

const i18n = useI18n();
const rbacStore = useRBACStore();
const settingsStore = useSettingsStore();

const displayName = computed(() => props.providerTypeInfo?.displayName ?? props.provider.type);

const secretsCount = computed(() =>
	props.provider.secretsCount === 1
		? i18n.baseText('settings.secretsProviderConnections.oneSecret')
		: i18n.baseText('settings.secretsProviderConnections.secrets', {
				interpolate: { count: String(props.provider.secretsCount) },
			}),
);

const createdAt = computed(() =>
	i18n.baseText('settings.secretsProviderConnections.card.createdAt', {
		interpolate: { date: dateformat(props.provider.createdAt, 'dd mmm yyyy') },
	}),
);

/** An active connection that the server could not connect. */
const isDisconnected = computed(() => props.provider.isEnabled && props.provider.state === 'error');

const isGlobal = computed(() => props.provider.projects.length === 0);

const canShare = computed(
	() => props.canUpdate && (settingsStore.moduleSettings['external-secrets']?.forProjects ?? false),
);

const actions = computed(() => {
	const items: Array<{ label: string; value: CardAction }> = [];
	if (props.canUpdate) {
		items.push({ label: i18n.baseText('generic.edit'), value: 'edit' });
		if (!props.provider.isEnabled) {
			items.push({ label: i18n.baseText('generic.activate'), value: 'activate' });
		}
	}
	if (canShare.value) {
		items.push({
			label: i18n.baseText('settings.secretsProviderConnections.actions.share'),
			value: 'share',
		});
	}
	if (rbacStore.hasScope('externalSecretsProvider:sync') && props.provider.state === 'connected') {
		items.push({
			label: i18n.baseText('settings.externalSecrets.card.actionDropdown.reload'),
			value: 'reload',
		});
	}
	if (rbacStore.hasScope('externalSecretsProvider:delete')) {
		items.push({ label: i18n.baseText('generic.delete'), value: 'delete' });
	}
	return items;
});

function onAction(action: CardAction) {
	const providerKey = props.provider.name;
	if (action === 'edit') emit('edit', providerKey);
	if (action === 'activate') emit('activate', providerKey);
	if (action === 'share') emit('share', providerKey);
	if (action === 'reload') emit('reload', providerKey);
	if (action === 'delete') emit('delete', providerKey);
}
</script>

<template>
	<N8nCard :class="$style.card" hoverable @click="emit('edit', provider.name)">
		<template v-if="providerTypeInfo" #prepend>
			<SecretsProviderImage :provider="providerTypeInfo" data-test-id="secrets-provider-image" />
		</template>
		<template #header>
			<div :class="$style.header">
				<N8nText tag="h2" bold data-test-id="secrets-provider-name">{{ provider.name }}</N8nText>
				<N8nBadge v-if="isDisconnected" data-test-id="disconnected-badge">
					{{ i18n.baseText('settings.secretsProviderConnections.state.disconnected') }}
				</N8nBadge>
				<N8nBadge v-else-if="!provider.isEnabled" data-test-id="disabled-badge">
					{{ i18n.baseText('settings.secretsProviderConnections.state.disabled') }}
				</N8nBadge>
			</div>
		</template>
		<N8nText color="text-light" size="small">
			<span data-test-id="secrets-provider-display-name">{{ displayName }}</span>
			|
			<span data-test-id="secrets-provider-secrets-count">{{ secretsCount }}</span>
			|
			<span data-test-id="secrets-provider-created-at">{{ createdAt }}</span>
		</N8nText>
		<template #append>
			<div :class="$style.append">
				<template v-if="provider.isEnabled">
					<N8nTooltip
						v-if="isGlobal"
						:content="i18n.baseText('settings.secretsProviderConnections.badge.tooltip.global')"
					>
						<N8nBadge leading-icon="globe" data-test-id="secrets-provider-global-badge">
							{{ i18n.baseText('settings.secretsProviderConnections.modal.scope.global') }}
						</N8nBadge>
					</N8nTooltip>
					<N8nTooltip
						v-else
						:content="
							i18n.baseText('settings.secretsProviderConnections.badge.tooltip.project', {
								interpolate: { projectName: project?.name ?? '' },
							})
						"
					>
						<N8nBadge leading-icon="layers" data-test-id="secrets-provider-project-badge">
							{{ project?.name }}
						</N8nBadge>
					</N8nTooltip>
				</template>
				<N8nActionToggle
					:actions="actions"
					data-test-id="secrets-provider-action-toggle"
					@action="onAction"
				/>
			</div>
		</template>
	</N8nCard>
</template>

<style lang="scss" module>
.card {
	margin-bottom: var(--spacing--2xs);
}

.header {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.append {
	display: flex;
	align-items: center;
	gap: var(--spacing--xs);
}
</style>
