<script lang="ts" setup>
// Fork: the page shows the plan and the usage only. The fork has no registration of the Community
// Edition, no licence key entry and no plan links (packages/cli/src/license/FORK.md).
import { computed, onMounted } from 'vue';
import { useUsageStore } from '../usage.store';
import { i18n as locale } from '@n8n/i18n';
import { useToast } from '@n8n/composables/useToast';
import { useDocumentTitle } from '@/app/composables/useDocumentTitle';
import { I18nT } from 'vue-i18n';

import { N8nBadge, N8nHeading, N8nInfoTip, N8nText, N8nTooltip } from '@n8n/design-system';

const usageStore = useUsageStore();
const toast = useToast();
const documentTitle = useDocumentTitle();

const badgedPlanName = computed(() => {
	const [badge, name] = usageStore.planName.split(' ');
	return {
		name,
		badge,
	};
});

const isCommunityEditionRegistered = computed(
	() => usageStore.planName.toLowerCase() === 'registered community',
);

onMounted(async () => {
	documentTitle.set(locale.baseText('settings.usageAndPlan.title'));
	usageStore.setLoading(true);
	try {
		await usageStore.getLicenseInfo();
		usageStore.setLoading(false);
	} catch (error) {
		if (!error.name) {
			error.name = locale.baseText('settings.usageAndPlan.error');
		}
		toast.showError(error, error.name, { message: error.message });
	}
});
</script>

<template>
	<div class="settings-usage-and-plan">
		<N8nHeading tag="h2" size="2xlarge">{{
			locale.baseText('settings.usageAndPlan.title')
		}}</N8nHeading>
		<div v-if="!usageStore.isLoading">
			<N8nHeading tag="h3" :class="$style.title" size="large">
				<I18nT keypath="settings.usageAndPlan.description" tag="span" scope="global">
					<template #name>{{ badgedPlanName.name ?? usageStore.planName }}</template>
					<template #type>
						<span v-if="usageStore.planId">{{
							locale.baseText('settings.usageAndPlan.plan')
						}}</span>
						<span v-else>{{ locale.baseText('settings.usageAndPlan.edition') }}</span>
					</template>
				</I18nT>
				<span v-if="badgedPlanName.badge && badgedPlanName.name" :class="$style.titleTooltip">
					<!-- `as-child` makes the badge itself the tooltip trigger. Without it the
						 tooltip adds an inline span trigger that becomes the flex item, so the
						 badge sits on the heading baseline instead of the optical center. -->
					<N8nTooltip placement="top" as-child>
						<template #content>
							<I18nT
								v-if="isCommunityEditionRegistered"
								keypath="settings.usageAndPlan.license.communityRegistered.tooltip"
								scope="global"
							>
							</I18nT>
						</template>
						<N8nBadge>{{ badgedPlanName.badge }}</N8nBadge>
					</N8nTooltip>
				</span>
			</N8nHeading>

			<div :class="$style.quota">
				<N8nText size="medium" color="text-light">
					{{ locale.baseText('settings.usageAndPlan.activeWorkflows') }}
				</N8nText>
				<div :class="$style.chart">
					<span v-if="usageStore.activeWorkflowTriggersLimit > 0" :class="$style.chartLine">
						<span
							:class="$style.chartBar"
							:style="{ width: `${usageStore.executionPercentage}%` }"
						></span>
					</span>
					<I18nT
						tag="span"
						:class="$style.count"
						keypath="settings.usageAndPlan.activeWorkflows.count"
						scope="global"
					>
						<template #count>{{ usageStore.activeWorkflowTriggersCount }}</template>
						<template #limit>
							<span v-if="usageStore.activeWorkflowTriggersLimit < 0">{{
								locale.baseText('settings.usageAndPlan.activeWorkflows.unlimited')
							}}</span>
							<span v-else>{{ usageStore.activeWorkflowTriggersLimit }}</span>
						</template>
					</I18nT>
				</div>
			</div>

			<N8nInfoTip>{{ locale.baseText('settings.usageAndPlan.activeWorkflows.hint') }}</N8nInfoTip>
		</div>
	</div>
</template>

<style lang="scss" module>
@use '@/app/css/variables' as *;

.actionBox {
	margin: var(--spacing--2xl) 0 0;
}

.spacedFlex {
	display: flex;
	justify-content: space-between;
	align-items: center;
}

.title {
	display: flex;
	align-items: center;
	padding: var(--spacing--2xl) 0 var(--spacing--md);
}

.quota {
	display: flex;
	justify-content: space-between;
	align-items: center;
	height: 54px;
	padding: 0 var(--spacing--sm);
	margin: 0 0 var(--spacing--xs);
	background: var(--color--background--light-3);
	border-radius: var(--radius--lg);
	border: 1px solid var(--color--foreground);
	white-space: nowrap;

	.count {
		text-transform: lowercase;
		font-size: var(--font-size--sm);
	}
}

.chart {
	display: flex;
	align-items: center;
	justify-content: flex-end;
	flex-grow: 1;
}

.chartLine {
	display: block;
	height: 10px;
	width: 100%;
	max-width: 260px;
	margin: 0 var(--spacing--md);
	border-radius: 10px;
	background: var(--color--background);
}

.chartBar {
	float: left;
	height: 100%;
	max-width: 100%;
	background: var(--color--secondary);
	border-radius: 10px;
	transition: width 0.2s $ease-out-expo;
}

div[class*='info'] > span > span:last-child {
	line-height: 1.4;
	padding: 0 0 0 var(--spacing--4xs);
}

.titleTooltip {
	display: flex;
	align-items: center;
	margin: 0 0 0 var(--spacing--2xs);
}
</style>
