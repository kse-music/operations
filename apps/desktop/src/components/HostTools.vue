<script setup lang="ts">
import { ChartNoAxesCombined, FolderSync, SquareTerminal } from '@lucide/vue';
import { messages, type WorkspaceView } from '../types/product';

defineProps<{ active: WorkspaceView; local: boolean }>();
defineEmits<{ navigate: [view: WorkspaceView] }>();
const tools = [
  { view: 'terminals', label: 'SSH 终端', icon: SquareTerminal },
  { view: 'files', label: 'SFTP 文件', icon: FolderSync },
  { view: 'server', label: '服务器管理', icon: ChartNoAxesCombined },
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
