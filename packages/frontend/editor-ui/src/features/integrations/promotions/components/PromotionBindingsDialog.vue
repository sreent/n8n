<script setup lang="ts">
/**
 * Fork code (not in upstream n8n): the dialog of a blocked apply. It lists the missing bindings
 * of the package by the workflows that use them, with a button that creates each one, and the
 * access requirements, the conflicts and the warnings of the preflight. Continue sends the apply
 * again when no item needs setup. See `../FORK.md`.
 */
import {
	N8nButton,
	N8nCallout,
	N8nDialog,
	N8nDialogBody,
	N8nDialogDescription,
	N8nDialogFooter,
	N8nDialogHeader,
	N8nDialogTitle,
	N8nIcon,
	N8nText,
} from '@n8n/design-system';
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

import { consumersText, usePromotionBindings } from '../composables/usePromotionBindings';
import type { BindingPreflight } from '../promotions.types';

const props = defineProps<{
	preflight: BindingPreflight;
	/** The error of the last Continue. */
	continueError?: string;
	continuing?: boolean;
}>();

const emit = defineEmits<{ back: []; continue: [] }>();

const i18n = useI18n();
const { groups, busy, unresolvedCount, hasSavedResources, scopeLabel, create } =
	usePromotionBindings(() => props.preflight);

/**
 * The conflicts of Git connections. Upstream n8n added the conflicts of environments
 * (`project-deletion` and `destructive-change`) to the shared schema. The fork backend never sends
 * them.
 */
type Conflict = Exclude<
	BindingPreflight['conflicts'][number],
	{ code: 'project-deletion' | 'destructive-change' }
>;

const conflicts = computed(() =>
	props.preflight.conflicts.filter(
		(conflict): conflict is Conflict =>
			conflict.code !== 'project-deletion' && conflict.code !== 'destructive-change',
	),
);

function conflictName(conflict: Conflict) {
	return conflict.kind === 'project' ? conflict.project.name : conflict.name;
}

function conflictConsumers(conflict: Conflict) {
	if (conflict.kind === 'project') {
		return consumersText([{ project: conflict.project, workflows: conflict.workflows }], i18n);
	}
	return consumersText(conflict.consumers, i18n);
}

/** The buttons do nothing while the editor of a binding is open. */
function back() {
	if (!busy.value) emit('back');
}

function onContinue() {
	if (!busy.value && unresolvedCount.value === 0 && !props.continuing) emit('continue');
}

function onOpenChange(open: boolean) {
	if (!open) back();
}
</script>

