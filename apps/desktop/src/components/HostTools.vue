<script setup lang="ts">
import { ChartNoAxesCombined, FolderSync, SquareTerminal, Wrench } from '@lucide/vue';
import { messages, type WorkspaceView } from '../types/product';

defineProps<{ active: WorkspaceView; local: boolean }>();
defineEmits<{ navigate: [view: WorkspaceView] }>();
const tools = [
  { view: 'terminals', label: 'SSH 终端', icon: SquareTerminal },
  { view: 'files', label: 'SFTP 文件', icon: FolderSync },
  { view: 'monitor', label: '服务器监控', icon: ChartNoAxesCombined },
  { view: 'operations', label: 'Linux 运维', icon: Wrench },
] as const;
</script>

<template>
  <nav class="host-tools" aria-label="当前主机工具">
    <button
      v-for="tool in tools.filter((item) => !local || item.view === 'terminals')"
      :key="tool.view"
      :class="['host-tool', { active: active === tool.view }]"
      :aria-label="messages['zh-CN'][tool.view]"
      :aria-current="active === tool.view ? 'page' : undefined"
      @click="$emit('navigate', tool.view)"
    >
      <component :is="tool.icon" :size="16" aria-hidden="true" />{{
        local ? '本地终端' : tool.label
      }}
    </button>
  </nav>
</template>
