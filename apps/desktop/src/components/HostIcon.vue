<script setup lang="ts">
import { useId } from 'vue';

defineProps<{ label: string; connected: boolean }>();
const screenGradient = `host-screen-${useId()}`;
</script>

<template>
  <svg
    class="host-icon"
    :class="{ connected }"
    width="14"
    height="14"
    viewBox="0 0 20 18"
    role="img"
    :aria-label="label"
    focusable="false"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient :id="screenGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#70d5e5" />
        <stop offset="0.5" stop-color="#27aac8" />
        <stop offset="1" stop-color="#126483" />
      </linearGradient>
    </defs>
    <path class="host-icon-stand" d="M8 12h4v4H8z" />
    <path class="host-icon-base" d="M5 15.5h10l2 1.5H3z" />
    <rect class="host-icon-frame" x="0.75" y="0.75" width="18.5" height="12.5" rx="0.8" />
    <rect
      class="host-icon-screen"
      x="1.75"
      y="1.75"
      width="16.5"
      height="9.5"
      :fill="`url(#${screenGradient})`"
    />
    <path d="M2 2h15.5L2 7z" fill="#e1faff" opacity="0.16" />
    <path d="M1.5 11.8h17" stroke="#d4dce2" stroke-opacity="0.55" stroke-width="0.5" />
    <rect class="host-icon-status" x="15.5" y="11.6" width="2" height="0.9" rx="0.2" />
  </svg>
</template>
