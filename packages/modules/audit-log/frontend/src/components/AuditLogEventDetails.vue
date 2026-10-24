<script setup lang="ts">
import type { AuditLogEventResponse } from '@n8n/api-types';
import { N8nDialog, N8nDialogBody, N8nText } from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

import { formatTimestamp, useProjectTypeLabel } from '../audit-log.utils';

const props = defineProps<{
	/** The event to show. The dialog is closed when there is none. */
	event: AuditLogEventResponse | null;
	locale?: string;
}>();

const emit = defineEmits<{ close: [] }>();

const i18n = useI18n();
const projectTypeLabel = useProjectTypeLabel();

const fields = computed(() => {
	const { event } = props;
	if (!event) return [];
	return [
		{
			id: 'event',
			label: i18n.baseText('settings.auditLog.details.event'),
			value: event.eventName,
		},
		{
			id: 'time',
			label: i18n.baseText('settings.auditLog.details.time'),
			value: `${formatTimestamp(event.timestamp, props.locale)} (${event.timestamp})`,
		},
		{
			id: 'email',
			label: i18n.baseText('settings.auditLog.details.email'),
			value: event.userEmail,
		},
		{
			id: 'user-id',
			label: i18n.baseText('settings.auditLog.details.userId'),
			value: event.userId,
		},
		{
			id: 'project',
			label: i18n.baseText('settings.auditLog.details.project'),
			value: projectTypeLabel(event.projectType),
		},
		{
			id: 'project-id',
			label: i18n.baseText('settings.auditLog.details.projectId'),
			value: event.projectId,
		},
		{ id: 'id', label: i18n.baseText('settings.auditLog.details.id'), value: event.id },
	];
});

const payload = computed(() => (props.event ? JSON.stringify(props.event.payload, null, 2) : ''));

function onOpenChange(open: boolean) {
	if (!open) emit('close');
}
</script>

<template>
	<N8nDialog
		:open="event !== null"
		size="large"
		:header="i18n.baseText('settings.auditLog.details.title')"
		data-test-id="audit-log-event-details"
		@update:open="onOpenChange"
	>
		<N8nDialogBody>
			<dl :class="$style.fields">
				<template v-for="field in fields" :key="field.id">
					<dt>
						<N8nText size="small" color="text-light">{{ field.label }}</N8nText>
					</dt>
					<dd :data-test-id="`audit-log-event-details-${field.id}`">
						<N8nText size="small">{{ field.value ?? '—' }}</N8nText>
					</dd>
				</template>
			</dl>
			<N8nText tag="p" size="small" color="text-light" :class="$style.payloadLabel">
				{{ i18n.baseText('settings.auditLog.details.payload') }}
			</N8nText>
			<pre :class="$style.payload" data-test-id="audit-log-event-details-payload">{{
				payload
			}}</pre>
		</N8nDialogBody>
	</N8nDialog>
</template>

<style lang="scss" module>
.fields {
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: var(--spacing--3xs) var(--spacing--sm);
	margin: 0;

	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
}

.payloadLabel {
	margin-top: var(--spacing--sm);
}

.payload {
	max-height: 50vh;
	overflow: auto;
	margin: var(--spacing--3xs) 0 0;
	padding: var(--spacing--xs);
	border-radius: var(--radius);
	background-color: var(--color--background--light-2);
	font-family: var(--font-family--monospace);
	font-size: var(--font-size--2xs);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
</style>
