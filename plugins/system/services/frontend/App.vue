<script setup lang="ts">
import { ref } from 'vue';
import ResourceView from '@serverdeck/plugin-sdk/ui/ResourceView.vue';
import type { ServiceAction, LogInput } from '@serverdeck/plugin-sdk/types/ops';
defineProps<{ hostId?: string }>();
const emit = defineEmits<{ log: [input: LogInput, title: string] }>();
const scope = ref<'system' | 'user'>('system');
const columns = [
  { key: 'unit', label: '服务' },
  { key: 'load', label: '加载' },
  { key: 'active', label: '状态' },
  { key: 'sub', label: '子状态' },
  { key: 'enabled', label: '开机自启' },
  { key: 'description', label: '说明' },
];
</script>
<template>
  <ResourceView
    :host-id="hostId"
    :list-request="{ kind: 'services', scope }"
    :columns="columns"
    row-key="unit"
    @log="(input, title) => emit('log', input, title)"
  >
    <template #capabilities="{ value }"
      ><span>systemd：{{ value.systemd ? '可用' : '不支持' }}</span></template
    >
    <template #toolbar
      ><select v-model="scope" aria-label="systemd 范围">
        <option value="system">系统服务</option>
        <option value="user">当前用户服务</option>
      </select></template
    >
    <template #actions="{ row, busy, inspect, ask, openLog }">
      <button
        class="text-button"
        :disabled="busy"
        @click="inspect({ kind: 'service_details', scope, unit: String(row.unit) }, '服务详情')"
      >
        详情
      </button>
      <button
        v-for="action in ['start', 'stop', 'restart', 'enable', 'disable'] as ServiceAction[]"
        :key="action"
        class="text-button"
        :disabled="busy"
        @click="
          ask(`服务 ${action} · ${scope === 'user' ? '当前用户' : '系统'}`, String(row.unit), {
            kind: 'service_action',
            scope,
            unit: String(row.unit),
            action,
            confirmed: true,
          })
        "
      >
        {{
          { start: '启动', stop: '停止', restart: '重启', enable: '启用自启', disable: '禁用自启' }[
            action
          ]
        }}
      </button>
      <button
        class="text-button"
        @click="
          openLog(
            {
              source: { kind: 'service', scope, unit: String(row.unit) },
              lines: 200,
              follow: true,
            },
            String(row.unit),
          )
        "
      >
        服务日志
      </button>
    </template>
  </ResourceView>
</template>
