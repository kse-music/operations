<script setup lang="ts">
import { tr } from './i18n/messages';

import { computed } from 'vue';
const props = defineProps<{ detail: Record<string, unknown> }>();
const labels: Record<string, string> = {
  pid: 'PID',
  get executable() {
    return tr('可执行文件');
  },
  get status() {
    return tr('进程状态');
  },
  get startTicks() {
    return tr('进程启动标识');
  },
  get bootId() {
    return tr('系统启动标识');
  },
  id: 'ID',
  get name() {
    return tr('名称');
  },
  get image() {
    return tr('镜像');
  },
  get created() {
    return tr('创建时间');
  },
  get state() {
    return tr('运行状态');
  },
  get environment() {
    return tr('环境变量');
  },
  get ports() {
    return tr('端口映射');
  },
  get mounts() {
    return tr('挂载点');
  },
  get restartPolicy() {
    return tr('重启策略');
  },
  get resources() {
    return tr('资源使用');
  },
  get properties() {
    return tr('服务属性');
  },
  get dockerState() {
    return tr('Docker 状态');
  },
  get dockerInstalled() {
    return tr('Docker 已安装');
  },
  get dockerVersion() {
    return tr('Docker 版本');
  },
  get dockerClientVersion() {
    return tr('客户端版本');
  },
  get dockerPlatform() {
    return tr('运行平台');
  },
  get dockerOperatingSystem() {
    return tr('操作系统');
  },
  get dockerInfo() {
    return tr('Docker 信息');
  },
  get systemd() {
    return tr('systemd 可用');
  },
  get systemdUser() {
    return tr('用户服务可用');
  },
  get commands() {
    return tr('可用命令');
  },
  get Name() {
    return tr('进程名称');
  },
  get State() {
    return tr('进程状态');
  },
  get PPid() {
    return tr('父进程 PID');
  },
  get Threads() {
    return tr('线程数');
  },
  get VmRSS() {
    return tr('常驻内存');
  },
  get VmSize() {
    return tr('虚拟内存');
  },
  get Uid() {
    return tr('用户 UID');
  },
  get Gid() {
    return tr('用户组 GID');
  },
};
const isDocker = computed(() =>
  ['dockerInstalled', 'dockerState', 'dockerVersion'].some((key) => key in props.detail),
);
const isProcess = computed(
  () => !isDocker.value && 'pid' in props.detail && 'startTicks' in props.detail,
);
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
const entries = computed(() => {
  if (isDocker.value) {
    const version = record(props.detail.dockerVersion);
    const server = record(version.Server);
    const client = record(version.Client);
    const states: Record<string, string> = {
      running: tr('运行中'),
      unavailable: tr('不可用或权限不足'),
      absent: tr('未安装'),
    };
    return Object.entries({
      dockerInstalled:
        typeof props.detail.dockerInstalled === 'boolean' ? props.detail.dockerInstalled : null,
      dockerState: states[text(props.detail.dockerState) ?? ''] ?? tr('未知'),
      dockerVersion: text(server.Version),
      dockerClientVersion: text(client.Version),
      dockerPlatform: [text(server.Os), text(server.Arch)].filter(Boolean).join(' / ') || null,
      dockerOperatingSystem: text(props.detail.dockerOperatingSystem),
    });
  }
  const entries = Object.entries(props.detail).filter(
    ([key]) =>
      ![
        'environmentRevealed',
        ...(isProcess.value ? ['startTicks', 'bootId', 'status'] : []),
      ].includes(key),
  );
  if (isProcess.value && structured(props.detail.status)) {
    const status = props.detail.status as Record<string, unknown>;
    for (const key of ['Name', 'State', 'PPid', 'Threads', 'VmRSS', 'VmSize', 'Uid', 'Gid'])
      if (key in status) entries.push([key, status[key]]);
  }
  return entries;
});
function structured(value: unknown): boolean {
  return value !== null && typeof value === 'object';
}
function display(value: unknown): string {
  if (value == null || value === '') return tr('不可用');
  if (typeof value === 'boolean') return value ? tr('是') : tr('否');
  return structured(value) ? JSON.stringify(value, null, 2) : String(value);
}
</script>
<template>
  <dl class="ops-detail-fields" data-testid="operations-detail">
    <div v-for="[key, value] in entries" :key="key" :class="{ 'detail-block': structured(value) }">
      <dt>{{ labels[key] ?? key }}</dt>
      <dd>
        <details
          v-if="structured(value)"
          :open="key === 'environment' && detail.environmentRevealed === true"
        >
          <summary>{{ tr('展开查看') }}</summary>
          <pre>{{ display(value) }}</pre>
        </details>
        <span v-else>{{ display(value) }}</span>
      </dd>
    </div>
    <div v-if="isProcess" class="detail-block">
      <dt>{{ tr('完整进程信息') }}</dt>
      <dd>
        <details>
          <summary>{{ tr('查看状态字段与启动标识') }}</summary>
          <pre>{{ display(detail) }}</pre>
        </details>
      </dd>
    </div>
  </dl>
</template>
