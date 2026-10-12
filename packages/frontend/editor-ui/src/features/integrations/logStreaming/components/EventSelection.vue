<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the events tab of the destination modal. A group checkbox
 * subscribes the destination to the whole group, and an event checkbox to one event.
 * `../FORK.md` describes it.
 */
import { N8nCheckbox, N8nInfoTip, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

import {
	AUDIT_GROUP,
	eventGroups,
	isEventSubscribed,
	isGroupSubscribed,
	textOrFallback,
	withEvent,
	withGroup,
} from '../logStreaming.utils';

const props = defineProps<{
	eventNames: string[];
	subscribedEvents: string[];
	anonymizeAuditMessages: boolean;
	readOnly?: boolean;
}>();

const emit = defineEmits<{
	'update:subscribedEvents': [value: string[]];
	'update:anonymizeAuditMessages': [value: boolean];
}>();

const i18n = useI18n();

const groups = computed(() => eventGroups(props.eventNames));
const groupNames = computed(() => groups.value.map(({ name }) => name));

const groupLabel = (group: string) =>
	textOrFallback(i18n, `settings.log-streaming.eventGroup.${group}`, group);
const groupInfo = (group: string) =>
	textOrFallback(i18n, `settings.log-streaming.eventGroup.${group}.info`, '');
const eventLabel = (eventName: string) =>
	textOrFallback(i18n, `settings.log-streaming.eventName.${eventName}`, eventName);

/** Some events of the group, but not the whole group. */
function isGroupPartial(group: string, events: string[]) {
	return (
		!isGroupSubscribed(props.subscribedEvents, group) &&
		events.some((event) => props.subscribedEvents.includes(event))
	);
}

function onGroupChange(group: string, on: boolean) {
	emit('update:subscribedEvents', withGroup(props.subscribedEvents, group, on, groupNames.value));
}

function onEventChange(eventName: string, on: boolean) {
	emit('update:subscribedEvents', withEvent(props.subscribedEvents, eventName, on));
}
</script>

<template>
	<div :class="$style.container" data-test-id="destination-events">
		<N8nText tag="p" :class="$style.title">
			{{ i18n.baseText('settings.log-streaming.tab.events.title') }}
		</N8nText>
		<div
			v-for="group in groups"
			:key="group.name"
			:class="$style.group"
			data-test-id="destination-event-group"
		>
			<div :class="$style.groupHeader">
				<N8nCheckbox
					:model-value="isGroupSubscribed(subscribedEvents, group.name)"
					:indeterminate="isGroupPartial(group.name, group.events)"
					:label="groupLabel(group.name)"
					:disabled="readOnly"
					data-test-id="destination-event-group-checkbox"
					@update:model-value="onGroupChange(group.name, $event)"
				/>
				<N8nInfoTip v-if="groupInfo(group.name)" :bold="false">
					{{ groupInfo(group.name) }}
				</N8nInfoTip>
			</div>
			<div v-if="group.name === AUDIT_GROUP" :class="$style.anonymize">
				<N8nCheckbox
					:model-value="anonymizeAuditMessages"
					:label="i18n.baseText('settings.log-streaming.tab.events.anonymize')"
					:disabled="readOnly"
					data-test-id="destination-anonymize-checkbox"
					@update:model-value="emit('update:anonymizeAuditMessages', $event)"
				/>
				<N8nInfoTip :bold="false">
					{{ i18n.baseText('settings.log-streaming.tab.events.anonymize.info') }}
				</N8nInfoTip>
			</div>
			<div :class="$style.events">
				<N8nCheckbox
					v-for="event in group.events"
					:key="event"
					:model-value="isEventSubscribed(subscribedEvents, event)"
					:label="eventLabel(event)"
					:disabled="readOnly || isGroupSubscribed(subscribedEvents, group.name)"
					data-test-id="destination-event-checkbox"
					@update:model-value="onEventChange(event, $event)"
				/>
			</div>
		</div>
	</div>
</template>

<style lang="scss" module>
.container {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--sm);
}

.title {
	margin: 0;
}

.group {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
	padding-bottom: var(--spacing--xs);
	border-bottom: var(--border);
}

.groupHeader,
.anonymize {
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
}

.anonymize {
	padding-left: var(--spacing--md);
}

.events {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
	padding-left: var(--spacing--md);
}
</style>
