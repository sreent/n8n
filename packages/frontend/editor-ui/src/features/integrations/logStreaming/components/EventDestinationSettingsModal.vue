<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the modal with the settings of one log streaming destination.
 * It replaces the enterprise modal of the same name. The module descriptor registers it, so it
 * gets the destination in `data`. `../FORK.md` describes it.
 */
import { useToast } from '@n8n/composables/useToast';
import {
	N8nButton,
	N8nCallout,
	N8nInlineTextEdit,
	N8nInputLabel,
	N8nOption,
	N8nSelect,
	N8nTabs,
	N8nText,
	useMessage,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import type { EventDestination, EventDestinationInput } from '@n8n/rest-api-client/api/eventbus';
import { useSettingsStore } from '@n8n/stores/settings.store';
import { isRecord } from '@n8n/utils/is-record';
import set from 'lodash/set';
import unset from 'lodash/unset';
import { deepCopy, type INodeParameters } from 'n8n-workflow';
import { computed, onMounted, ref } from 'vue';

import Modal from '@/app/components/Modal.vue';
import { MODAL_CONFIRM } from '@/app/constants';
import { useUIStore } from '@/app/stores/ui.store';
import { provideWorkflowDocumentStore } from '@/app/stores/workflowDocument.store';
import type { IUpdateInformation } from '@/Interface';
import { useCredentialsStore } from '@/features/credentials/credentials.store';
import ParameterInputList from '@/features/ndv/parameters/components/ParameterInputList.vue';

import type { LogStreamModalData } from '../logStreaming.constants';
import { destinationDescription, WEBHOOK_CREDENTIAL_TYPES } from '../logStreaming.descriptions';
import { useLogStreamingStore } from '../logStreaming.store';
import {
	DESTINATION_TYPES,
	destinationType,
	isDestinationType,
	newDestination,
	typeLabel,
} from '../logStreaming.utils';
import EventSelection from './EventSelection.vue';

const props = defineProps<{
	modalName: string;
	data?: LogStreamModalData;
}>();

/** The path of the parameters in the values of the form, as in the node view. */
const PARAMETERS_PATH = 'parameters';

type Tab = 'settings' | 'events';

const isEventDestination = (value: unknown): value is EventDestination =>
	isRecord(value) && typeof value.id === 'string' && typeof value.__type === 'string';

const isWebhookCredentialType = (
	value: unknown,
): value is (typeof WEBHOOK_CREDENTIAL_TYPES)[number] =>
	WEBHOOK_CREDENTIAL_TYPES.some((type) => type === value);

// The parameter inputs of the node view need a workflow document, also outside a workflow.
provideWorkflowDocumentStore();

const logStreamingStore = useLogStreamingStore();
const credentialsStore = useCredentialsStore();
const settingsStore = useSettingsStore();
const uiStore = useUIStore();
const toast = useToast();
const message = useMessage();
const i18n = useI18n();

const stored = isEventDestination(props.data?.destination) ? props.data.destination : undefined;

/** The values of the form. A new destination has none until the user selects its type. */
const values = ref<EventDestinationInput | undefined>(stored ? deepCopy(stored) : undefined);
/** The id of the destination after the first save. */
const savedId = ref<string | undefined>(stored?.id);
const selectedType = ref('');
const activeTab = ref<Tab>('settings');
const hasChanges = ref(false);
const isSaving = ref(false);
const isTesting = ref(false);
const testResult = ref<boolean | undefined>(undefined);

const readOnly = computed(() => settingsStore.settings.logStreaming?.managedByEnv === true);
const type = computed(() => (values.value ? destinationType(values.value) : undefined));
const parameters = computed(() => (type.value ? destinationDescription(i18n, type.value) : []));
const nodeValues = computed<INodeParameters>(() => ({ [PARAMETERS_PATH]: values.value ?? {} }));
const label = computed(() => values.value?.label ?? '');
const subscribedEvents = computed(() => values.value?.subscribedEvents ?? []);

const tabs = computed(() => [
	{ value: 'settings' as const, label: i18n.baseText('settings.log-streaming.tab.settings') },
	{ value: 'events' as const, label: i18n.baseText('settings.log-streaming.tab.events') },
]);

/** The credential type of a webhook destination that uses a generic credential, else none. */
const credentialType = computed(() => {
	const current = values.value;
	if (!current || type.value !== '$$MessageEventBusDestinationWebhook') return undefined;
	if (current.authentication !== 'genericCredentialType') return undefined;
	return isWebhookCredentialType(current.genericAuthType) ? current.genericAuthType : undefined;
});
const credentialOptions = computed(() =>
	credentialType.value ? credentialsStore.getCredentialsByType(credentialType.value) : [],
);
const selectedCredentialId = computed(() => {
	const reference = credentialType.value ? values.value?.credentials : undefined;
	const entry =
		isRecord(reference) && credentialType.value ? reference[credentialType.value] : null;
	return isRecord(entry) && typeof entry.id === 'string' ? entry.id : '';
});

const testButtonTitle = computed(() => {
	if (testResult.value === undefined) return i18n.baseText('settings.log-streaming.testEvent');
	return testResult.value
		? i18n.baseText('settings.log-streaming.testEvent.success')
		: i18n.baseText('settings.log-streaming.testEvent.failure');
});

onMounted(async () => {
	await Promise.all([
		logStreamingStore.eventNames.length === 0 ? logStreamingStore.fetchEventNames() : undefined,
		credentialsStore.fetchAllCredentials().catch(() => undefined),
	]).catch((error: unknown) =>
		toast.showError(error, i18n.baseText('settings.log-streaming.loadError')),
	);
});

function update(change: (draft: EventDestinationInput) => void) {
	if (!values.value) return;
	const draft = deepCopy(values.value);
	change(draft);
	values.value = draft;
	hasChanges.value = true;
	testResult.value = undefined;
}

/** Continues a new destination with the defaults of the selected type. */
function onContinue() {
	if (!isDestinationType(selectedType.value)) return;
	values.value = newDestination(selectedType.value, typeLabel(i18n, selectedType.value));
	hasChanges.value = true;
}

function onValueChanged({ name, value }: IUpdateInformation) {
	const path = name.replace(new RegExp(`^${PARAMETERS_PATH}\\.`), '').replace(/^\./, '');
	update((draft) => {
		if (value === undefined) unset(draft, path);
		else set(draft, path, value);
	});
}

function onLabelChange(newLabel: string) {
	update((draft) => {
		draft.label = newLabel;
	});
}

function onCredentialChange(id: string) {
	const credential = credentialOptions.value.find((option) => option.id === id);
	const credentialTypeName = credentialType.value;
	if (!credential || !credentialTypeName) return;
	update((draft) => {
		draft.credentials = {
			...(isRecord(draft.credentials) ? draft.credentials : {}),
			[credentialTypeName]: { id: credential.id, name: credential.name },
		};
	});
}

function onSubscribedEventsChange(events: string[]) {
	update((draft) => {
		draft.subscribedEvents = events;
	});
}

function onAnonymizeChange(anonymize: boolean) {
	update((draft) => {
		draft.anonymizeAuditMessages = anonymize;
	});
}

async function save() {
	if (!values.value) return;
	isSaving.value = true;
	try {
		const saved = await logStreamingStore.saveDestination({ ...values.value, id: savedId.value });
		values.value = deepCopy(saved);
		savedId.value = saved.id;
		hasChanges.value = false;
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.log-streaming.saveError'));
	} finally {
		isSaving.value = false;
	}
}

async function sendTestEvent() {
	if (!savedId.value) return;
	isTesting.value = true;
	try {
		testResult.value = await logStreamingStore.sendTestEvent(savedId.value);
	} catch {
		testResult.value = false;
	} finally {
		isTesting.value = false;
	}
}

function close() {
	uiStore.closeModal(props.modalName);
}

/** Asks first, then deletes the destination and closes the modal. */
async function deleteDestination() {
	if (!savedId.value) return;
	const answer = await message.confirm(
		i18n.baseText('settings.log-streaming.destinationDelete.message', {
			interpolate: { destinationName: label.value },
		}),
		i18n.baseText('settings.log-streaming.destinationDelete.headline'),
		{
			type: 'warning',
			confirmButtonText: i18n.baseText(
				'settings.log-streaming.destinationDelete.confirmButtonText',
			),
			cancelButtonText: i18n.baseText('generic.cancel'),
		},
	);
	if (answer !== MODAL_CONFIRM) return;
	try {
		await logStreamingStore.deleteDestination(savedId.value);
		close();
	} catch (error) {
		toast.showError(error, i18n.baseText('settings.log-streaming.deleteError'));
	}
}
</script>

<template>
	<Modal
		:name="modalName"
		:event-bus="data?.eventBus"
		:width="values ? '820px' : '460px'"
		:min-height="values ? '620px' : undefined"
		:scrollable="true"
		:center="true"
	>
		<template #header>
			<div v-if="values" :class="$style.header">
				<div :class="$style.name" data-test-id="subtitle-showing-type">
					<N8nInlineTextEdit
						:model-value="label"
						:read-only="readOnly"
						:max-width="400"
						:placeholder="i18n.baseText('settings.log-streaming.destinationName.placeholder')"
						@update:model-value="onLabelChange"
					/>
					<N8nText size="small" color="text-light">{{ typeLabel(i18n, values.__type) }}</N8nText>
				</div>
				<div :class="$style.actions">
					<N8nButton
						v-if="savedId && !readOnly"
						variant="outline"
						icon="trash-2"
						:title="i18n.baseText('settings.log-streaming.delete')"
						data-test-id="destination-delete-button"
						@click="deleteDestination"
					/>
					<N8nButton
						v-if="savedId"
						variant="outline"
						:label="i18n.baseText('settings.log-streaming.testEvent')"
						:title="testButtonTitle"
						:icon="testResult === undefined ? undefined : testResult ? 'circle-check' : 'circle-x'"
						:loading="isTesting"
						:disabled="hasChanges"
						data-test-id="destination-test-button"
						@click="sendTestEvent"
					/>
					<span v-if="hasChanges && !readOnly" data-test-id="destination-save-button">
						<N8nButton
							:label="
								isSaving
									? i18n.baseText('settings.log-streaming.saving')
									: i18n.baseText('generic.save')
							"
							:loading="isSaving"
							@click="save"
						/>
					</span>
				</div>
			</div>
			<N8nText v-else tag="h2" size="large" bold>
				{{ i18n.baseText('settings.log-streaming.addDestination') }}
			</N8nText>
		</template>
		<template #content>
			<div :class="$style.content" data-test-id="destination-modal">
				<template v-if="!values">
					<N8nInputLabel
						:label="i18n.baseText('settings.log-streaming.selecttype')"
						:tooltip-text="i18n.baseText('settings.log-streaming.selecttypehint')"
					>
						<N8nSelect
							v-model="selectedType"
							:placeholder="i18n.baseText('settings.log-streaming.selecttypehint')"
							data-test-id="select-destination-type"
						>
							<N8nOption
								v-for="option in DESTINATION_TYPES"
								:key="option"
								:value="option"
								:label="typeLabel(i18n, option)"
							/>
						</N8nSelect>
					</N8nInputLabel>
					<div :class="$style.continue">
						<N8nButton
							:label="i18n.baseText('settings.log-streaming.continue')"
							:disabled="!selectedType"
							data-test-id="select-destination-button"
							@click="onContinue"
						/>
					</div>
				</template>
				<template v-else>
					<N8nCallout v-if="readOnly" theme="info">
						{{ i18n.baseText('settings.log-streaming.managedByEnv') }}
					</N8nCallout>
					<N8nTabs v-model="activeTab" :options="tabs" />
					<div v-show="activeTab === 'settings'" :class="$style.settings">
						<ParameterInputList
							:parameters="parameters"
							:node-values="nodeValues"
							:path="PARAMETERS_PATH"
							:is-read-only="readOnly"
							:hide-delete="true"
							@value-changed="onValueChanged"
						/>
						<N8nInputLabel
							v-if="credentialType"
							:label="i18n.baseText('settings.log-streaming.credential')"
							:required="true"
						>
							<N8nSelect
								:model-value="selectedCredentialId"
								:disabled="readOnly"
								:placeholder="i18n.baseText('settings.log-streaming.credential.placeholder')"
								data-test-id="destination-credential-select"
								@update:model-value="onCredentialChange"
							>
								<N8nOption
									v-for="credential in credentialOptions"
									:key="credential.id"
									:value="credential.id"
									:label="credential.name"
								/>
							</N8nSelect>
						</N8nInputLabel>
					</div>
					<EventSelection
						v-show="activeTab === 'events'"
						:event-names="logStreamingStore.eventNames"
						:subscribed-events="subscribedEvents"
						:anonymize-audit-messages="values.anonymizeAuditMessages === true"
						:read-only="readOnly"
						@update:subscribed-events="onSubscribedEventsChange"
						@update:anonymize-audit-messages="onAnonymizeChange"
					/>
				</template>
			</div>
		</template>
	</Modal>
</template>

<style lang="scss" module>
.header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--spacing--sm);
	padding-right: var(--spacing--lg);
}

.name {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
	min-width: 0;
}

.actions {
	display: flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.content {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.continue {
	display: flex;
	justify-content: flex-end;
}

.settings {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}
</style>
