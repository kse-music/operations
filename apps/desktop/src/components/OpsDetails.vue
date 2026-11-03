<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ detail: Record<string, unknown> }>();
const labels: Record<string, string> = {
  pid: 'PID',
  executable: '可执行文件',
  status: '进程状态',
  startTicks: '进程启动标识',
  bootId: '系统启动标识',
  id: 'ID',
  name: '名称',
  image: '镜像',
  created: '创建时间',
  state: '运行状态',
  environment: '环境变量',
  ports: '端口映射',
  mounts: '挂载点',
  restartPolicy: '重启策略',
  resources: '资源使用',
  properties: '服务属性',
  dockerState: 'Docker 状态',
  dockerInstalled: 'Docker 已安装',
  dockerVersion: 'Docker 版本',
  dockerInfo: 'Docker 信息',
  systemd: 'systemd 可用',
  systemdUser: '用户服务可用',
  commands: '可用命令',
  Name: '进程名称',
  State: '进程状态',
  PPid: '父进程 PID',
  Threads: '线程数',
  VmRSS: '常驻内存',
  VmSize: '虚拟内存',
  Uid: '用户 UID',
  Gid: '用户组 GID',
};
const isProcess = computed(() => 'pid' in props.detail && 'startTicks' in props.detail);
const entries = computed(() => {
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
  if (value == null || value === '') return '不可用';
  if (typeof value === 'boolean') return value ? '是' : '否';
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
          <summary>展开查看</summary>
          <pre>{{ display(value) }}</pre>
        </details>
        <span v-else>{{ display(value) }}</span>
      </dd>
    </div>
    <div v-if="isProcess" class="detail-block">
      <dt>完整进程信息</dt>
      <dd>
        <details>
          <summary>查看状态字段与启动标识</summary>
          <pre>{{ display(detail) }}</pre>
        </details>
      </dd>
    </div>
  </dl>
</template>
