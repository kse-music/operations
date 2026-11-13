<script setup lang="ts">
import { House, Settings, SquareTerminal } from '@lucide/vue';
import { tr } from '../i18n/messages';
import type { WorkspaceArea } from '../stores/workspace';
defineProps<{ area: WorkspaceArea; disabled?: boolean; updateAvailable?: boolean }>();
defineEmits<{ home: []; local: []; settings: [] }>();
</script>
<template>
  <nav class="activity-rail" :aria-label="tr('应用导航')">
    <div class="activity-group sidebar-work-actions">
      <button
        class="nav-item"
        :aria-label="tr('首页')"
        :title="tr('首页')"
        :class="{ active: area === 'home' }"
        :aria-current="area === 'home' ? 'page' : undefined"
        :disabled="disabled"
        @click="$emit('home')"
      >
        <House :size="20" aria-hidden="true" />
      </button>
      <button
        class="nav-item"
        :aria-label="tr('本地终端')"
        :title="tr('本地终端')"
        :class="{ active: area === 'local' }"
        :aria-current="area === 'local' ? 'page' : undefined"
        :disabled="disabled"
        @click="$emit('local')"
      >
        <SquareTerminal :size="20" aria-hidden="true" />
      </button>
    </div>
    <div class="activity-group sidebar-app-actions">
      <button
        class="nav-item"
        :aria-label="tr('设置')"
        :title="tr('设置')"
        :class="{ active: area === 'settings' }"
        :aria-current="area === 'settings' ? 'page' : undefined"
        :disabled="disabled"
        @click="$emit('settings')"
      >
        <Settings :size="20" aria-hidden="true" />
        <span
          v-if="updateAvailable"
          class="update-badge"
          role="status"
          :aria-label="tr('有可用更新')"
        ></span>
      </button>
    </div>
  </nav>
</template>
