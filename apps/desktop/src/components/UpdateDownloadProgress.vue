<script setup lang="ts">
import { computed } from 'vue';
import { tr } from '../i18n/messages';
import { useUpdatesStore } from '../stores/updates';

const updates = useUpdatesStore();
const percent = computed(() => {
  const progress = updates.state;
  return progress?.totalBytes
    ? Math.min(100, Math.floor((progress.downloadedBytes / progress.totalBytes) * 100))
    : undefined;
});
</script>

<template>
  <div class="update-progress" role="status">
    <progress :value="percent" max="100" :aria-label="tr('更新下载进度')" />
    <span>{{ percent === undefined ? tr('正在下载更新…') : tr('已下载 {0}%', percent) }}</span>
    <span v-if="percent === 100">{{ tr('正在验证更新包签名…') }}</span>
  </div>
</template>
