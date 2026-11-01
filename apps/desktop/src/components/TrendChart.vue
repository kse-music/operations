<script setup lang="ts">
import { computed } from 'vue';
import type { HistoryPoint } from '../types/monitor';
const props = defineProps<{
  points: HistoryPoint[];
  field: 'cpu' | 'memory' | 'receiveRate' | 'sendRate';
  label: string;
  unit: string;
  max?: number;
}>();
const maximum = computed(
  () => props.max ?? Math.max(1, ...props.points.map((p) => p[props.field] ?? 0)),
);
const segments = computed(() => {
  const result: string[] = [];
  let current: string[] = [];
  const end = props.points.at(-1)?.sampledAt ?? 0,
    start = props.points[0]?.sampledAt ?? 0;
  for (const point of props.points) {
    const value = point[props.field];
    if (value == null) {
      if (current.length) result.push(current.join(' '));
      current = [];
      continue;
    }
    const x = end === start ? 0 : ((point.sampledAt - start) / (end - start)) * 600;
    current.push(`${x.toFixed(2)},${(110 - Math.min(value / maximum.value, 1) * 100).toFixed(2)}`);
  }
  if (current.length) result.push(current.join(' '));
  return result;
});
</script>
<template>
  <figure class="trend-chart">
    <figcaption>
      {{ label }}
      <span class="subtle">{{ maximum.toFixed(1) }} {{ unit }} · {{ points.length }} 点</span>
    </figcaption>
    <svg
      viewBox="0 0 600 120"
      preserveAspectRatio="none"
      role="img"
      :aria-label="`${label}趋势；缺失采样留空`"
    >
      <path d="M0 110H600M0 60H600M0 10H600" class="chart-grid" />
      <polyline
        v-for="(segment, index) in segments"
        :key="index"
        :points="segment"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
      /></svg
    ><small class="subtle"
      >{{ points[0] ? new Date(points[0].sampledAt).toLocaleTimeString() : '等待采样' }} —
      {{ points.at(-1) ? new Date(points.at(-1)!.sampledAt).toLocaleTimeString() : '' }} · 最近 30
      分钟 / 最多 600 点</small
    >
  </figure>
</template>
