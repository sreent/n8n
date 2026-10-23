<script setup lang="ts">
import { useToast } from '@n8n/composables/useToast';
import {
	N8nButton,
	N8nDataTableServer,
	N8nInput,
	N8nInputLabel,
	N8nOption,
	N8nSelect,
	N8nText,
	type TableHeader,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed, ref, watch } from 'vue';

import { useAiGatewayAdminStore } from '../ai-gateway-admin.store';
import type {
	AiGatewayBackendInfo,
	AiGatewayCredentialOption,
	AiGatewayProviderInfo,
	AiGatewayProviderSettings,
} from '../ai-gateway.api';
import { TABLE_PAGE_SIZES } from '../ai-gateway.constants';
import {
	AZURE_DEPLOYMENT_NAME,
	DOCUMENT_AI_PROCESSOR_ENTRY,
	GOOGLE_CLOUD_PROJECT,
	parseDeployments,
	parseDocumentAiProcessors,
	VERTEX_LOCATION,
} from '../ai-gateway.utils';
import { useTablePage } from '../composables/useTablePage';

/** The fields of one provider. An empty credential id is no credential. */
interface ProviderForm {
	credentialId: string;
	projectId: string;
	location: string;
	/** The deployments of Azure OpenAI, separated by commas. */
	deployments: string;
	/** The processors of Document AI for a service account, one on each line. */
	documentAiProcessors: string;
	/** The service account for the open models of Vertex AI behind OpenAI or Azure. */
	openModelsCredentialId: string;
	openModelsProjectId: string;
	openModelsLocation: string;
}

const i18n = useI18n();
const toast = useToast();
const store = useAiGatewayAdminStore();

const forms = ref<Record<string, ProviderForm>>({});

/** The backend takes up to 100 processors of Document AI for a provider. */
const MAX_DOCUMENT_AI_PROCESSORS = 100;

const emptyForm = (): ProviderForm => ({
	credentialId: '',
	projectId: '',
	location: '',
	deployments: '',
	documentAiProcessors: '',
	openModelsCredentialId: '',
	openModelsProjectId: '',
	openModelsLocation: '',
});

function reset() {
	forms.value = Object.fromEntries(
		store.providers.map((provider) => {
			const saved = store.settings?.providers[provider.slug];
			return [
				provider.slug,
				{
					credentialId: saved?.credentialId ?? '',
					projectId: saved?.projectId ?? '',
					location: saved?.location ?? '',
					deployments: (saved?.deployments ?? []).join(', '),
					documentAiProcessors: (saved?.documentAiProcessors ?? []).join('\n'),
					openModelsCredentialId: saved?.openModels?.credentialId ?? '',
					openModelsProjectId: saved?.openModels?.projectId ?? '',
					openModelsLocation: saved?.openModels?.location ?? '',
				},
			];
		}),
	);
}

/** The form of a provider. It is always there, so the template can bind its fields. */
function formOf(slug: string) {
	forms.value[slug] ??= emptyForm();
	return forms.value[slug];
}

/** The backend of a credential type, or `undefined` for the own type of the provider. */
function backendOfType(provider: AiGatewayProviderInfo, type: string | undefined) {
	return provider.backends.find((backend) => backend.credentialType === type);
}

/** The backend of the picked credential. */
function pickedBackend(provider: AiGatewayProviderInfo): AiGatewayBackendInfo | undefined {
	const credentialId = forms.value[provider.slug]?.credentialId;
	const option = provider.credentialOptions.find((candidate) => candidate.id === credentialId);
	return backendOfType(provider, option?.type);
}

/** Vertex AI: the Gemini API (`vertex-ai`) or the open models (`vertex-openai`). */
const isVertex = (backend: AiGatewayBackendInfo | undefined) =>
	backend?.kind === 'vertex-ai' || backend?.kind === 'vertex-openai';

/** The backend of the open models of Vertex AI, when the provider has one. */
const openModelsBackend = (provider: AiGatewayProviderInfo) =>
	provider.backends.find((backend) => backend.kind === 'vertex-openai');

/** The open models of Vertex AI can come next to an OpenAI or Azure credential. */
function offersOpenModels(provider: AiGatewayProviderInfo) {
	return (
		openModelsBackend(provider) !== undefined &&
		Boolean(forms.value[provider.slug]?.credentialId) &&
		pickedBackend(provider)?.kind !== 'vertex-openai'
	);
}

function openModelsOptions(provider: AiGatewayProviderInfo) {
	const backend = openModelsBackend(provider);
	return provider.credentialOptions.filter((option) => option.type === backend?.credentialType);
}

