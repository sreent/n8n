<script setup lang="ts">
// Fork code (not in upstream n8n): a small bar chart with a group of bars for each metric and a bar
// for each version of a collection. The scores are shares from 0 to 1. See `../../FORK.md`.
import { useI18n } from '@n8n/i18n';
import { computed } from 'vue';

import { versionColorVar, versionLetter } from './versionPalette';

export type MetricGroup = {
	key: string;
	label: string;
	/** The score of each version, in the order of the versions. */
	values: Array<number | null>;
};

const props = withDefaults(
	defineProps<{
		groups: MetricGroup[];
		max?: number;
		variant?: 'compact' | 'full';
		/** A bar below this share shows in the danger colour. */
		criticalThreshold?: number;
	}>(),
	{ max: 1, variant: 'compact', criticalThreshold: 0.5 },
);

const i18n = useI18n();

const BAR_WIDTH = 16;
const BAR_GAP = 4;
const GROUP_GAP = 24;
const HEIGHT = 80;

const layout = computed(() => {
	let x = 0;
	return props.groups.map((group) => {
		const bars = group.values.map((value, index) => {
			const share = value === null ? 0 : Math.max(0, Math.min(value / props.max, 1));
			const bar = {
				index,
				x,
				height: Math.round(share * HEIGHT),
				value,
				percent: value === null ? null : Math.round(value * 100),
			};
			x += BAR_WIDTH + BAR_GAP;
			return bar;
		});
		const start = bars[0]?.x ?? x;
		x += GROUP_GAP - BAR_GAP;
		return { group, bars, start };
	});
});

const width = computed(() => {
	const last = layout.value.at(-1)?.bars.at(-1);
	return last ? last.x + BAR_WIDTH : 0;
});

function barTitle(label: string, percent: number | null) {
	return percent === null
		? i18n.baseText('evaluation.collections.chart.barNoData', { interpolate: { metric: label } })
		: i18n.baseText('evaluation.collections.chart.barValue', {
				interpolate: { metric: label, value: percent },
			});
}

function barColor(index: number, value: number | null) {
	if (value !== null && value < props.criticalThreshold) return 'var(--color--danger)';
	return versionColorVar(index);
}
</script>

<template>
	<div :class="[$style.chart, $style[variant]]" data-test-id="grouped-metric-chart">
		<template v-if="variant === 'compact'">
			<div v-for="item in layout" :key="item.group.key" :class="$style.groupLabel">
				{{ item.group.label }}
			</div>
		</template>
		<svg
			role="img"
			:aria-label="
				i18n.baseText('evaluation.collections.chart.ariaLabel', {
					adjustToNumber: groups.length,
					interpolate: { count: groups.length },
				})
			"
			:viewBox="`0 0 ${width} ${HEIGHT + (variant === 'full' ? 32 : 0)}`"
			:width="width"
			:height="HEIGHT + (variant === 'full' ? 32 : 0)"
		>
			<g v-for="item in layout" :key="item.group.key">
				<g v-for="bar in item.bars" :key="bar.index">
					<text
						v-if="variant === 'full' && bar.percent !== null"
						:x="bar.x + BAR_WIDTH / 2"
						:y="HEIGHT - bar.height - 4"
						text-anchor="middle"
						:class="$style.value"
					>
						{{ `${bar.percent}%` }}
					</text>
					<rect
						:x="bar.x"
						:y="HEIGHT - bar.height"
						:width="BAR_WIDTH"
						:height="bar.height"
						:fill="barColor(bar.index, bar.value)"
						rx="2"
					>
						<title>{{ barTitle(item.group.label, bar.percent) }}</title>
					</rect>
					<text
						v-if="variant === 'full'"
						:x="bar.x + BAR_WIDTH / 2"
						:y="HEIGHT + 16"
						text-anchor="middle"
						:class="$style.letter"
					>
						{{ versionLetter(bar.index) }}
					</text>
				</g>
			</g>
		</svg>
	</div>
</template>

<style module lang="scss">
.chart {
	display: flex;
	flex-direction: column;
	gap: var(--spacing--4xs);
}

.groupLabel {
	font-size: var(--font-size--3xs);
	color: var(--color--text--tint-1);
}

.value,
.letter {
	font-size: var(--font-size--3xs);
	fill: var(--color--text--tint-1);
}
</style>