<template>
	<N8nDialog :open="true" size="xlarge" :show-close-button="!busy" @update:open="onOpenChange">
		<N8nDialogHeader>
			<N8nButton
				variant="ghost"
				icon="arrow-left"
				icon-only
				:aria-label="i18n.baseText('promotions.bindings.back')"
				:disabled="busy"
				@click="back"
			/>
			<N8nDialogTitle>{{ i18n.baseText('promotions.bindings.title') }}</N8nDialogTitle>
			<N8nDialogDescription>{{
				i18n.baseText('promotions.bindings.subtitle')
			}}</N8nDialogDescription>
		</N8nDialogHeader>
		<N8nDialogBody :class="$style.body" data-test-id="promotion-bindings-body">
			<p>{{ i18n.baseText('promotions.bindings.description') }}</p>
			<N8nCallout v-if="continueError" theme="danger">
				{{ i18n.baseText('promotions.bindings.error.continue') }}
				{{ continueError }}
			</N8nCallout>
			<section v-for="group in groups" :key="group.workflowId" :class="$style.group">
				<h4 :class="$style.groupTitle">
					<N8nIcon icon="workflow" size="small" />
					<span>{{ group.workflowName }}</span>
				</h4>
				<table :class="$style.table">
					<thead>
						<tr>
							<th>{{ i18n.baseText('promotions.bindings.source') }}</th>
							<th>{{ i18n.baseText('promotions.bindings.destination') }}</th>
							<th>{{ i18n.baseText('promotions.bindings.status') }}</th>
						</tr>
					</thead>
					<tbody>
						<tr v-for="item in group.items" :key="item.key">
							<td>
								<N8nIcon
									:icon="item.binding.kind === 'credential' ? 'key-round' : 'json'"
									size="small"
								/>
								<span>{{ item.binding.name }}</span>
							</td>
							<td>
								<template v-if="item.resolvedName">
									<span>{{ item.resolvedName }}</span>
								</template>
								<template v-else>
									<span :class="$style.missing">{{
										i18n.baseText('promotions.bindings.notCreated')
									}}</span>
									<N8nIcon icon="circle-alert" size="small" :class="$style.warning" />
									<N8nButton
										variant="ghost"
										size="small"
										icon="plus"
										icon-only
										:aria-label="
											i18n.baseText('promotions.bindings.createNamed', {
												interpolate: { name: item.binding.name },
											})
										"
										:disabled="busy"
										@click="create(item)"
									/>
								</template>
								<div :class="$style.scope">{{ scopeLabel(item.binding) }}</div>
							</td>
							<td>
								<span v-if="item.resolvedName" :class="$style.resolved">
									<N8nIcon icon="circle-check" size="small" />
									{{ i18n.baseText('promotions.bindings.status.resolved') }}
								</span>
								<span v-else :class="$style.warning">
									<N8nIcon icon="circle-alert" size="small" />
									{{ i18n.baseText('promotions.bindings.status.missing') }}
								</span>
							</td>
						</tr>
					</tbody>
				</table>
			</section>
			<template v-if="preflight.accessRequirements.length">
				<h3 :class="$style.sectionTitle">
					{{ i18n.baseText('promotions.bindings.access.title') }}
				</h3>
				<N8nCallout
					v-for="requirement in preflight.accessRequirements"
					:key="requirement.sourceId"
					theme="warning"
				>
					<strong>{{ requirement.name }}</strong>
					<p>{{ i18n.baseText('promotions.bindings.access.description') }}</p>
					<p v-for="line in consumersText(requirement.consumers, i18n)" :key="line">{{ line }}</p>
				</N8nCallout>
			</template>
			<template v-if="conflicts.length">
				<h3 :class="$style.sectionTitle">
					{{ i18n.baseText('promotions.bindings.conflicts.title') }}
				</h3>
				<N8nCallout
					v-for="(conflict, index) in conflicts"
					:key="`${conflict.kind}-${index}`"
					theme="warning"
				>
					<strong>{{ conflictName(conflict) }}</strong>
					<p>{{ i18n.baseText(`promotions.bindings.conflicts.${conflict.code}`) }}</p>
					<p v-for="line in conflictConsumers(conflict)" :key="line">{{ line }}</p>
				</N8nCallout>
			</template>
			<p v-if="preflight.accessRequirements.length || preflight.conflicts.length">
				{{ i18n.baseText('promotions.bindings.restart') }}
			</p>
			<template v-if="preflight.warnings.length">
				<h3 :class="$style.sectionTitle">
					{{ i18n.baseText('promotions.bindings.warnings.title') }}
				</h3>
				<N8nCallout
					v-for="warning in preflight.warnings"
					:key="`${warning.code}-${warning.name}`"
					theme="info"
				>
					{{
						i18n.baseText('promotions.bindings.warnings.variableShadowed', {
							interpolate: { name: warning.name },
						})
					}}
					<p v-for="line in consumersText(warning.consumers, i18n)" :key="line">{{ line }}</p>
				</N8nCallout>
			</template>
			<N8nText v-if="hasSavedResources" tag="p" size="small" color="text-light">
				{{ i18n.baseText('promotions.bindings.savedResources') }}
			</N8nText>
		</N8nDialogBody>
		<N8nDialogFooter :class="$style.footer">
			<span role="status" :class="$style.status">{{
				i18n.baseText('promotions.bindings.unresolvedCount', {
					adjustToNumber: unresolvedCount,
					interpolate: { count: unresolvedCount },
				})
			}}</span>
			<N8nButton variant="outline" :disabled="busy" @click="back">
				{{ i18n.baseText('promotions.bindings.close') }}
			</N8nButton>
			<N8nButton :disabled="busy || unresolvedCount > 0" :loading="continuing" @click="onContinue">
				{{ i18n.baseText('promotions.bindings.continue') }}
			</N8nButton>
		</N8nDialogFooter>
	</N8nDialog>
</template>

<style module lang="scss">
.body {
	gap: var(--spacing--xs);
	max-height: 60vh;
}

.group {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--3xs);
}

.groupTitle,
.sectionTitle {
	display: flex;
	align-items: center;
	gap: var(--spacing--3xs);
	margin: 0;
	font-size: var(--font-size--sm);
	font-weight: var(--font-weight--bold);
}

.table {
	width: 100%;
	border-collapse: collapse;
	font-size: var(--font-size--sm);

	th,
	td {
		padding: var(--spacing--3xs) var(--spacing--2xs);
		border-bottom: var(--border);
		text-align: left;
		vertical-align: top;
	}
}

.scope {
	color: var(--color--text--tint-1);
	font-size: var(--font-size--xs);
}

.missing {
	color: var(--color--text--tint-1);
}

.warning {
	color: var(--color--warning);
}

.resolved {
	color: var(--color--success);
}

.footer {
	align-items: center;
}

.status {
	margin-right: auto;
	font-size: var(--font-size--sm);
}
</style>