function optionLabel(provider: AiGatewayProviderInfo, option: AiGatewayCredentialOption) {
	const backend = backendOfType(provider, option.type);
	if (!backend) return option.name;
	return i18n.baseText('settings.forkAiGateway.providers.credentialOfBackend', {
		interpolate: { credential: option.name, backend: backend.displayName },
	});
}

const credentialTypes = (provider: AiGatewayProviderInfo) =>
	[provider.credentialType, ...provider.backends.map((backend) => backend.credentialType)].join(
		' / ',
	);

/** The settings that the form gives for a provider, with only the options of its backend. */
function settingsOf(provider: AiGatewayProviderInfo): AiGatewayProviderSettings | undefined {
	const form = forms.value[provider.slug];
	if (!form?.credentialId) return undefined;
	const result: AiGatewayProviderSettings = { credentialId: form.credentialId };
	const backend = pickedBackend(provider);
	if (isVertex(backend)) {
		if (form.projectId.trim()) result.projectId = form.projectId.trim();
		if (form.location.trim()) result.location = form.location.trim();
	}
	if (backend?.kind === 'azure-openai') {
		const deployments = parseDeployments(form.deployments);
		if (deployments.length > 0) result.deployments = deployments;
	}
	if (backend?.kind === 'google-cloud') {
		const processors = parseDocumentAiProcessors(form.documentAiProcessors);
		if (processors.length > 0) result.documentAiProcessors = processors;
	}
	if (offersOpenModels(provider) && form.openModelsCredentialId) {
		result.openModels = { credentialId: form.openModelsCredentialId };
		const projectId = form.openModelsProjectId.trim();
		const location = form.openModelsLocation.trim();
		if (projectId) result.openModels.projectId = projectId;
		if (location) result.openModels.location = location;
	}
	return result;
}

/** The saved settings of a provider, in the shape of `settingsOf`. */
function savedSettingsOf(provider: AiGatewayProviderInfo): AiGatewayProviderSettings | undefined {
	const saved = store.settings?.providers[provider.slug];
	if (!saved) return undefined;
	const result: AiGatewayProviderSettings = { credentialId: saved.credentialId };
	if (saved.projectId) result.projectId = saved.projectId;
	if (saved.location) result.location = saved.location;
	if (saved.deployments?.length) result.deployments = saved.deployments;
	if (saved.documentAiProcessors?.length) result.documentAiProcessors = saved.documentAiProcessors;
	if (saved.openModels) {
		const { credentialId, projectId, location } = saved.openModels;
		result.openModels = { credentialId };
		if (projectId) result.openModels.projectId = projectId;
		if (location) result.openModels.location = location;
	}
	return result;
}

function isValid(provider: AiGatewayProviderInfo) {
	const settings = settingsOf(provider);
	if (!settings) return true;
	const projectIds = [settings.projectId, settings.openModels?.projectId];
	const locations = [settings.location, settings.openModels?.location];
	return (
		projectIds.every((projectId) => !projectId || GOOGLE_CLOUD_PROJECT.test(projectId)) &&
		locations.every((location) => !location || VERTEX_LOCATION.test(location)) &&
		(settings.deployments ?? []).every((name) => AZURE_DEPLOYMENT_NAME.test(name)) &&
		(settings.documentAiProcessors ?? []).length <= MAX_DOCUMENT_AI_PROCESSORS &&
		(settings.documentAiProcessors ?? []).every((entry) => DOCUMENT_AI_PROCESSOR_ENTRY.test(entry))
	);
}

const valid = computed(() => store.providers.every(isValid));

const changed = computed(() =>
	store.providers.some(
		(provider) =>
			JSON.stringify(settingsOf(provider) ?? null) !==
			JSON.stringify(savedSettingsOf(provider) ?? null),
	),
);

// A save on another tab also changes the settings. The form then keeps the unsaved changes.
watch(
	() => [store.providers, store.settings] as const,
	(_, previous) => {
		if (previous?.[1] && changed.value) return;
		reset();
	},
	{ immediate: true },
);

async function save() {
	const providers: Record<string, AiGatewayProviderSettings> = {};
	for (const provider of store.providers) {
		const settings = settingsOf(provider);
		if (settings) providers[provider.slug] = settings;
	}
	try {
		await store.saveSettings({ providers });
		toast.showMessage({ title: i18n.baseText('settings.forkAiGateway.saved'), type: 'success' });
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.forkAiGateway.saveError'));
	}
}

