<script setup lang="ts">
// Fork code (not in upstream n8n): the line chart of one metric over the runs, from the oldest
// run to the newest. See `../../FORK.md`.
import type { ChartData, ChartOptions, Point } from 'chart.js';
import { computed } from 'vue';
import { Line } from 'vue-chartjs';

import type { IndexedTestRun } from '../../evaluation.utils';

const props = defineProps<{
	runs: IndexedTestRun[];
	selectedMetric: string;
}>();

// The points keep the run ID for the x axis, which the parsing keys read.
type ChartPoint = Point & { id: string };

const points = computed(() =>
	props.runs.flatMap((testRun): ChartPoint[] => {
		const value = testRun.metrics?.[props.selectedMetric];
		return typeof value === 'number' ? [{ id: testRun.id, x: testRun.index, y: value }] : [];
	}),
);

const chartData = computed(
	(): ChartData<'line'> => ({
		datasets: [
			{
				data: points.value,
				parsing: { xAxisKey: 'id', yAxisKey: 'y' },
				borderColor: 'rgba(255, 110, 92, 1)',
				backgroundColor: 'rgba(255, 110, 92, 0.2)',
				pointRadius: 3,
				tension: 0.2,
			},
		],
	}),
);

const indexById = computed(() => new Map(points.value.map((point) => [point.id, point.x])));

const chartOptions = computed(
	(): ChartOptions<'line'> => ({
		responsive: true,
		maintainAspectRatio: false,
		animation: false,
		plugins: { legend: { display: false } },
		scales: {
			x: {
				type: 'category',
				ticks: {
					// The x axis holds run IDs; it shows the run numbers.
					callback(_value, position) {
						const id = points.value[position]?.id;
						return id ? `#${indexById.value.get(id) ?? ''}` : '';
					},
				},
			},
			y: { beginAtZero: true },
		},
	}),
);
</script>

<template>
	<div :class="$style.chart">
		<Line :data="chartData" :options="chartOptions" />
	</div>
</template>

<style module lang="scss">
.chart {
	position: relative;
	height: 200px;
	width: 100%;
}
</style>
