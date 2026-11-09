<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ShieldCheck, FolderKey, Check, Minus } from '@lucide/vue';
import { usePluginsStore } from '../stores/plugins';
import { pluginsApi } from '../services/plugins';
import type { InstalledPlugin, PluginPermission } from '../types/plugins';
const props = defineProps<{ plugin: InstalledPlugin }>();
const plugins = usePluginsStore();
const builtin = computed(() => props.plugin.source === 'system');
const grant = computed(() => plugins.grants[props.plugin.manifest.id]);
const permissions = ref<PluginPermission[]>([]),
  readRoots = ref(''),
  writeRoots = ref('');
const labels: Record<PluginPermission, [string, string]> = {
  'network.connect': ['本机 TCP 连接', '从本机探测指定地址与端口，逐次确认'],
  'models.use': ['模型调用', '使用平台已配置模型发送插件提供的消息，凭据保留在宿主'],
  'hosts.read': ['主机目录', '读取已登记主机的公开信息，不含密码、私钥和模型凭据'],
  'ssh.execute': ['SSH 命令与终端', '执行插件提供的远程命令，启动前逐次确认真实命令和目标'],
  'ssh.execute.preapproved': [
    '固定命令预授权',
    '下方列出的固定命令无需逐次确认；仍需授予 SSH 命令权限',
  ],
  'ssh.interactive.preapproved': [
    '交互会话预授权',
    '允许插件直接启动任意远程日志流和终端命令，无需逐次确认；仍需授予 SSH 命令权限',
  ],
  'sftp.read': ['读取远程文件', '仅限下方可读目录'],
  'sftp.write': ['写入远程文件', '仅限下方可写目录，写入逐次确认'],
  'ui.contribute': ['插件界面', '显示插件功能和通知'],
  'settings.read': ['读取插件配置', '仅限这个插件自己的配置'],
  'settings.write': ['保存插件配置', '仅限这个插件自己的配置'],
};
const operationMap: Record<PluginPermission, string[]> = {
  'network.connect': ['network.connect'],
  'models.use': ['models.use'],
  'hosts.read': ['hosts.read'],
  'ssh.execute': ['ssh.execute'],
  'ssh.execute.preapproved': ['ssh.execute.preapproved'],
  'ssh.interactive.preapproved': ['ssh.interactive.preapproved'],
  'sftp.read': ['sftp.read'],
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
  },
  { immediate: true },
);
async function save() {
  if (builtin.value) return;
  const operations = [
    ...new Set(permissions.value.flatMap((permission) => operationMap[permission])),
  ];

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
    <section class="plugin-settings-section plugin-package-details">
      <h2>插件信息</h2>
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
                  ? '以下是此内置插件可使用的平台能力，由系统预置，仅供查阅和排查权限问题。'
                  : '仅授予需要的能力；写入、修改和其他敏感操作仍会逐次确认。'
              }}
            </p>
          </div>
        </header>
        <div class="plugin-permission-list">
          <component
            :is="builtin ? 'div' : 'label'"
            v-for="permission in plugin.manifest.permissions"
            :key="permission"
            class="plugin-permission-option"
            ><component
              :is="grant?.permissions.includes(permission) ? Check : Minus"
              v-if="builtin"
              :size="16"
              class="plugin-capability-icon"
              aria-hidden="true"
            /><input
              v-else
              v-model="permissions"
              type="checkbox"
              :value="permission"
              :aria-label="permission"
              :disabled="builtin || plugins.busy"
            /><span
              ><strong>{{ labels[permission][0] }}</strong
              ><small>{{ labels[permission][1] }}</small></span
            ></component
          >
        </div>
        <details v-if="plugin.manifest.preapprovedCommands?.length" class="plugin-preset-commands">
          <summary>预授权命令（{{ plugin.manifest.preapprovedCommands.length }} 条）</summary>
          <p class="subtle">
            授予固定命令预授权后，以下命令可在当前选择的主机上执行，无需逐次确认。请先核对内容；此授权不保证命令只读。
          </p>
          <pre
            v-for="(command, index) in plugin.manifest.preapprovedCommands"
            :key="index"
          ><code>{{ JSON.stringify(command, null, 2) }}</code></pre>
        </details>
        <p class="plugin-all-hosts subtle">
          适用于所有主机。请求仍校验实际目标与已授予能力，远程文件接口另受授权目录限制。SSH
          命令默认逐次确认，获准的固定命令除外。授权不向插件提供登录凭据。
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
  </div>
</template>
