<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ShieldCheck, Power, FolderKey } from '@lucide/vue';
import { usePluginsStore } from '../stores/plugins';
import { pluginsApi } from '../services/plugins';
import { togglePlugin } from '../services/plugin-lifecycle';
import type { InstalledPlugin, PluginPermission } from '../types/plugins';
const props = defineProps<{ plugin: InstalledPlugin }>();
const plugins = usePluginsStore();
const builtin = computed(() => props.plugin.source === 'system');
const grant = computed(() => plugins.grants[props.plugin.manifest.id]);
const permissions = ref<PluginPermission[]>([]),
  readRoots = ref(''),
  writeRoots = ref(''),
  allowExecute = ref(false),
  allowShell = ref(false);
const labels: Record<PluginPermission, [string, string]> = {
  'assistant.use': ['AI 运维助手', '使用已配置模型分析脱敏上下文，命令执行仍需明确确认'],
  'metrics.read': ['资源监控', '读取 CPU、内存、磁盘和网络采样'],
  'system.read': ['系统信息', '读取容器、进程、端口和服务状态'],
  'system.manage': ['系统操作', '修改状态、发送信号或查看敏感信息，逐次确认'],
  'logs.read': ['日志查看', '读取主动选择的文件、容器或服务日志'],
  'hosts.read': ['主机信息', '读取当前主机的基本信息'],
  'ssh.execute': ['SSH 命令', '执行只读命令，其他命令另行授权和确认'],
  'sftp.read': ['读取远程文件', '仅限下方可读目录'],
  'sftp.write': ['写入远程文件', '仅限下方可写目录，写入逐次确认'],
  'ui.contribute': ['插件界面', '显示插件功能和通知'],
  'settings.read': ['读取插件配置', '仅限这个插件自己的配置'],
  'settings.write': ['保存插件配置', '仅限这个插件自己的配置'],
};
const operationMap: Record<PluginPermission, string[]> = {
  'assistant.use': ['assistant.use'],
  'metrics.read': ['metrics.read'],
  'system.read': ['system.read'],
  'system.manage': ['system.manage'],
  'logs.read': ['logs.read'],
  'hosts.read': ['hosts.read'],
  'ssh.execute': ['ssh.read_only'],
  'sftp.read': ['sftp.read', 'logs.read'],
  'sftp.write': ['sftp.write'],
  'ui.contribute': ['ui.contribute', 'ui.notify'],
  'settings.read': ['settings.read'],
  'settings.write': ['settings.write'],
};
watch(
  () => JSON.stringify([props.plugin.revision, grant.value]),
  () => {
    permissions.value = [...(grant.value?.permissions ?? [])];
    readRoots.value = grant.value?.readRoots.join('\n') ?? '';
    writeRoots.value = grant.value?.writeRoots.join('\n') ?? '';
    allowExecute.value = grant.value?.operations.includes('ssh.execute') ?? false;
    allowShell.value = grant.value?.operations.includes('system.shell') ?? false;
  },
  { immediate: true },
);
async function save() {
  if (builtin.value) return;
  const operations = [
    ...new Set(permissions.value.flatMap((permission) => operationMap[permission])),
  ];
  if (permissions.value.includes('ssh.execute') && allowExecute.value)
    operations.push('ssh.execute');
  if (permissions.value.includes('system.manage') && allowShell.value)
    operations.push('system.shell');
  const roots = (value: string) =>
    value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  await plugins.mutate(() =>
    pluginsApi.grant(props.plugin.manifest.id, {
      expectedRevision: props.plugin.revision,
      permissions: permissions.value,
      operations,
      readRoots: roots(readRoots.value),
      writeRoots: roots(writeRoots.value),
      confirmed: true,
    }),
  );
}
async function revoke() {
  if (builtin.value) return;
  if (await plugins.ask('撤销插件授权？', '将停止插件调用，并关闭它的文档和日志。'))
    await plugins.mutate(() => pluginsApi.revoke(props.plugin.manifest.id));
}
</script>
<template>
  <div class="plugin-settings" aria-label="插件设置">
    <section class="plugin-settings-section plugin-state-section">
      <div>
        <h2><Power :size="17" aria-hidden="true" />运行状态</h2>
        <p class="subtle">
          {{
            plugin.enabled
              ? '插件已启用，能力由下方授权范围控制。'
              : '插件已禁用，启用后可使用已授权的功能。'
          }}
        </p>
      </div>
      <button class="button" :disabled="plugins.busy" @click="togglePlugin(plugin)">
        {{ plugin.enabled ? '禁用插件' : '启用插件' }}
      </button>
    </section>
    <details class="plugin-settings-section plugin-permissions" :open="!builtin">
      <summary class="plugin-permissions-summary">
        <span><ShieldCheck :size="16" aria-hidden="true" />权限与访问范围</span>
        <span class="plugin-status" :class="{ enabled: !!grant }">{{
          grant ? '已授权' : '尚未授权'
        }}</span>
      </summary>
      <form @submit.prevent="save">
        <header class="plugin-section-heading">
          <div>
            <p class="subtle">
              {{
                builtin
                  ? '内置插件的权限和访问范围由系统预置，无需配置。'
                  : '仅授予需要的能力；写入、修改和其他敏感操作仍会逐次确认。'
              }}
            </p>
          </div>
        </header>
        <div class="plugin-permission-list">
          <label
            v-for="permission in plugin.manifest.permissions"
            :key="permission"
            class="plugin-permission-option"
            ><input
              v-model="permissions"
              type="checkbox"
              :value="permission"
              :aria-label="permission"
              :disabled="builtin || plugins.busy"
            /><span
              ><strong>{{ labels[permission][0] }}</strong
              ><small>{{ labels[permission][1] }}</small></span
            ></label
          >
        </div>
        <div
          v-if="permissions.some((p) => ['ssh.execute', 'system.manage'].includes(p))"
          class="plugin-extra-scopes"
        >
          <label v-if="permissions.includes('ssh.execute')" class="checkbox-label"
            ><input
              v-model="allowExecute"
              type="checkbox"
              :disabled="builtin || plugins.busy"
            />允许请求其他命令（仍逐次确认）</label
          >
          <label v-if="permissions.includes('system.manage')" class="checkbox-label"
            ><input
              v-model="allowShell"
              type="checkbox"
              :disabled="builtin || plugins.busy"
            />允许请求容器终端（仍逐次确认）</label
          >
        </div>
        <p class="plugin-all-hosts subtle">
          适用于所有主机，使用时操作当前选择的主机。敏感操作仍需逐次确认。
        </p>
        <div
          v-if="permissions.some((p) => p === 'sftp.read' || p === 'sftp.write')"
          class="plugin-path-scopes"
        >
          <h3><FolderKey :size="16" aria-hidden="true" />远程目录</h3>
          <label v-if="permissions.includes('sftp.read')"
            >可读目录<textarea
              v-model="readRoots"
              rows="3"
              aria-label="插件可读目录"
              placeholder="每行一个绝对目录，例如 /var/log"
              :disabled="builtin || plugins.busy"
            />
          </label>
          <label v-if="permissions.includes('sftp.write')"
            >可写目录<textarea
              v-model="writeRoots"
              rows="3"
              aria-label="插件可写目录"
              placeholder="每行一个绝对目录"
              :disabled="builtin || plugins.busy"
            />
          </label>
        </div>
        <footer v-if="!builtin" class="action-row plugin-settings-actions">
          <button class="button primary" :disabled="plugins.busy">保存并授权</button
          ><button
            v-if="grant"
            type="button"
            class="button"
            :disabled="plugins.busy"
            @click="revoke"
          >
            撤销授权
          </button>
        </footer>
      </form>
    </details>
    <details class="plugin-settings-section plugin-package-details">
      <summary>插件信息</summary>
      <dl class="plugin-details">
        <dt>插件 ID</dt>
        <dd>{{ plugin.manifest.id }}</dd>
        <dt>开发者</dt>
        <dd>{{ plugin.manifest.publisher ?? plugin.manifest.author }}</dd>
        <dt>API 版本</dt>
        <dd>{{ plugin.manifest.apiVersion }}</dd>
        <dt>SHA256</dt>
        <dd class="plugin-digest">{{ plugin.packageDigest }}</dd>
        <dt>备份版本</dt>
        <dd>{{ plugin.previousVersion ?? '无' }}</dd>
      </dl>
    </details>
  </div>
</template>