const { page, itemsPerPage, pageItems } = useTablePage(() => store.providers);

const headers = computed<Array<TableHeader<AiGatewayProviderInfo>>>(() => [
	{
		title: i18n.baseText('settings.forkAiGateway.providers.provider'),
		key: 'displayName',
		disableSort: true,
		width: 240,
		resize: false,
	},
	{
		title: i18n.baseText('settings.forkAiGateway.providers.credential'),
		key: 'credential',
		value: () => undefined,
		disableSort: true,
		width: 720,
		resize: false,
	},
]);

defineExpose({ hasUnsavedChanges: changed });
</script>

<template>
	<div :class="$style.providers" data-test-id="ai-gateway-providers">
		<N8nText size="small" color="text-light">
			{{ i18n.baseText('settings.forkAiGateway.providers.description') }}
		</N8nText>
		<N8nDataTableServer
			v-model:page="page"
			v-model:items-per-page="itemsPerPage"
			:headers="headers"
			:items="pageItems"
			:items-length="store.providers.length"
			:page-sizes="TABLE_PAGE_SIZES"
			item-value="slug"
			data-test-id="ai-gateway-provider-list"
		>
			<template #[`item.displayName`]="{ item }">
				<div :data-test-id="`ai-gateway-provider-${item.slug}`">
					<div>{{ item.displayName }}</div>
					<code :class="$style.type">{{ credentialTypes(item) }}</code>
				</div>
			</template>
			<template #[`item.credential`]="{ item }">
				<div :class="$style.credentialCell">
					<N8nSelect
						v-if="item.credentialOptions.length > 0"
						v-model="formOf(item.slug).credentialId"
						:class="$style.select"
						size="medium"
						clearable
						:placeholder="i18n.baseText('settings.forkAiGateway.providers.none')"
						:data-test-id="`ai-gateway-provider-credential-${item.slug}`"
					>
						<N8nOption
							v-for="option in item.credentialOptions"
							:key="option.id"
							:value="option.id"
							:label="optionLabel(item, option)"
						/>
					</N8nSelect>
					<N8nText v-else size="small" color="text-light">
						{{
							i18n.baseText('settings.forkAiGateway.providers.noCredentials', {
								interpolate: { type: credentialTypes(item) },
							})
						}}
					</N8nText>

					<div
						v-if="pickedBackend(item)?.kind === 'azure-openai'"
						:class="$style.backendOptions"
						:data-test-id="`ai-gateway-provider-azure-${item.slug}`"
					>
						<N8nInputLabel
							:label="i18n.baseText('settings.forkAiGateway.providers.deployments')"
							:bold="false"
							size="small"
						>
							<N8nInput
								v-model="formOf(item.slug).deployments"
								:class="$style.select"
								size="small"
								:placeholder="
									i18n.baseText('settings.forkAiGateway.providers.deployments.placeholder')
								"
								:data-test-id="`ai-gateway-provider-deployments-${item.slug}`"
							/>
						</N8nInputLabel>
						<N8nText size="xsmall" color="text-light">
							{{ i18n.baseText('settings.forkAiGateway.providers.deployments.hint') }}
						</N8nText>
					</div>

					<div
						v-if="pickedBackend(item)?.kind === 'google-cloud'"
						:class="$style.backendOptions"
						:data-test-id="`ai-gateway-provider-document-ai-${item.slug}`"
					>
						<N8nInputLabel
							:label="i18n.baseText('settings.forkAiGateway.providers.documentAiProcessors')"
							:bold="false"
							size="small"
						>
							<N8nInput
								v-model="formOf(item.slug).documentAiProcessors"
								type="textarea"
								:rows="3"
								size="small"
								:placeholder="
									i18n.baseText('settings.forkAiGateway.providers.documentAiProcessors.placeholder')
								"
								:data-test-id="`ai-gateway-provider-document-ai-processors-${item.slug}`"
							/>
						</N8nInputLabel>
						<N8nText size="xsmall" color="text-light">
							{{ i18n.baseText('settings.forkAiGateway.providers.documentAiProcessors.hint') }}
						</N8nText>
					</div>

					<div
						v-if="isVertex(pickedBackend(item))"
						:class="$style.backendOptions"
						:data-test-id="`ai-gateway-provider-vertex-${item.slug}`"
					>
						<div :class="$style.row">
							<N8nInputLabel
								:label="i18n.baseText('settings.forkAiGateway.providers.projectId')"
								:bold="false"
								size="small"
							>
								<N8nInput
									v-model="formOf(item.slug).projectId"
									size="small"
									:placeholder="
										i18n.baseText('settings.forkAiGateway.providers.projectId.placeholder')
									"
									:data-test-id="`ai-gateway-provider-project-${item.slug}`"
								/>
							</N8nInputLabel>
							<N8nInputLabel
								:label="i18n.baseText('settings.forkAiGateway.providers.location')"
								:bold="false"
								size="small"
							>
								<N8nInput
									v-model="formOf(item.slug).location"
									size="small"
									:placeholder="
										i18n.baseText('settings.forkAiGateway.providers.location.placeholder')
									"
									:data-test-id="`ai-gateway-provider-location-${item.slug}`"
								/>
							</N8nInputLabel>
						</div>
						<N8nText size="xsmall" color="text-light">
							{{
								i18n.baseText(
									pickedBackend(item)?.kind === 'vertex-openai'
										? 'settings.forkAiGateway.providers.vertexOpenAi.hint'
										: 'settings.forkAiGateway.providers.vertex.hint',
								)
							}}
						</N8nText>
					</div>

					<div
						v-if="offersOpenModels(item)"
						:class="$style.backendOptions"
						:data-test-id="`ai-gateway-provider-open-models-${item.slug}`"
					>
						<N8nText size="small" :bold="true">
							{{ i18n.baseText('settings.forkAiGateway.providers.openModels') }}
						</N8nText>
						<N8nSelect
							v-if="openModelsOptions(item).length > 0"
							v-model="formOf(item.slug).openModelsCredentialId"
							size="small"
							clearable
							:placeholder="i18n.baseText('settings.forkAiGateway.providers.openModels.none')"
							:data-test-id="`ai-gateway-provider-open-models-credential-${item.slug}`"
						>
							<N8nOption
								v-for="option in openModelsOptions(item)"
								:key="option.id"
								:value="option.id"
								:label="option.name"
							/>
						</N8nSelect>
						<N8nText v-else size="xsmall" color="text-light">
							{{
								i18n.baseText('settings.forkAiGateway.providers.noCredentials', {
									interpolate: { type: openModelsBackend(item)?.credentialType ?? '' },
								})
							}}
						</N8nText>
						<div v-if="formOf(item.slug).openModelsCredentialId" :class="$style.row">
							<N8nInputLabel
								:label="i18n.baseText('settings.forkAiGateway.providers.projectId')"
								:bold="false"
								size="small"
							>
								<N8nInput
									v-model="formOf(item.slug).openModelsProjectId"
									size="small"
									:placeholder="
										i18n.baseText('settings.forkAiGateway.providers.projectId.placeholder')
									"
									:data-test-id="`ai-gateway-provider-open-models-project-${item.slug}`"
								/>
							</N8nInputLabel>
							<N8nInputLabel
								:label="i18n.baseText('settings.forkAiGateway.providers.location')"
								:bold="false"
								size="small"
							>
								<N8nInput
									v-model="formOf(item.slug).openModelsLocation"
									size="small"
									:placeholder="
										i18n.baseText('settings.forkAiGateway.providers.location.placeholder')
									"
									:data-test-id="`ai-gateway-provider-open-models-location-${item.slug}`"
								/>
							</N8nInputLabel>
						</div>
						<N8nText size="xsmall" color="text-light">
							{{ i18n.baseText('settings.forkAiGateway.providers.openModels.hint') }}
						</N8nText>
					</div>

					<N8nText
						v-if="!isValid(item)"
						size="xsmall"
						color="danger"
						:data-test-id="`ai-gateway-provider-invalid-${item.slug}`"
					>
						{{ i18n.baseText('settings.forkAiGateway.providers.invalid') }}
					</N8nText>
				</div>
			</template>
		</N8nDataTableServer>
		<div :class="$style.actions">
			<N8nButton
				variant="solid"
				size="medium"
				:label="i18n.baseText('settings.forkAiGateway.save')"
				:disabled="!changed || !valid"
				:loading="store.saving"
				data-test-id="ai-gateway-providers-save"
				@click="save"
			/>
		</div>
	</div>
</template>

<style lang="scss" module>
.providers {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.type {
	font-size: var(--font-size--2xs);
	color: var(--color--text--tint-1);
}

.credentialCell {
	padding-block: var(--spacing--2xs);
}

.select {
	width: 100%;
	max-width: 24rem;
}

.backendOptions {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
	margin-top: var(--spacing--2xs);
	max-width: 24rem;
}

.row {
	display: flex;
	gap: var(--spacing--xs);
}

.actions {
	display: flex;
	justify-content: flex-end;
}
</style>
