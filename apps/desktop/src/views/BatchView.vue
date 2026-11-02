<script setup lang="ts">
import { useErrorNotifications } from '../composables/error-notifications';
import { computed, onMounted, onBeforeUnmount, ref, shallowRef } from 'vue';
import { useHostsStore } from '../stores/hosts';
import { useOpsStore } from '../stores/ops';
import { useFilesStore } from '../stores/files';
import { filesApi } from '../services/files';
import { tasksApi, downloadResult } from '../services/tasks';
import { errorMessage } from '../services/ipc';
import TaskConnections from '../components/TaskConnections.vue';
import Modal from '../components/Modal.vue';
import { type Batch, type BatchInput, type BatchRow, taskLabels } from '../types/tasks';
import type { ConflictPolicy } from '../types/files';
import { hostDisplayName } from '../types/hosts';
const hosts = useHostsStore(),
  ops = useOpsStore(),
  files = useFilesStore();
const selected = ref<string[]>([]),
  mode = ref<'command' | 'file'>('command'),
  command = ref(''),
  source = ref(''),
  destination = ref('/tmp'),
  conflict = ref<ConflictPolicy>('fail'),
  overwrite = ref(false),
  concurrency = ref(3),
  timeout = ref(60),
  error = ref(''),
  busy = ref(false);
const tasks = shallowRef<Batch[]>([]),
  currentId = ref(''),
  current = computed(() => tasks.value.find((b) => b.id === currentId.value));
const phrase = ref('');
type Preview = {
  input: BatchInput;
  labels: {
    id: string;
    name: string;
    hostname: string;
    username: string;
    port: number;
    ready: boolean;
  }[];
  retry?: { id: string; hostId: string; sessionId: string };
};
const preview = ref<Preview | null>(null);
const loading = ref(true);
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
async function poll() {
  try {
    const data = await tasksApi.batches(
      Object.fromEntries(tasks.value.map((t) => [t.id, t.revision])),
    );
    if (!disposed) {
      tasks.value = [...tasks.value.filter((t) => !data.some((n) => n.id === t.id)), ...data]
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-8);
      if (!tasks.value.some((t) => t.id === currentId.value) && tasks.value.length)
        currentId.value = tasks.value.at(-1)!.id;
    }
  } catch (e) {
    if (!disposed) error.value = errorMessage(e);
  } finally {
    if (!disposed) loading.value = false;
    if (!disposed) timer = setTimeout(() => void poll(), 1000);
  }
}
onMounted(() => void poll());
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
function session(id: string) {
  return mode.value === 'command'
    ? ops.connections[id]?.state === 'connected'
      ? ops.connections[id]?.session?.id
      : null
    : files.connections[id]?.state === 'connected'
      ? files.connections[id]?.id
      : null;
}
function makePreview(input: BatchInput, retry?: Preview['retry']) {
  preview.value = {
    input: structuredClone(input),
    labels: input.targets.map((t) => {
      const c =
        input.operation.kind === 'file' ? files.connections[t.hostId] : ops.connections[t.hostId];
      const h = c?.host ?? hosts.catalog?.hosts.find((h) => h.id === t.hostId);
      return {
        id: t.hostId,
        name: h ? hostDisplayName(h) : t.hostId,
        hostname: h?.hostname ?? '已删除主机',
        username: h?.username ?? '',
        port: h?.port ?? 22,
        ready: !!t.sessionId,
      };
    }),
    retry,
  };
  phrase.value = '';
}
function review() {
  error.value = '';
  if (!selected.value.length || selected.value.length > 32) {
    error.value = '请选择 1–32 台主机';
    return;
  }
  makePreview({
    targets: selected.value.map((id) => ({ hostId: id, sessionId: session(id) ?? null })),
    operation:
      mode.value === 'command'
        ? { kind: 'command', command: command.value }
        : {
            kind: 'file',
            source: source.value,
            destination: destination.value,
            conflict: conflict.value,
            confirmOverwrite: overwrite.value,
          },
    concurrency: concurrency.value,
    timeoutSecs: timeout.value,
    confirmed: false,
  });
}
async function submit() {
  const p = preview.value;
  if (!p || phrase.value !== `执行 ${p.labels.length} 台`) return;
  busy.value = true;
  error.value = '';
  try {
    const task = p.retry
      ? await tasksApi.retryFile(p.retry.id, p.retry.hostId, p.retry.sessionId, true)
      : await tasksApi.batch({ ...p.input, confirmed: true });
    tasks.value = [...tasks.value, task];
    currentId.value = task.id;
    preview.value = null;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function pick() {
  try {
    const paths = await filesApi.pick('files');
    if (paths.length > 1) {
      error.value = '批量分发每次只选择一个文件';
      return;
    }
    if (paths[0]) source.value = paths[0];
  } catch (e) {
    error.value = errorMessage(e);
  }
}
async function cancel(running: boolean) {
  if (!current.value) return;
  try {
    await tasksApi.cancel(current.value.id, running);
  } catch (e) {
    error.value = errorMessage(e);
  }
}
function retry(row: BatchRow) {
  const batch = current.value;
  if (!batch || batch.input.operation.kind !== 'file') return;
  const c = files.connections[row.hostId];
  if (c?.state !== 'connected' || !c.id) {
    error.value = '请先在文件分发模式下重新连接该目标';
    return;
  }
  const input = {
    ...batch.input,
    targets: [{ hostId: row.hostId, sessionId: c.id }],
    confirmed: false,
  };
  makePreview(input, { id: batch.id, hostId: row.hostId, sessionId: c.id });
}
function label(id: string, sessionId: string | null) {
  const o = ops.connections[id],
    f = files.connections[id];
  const actual = o?.session?.id === sessionId ? o.host : f?.id === sessionId ? f.host : null;
  const h = actual ?? hosts.catalog?.hosts.find((h) => h.id === id);
  return actual
    ? `${hostDisplayName(actual)} (${actual.username}@${actual.hostname}:${actual.port})`
    : h
      ? `${hostDisplayName(h)}（会话已结束；端点以执行时预览为准）`
      : id;
}

async function copy() {
  if (!current.value) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(current.value, null, 2));
  } catch (e) {
    error.value = errorMessage(e);
  }
}
useErrorNotifications(() => [
  error.value,
  ...tasks.value.flatMap((task) => task.rows.map((row) => row.message)),
]);
</script>
<template>
  <section class="operations-view tasks-view batch-view page-view">
    <header>
      <p class="eyebrow">BATCH OPERATIONS</p>
      <h1>多服务器批量运维</h1>
      <p class="subtle">
        所有命令都需要预览确认。不自动提权，不自动重试命令；超时或断线后远端进程可能仍在运行。任务由
        Rust 管理，离页后继续，结果仅保留在本次应用内。
      </p>
    </header>
    <form class="work-section" @submit.prevent="review">
      <div class="form-row">
        <label
          >任务类型
          <select v-model="mode" aria-label="批量任务类型">
            <option value="command">批量命令</option>
            <option value="file">单文件分发</option>
          </select></label
        ><label
          >并发数
          <input
            v-model.number="concurrency"
            type="number"
            min="1"
            max="8"
            required
            aria-label="批量并发数" /></label
        ><label
          >每台超时（秒）
          <input
            v-model.number="timeout"
            type="number"
            min="1"
            max="3600"
            required
            aria-label="批量超时"
        /></label>
      </div>
      <fieldset class="batch-targets">
        <legend>选择目标（{{ selected.length }} / 32）</legend>
        <label v-for="host in hosts.catalog?.hosts" :key="host.id"
          ><input
            v-model="selected"
            type="checkbox"
            :value="host.id"
            :aria-label="`选择批量目标 ${hostDisplayName(host)}`"
          />{{ hostDisplayName(host) }} · {{ host.username }}@{{ host.hostname }}:{{
            host.port
          }}</label
        >
        <p v-if="!hosts.catalog?.hosts.length">暂无主机，请先在主机管理的主机树中添加。</p>
      </fieldset>
      <TaskConnections v-if="selected.length" :ids="selected" :file="mode === 'file'" />
      <label v-if="mode === 'command'" class="task-command-label"
        >统一命令<textarea
          v-model="command"
          required
          maxlength="16384"
          rows="5"
          aria-label="批量统一命令"
          spellcheck="false"
        ></textarea>
      </label>
      <div v-else class="form-row">
        <label>本地文件 <input v-model="source" required aria-label="分发源文件" /></label
        ><button type="button" class="button" @click="pick">选择分发文件</button
        ><label
          >远程目标目录 <input v-model="destination" required aria-label="分发目标目录" /></label
        ><label
          >冲突策略
          <select v-model="conflict" aria-label="分发冲突策略">
            <option value="fail">冲突时报错</option>
            <option value="skip">跳过</option>
            <option value="rename">自动改名</option>
            <option value="overwrite">覆盖</option>
          </select></label
        ><label v-if="conflict === 'overwrite'"
          ><input v-model="overwrite" type="checkbox" />确认覆盖目标现有文件</label
        >
      </div>
      <button class="button primary" :disabled="busy">预览全部目标与操作</button>
    </form>

    <div class="ops-log-tabs" role="tablist" aria-label="批量任务">
      <button
        v-for="b in tasks"
        :key="b.id"
        :data-batch-id="b.id"
        role="tab"
        class="button"
        :aria-selected="currentId === b.id"
        @click="currentId = b.id"
      >
        {{ b.input.operation.kind === 'command' ? '命令' : '分发' }} · {{ b.rows.length }} 台 ·
        {{ b.finished ? '已结束' : '执行中' }} · {{ new Date(b.createdAt).toLocaleTimeString() }}
      </button>
    </div>
    <section v-if="current" class="work-section result-section">
      <h2>
        批量结果 ·
        {{ current.rows.filter((r) => !['queued', 'running'].includes(r.state)).length }} /
        {{ current.rows.length }}
      </h2>
      <p>
        BatchId={{ current.id }} · 并发 {{ current.input.concurrency }} · 每台
        {{ current.input.timeoutSecs }} 秒
      </p>
      <div class="ops-toolbar">
        <button class="button" :disabled="current.finished" @click="cancel(false)">
          取消未执行目标</button
        ><button class="button" :disabled="current.finished" @click="cancel(true)">
          请求停止全部目标</button
        ><button class="button" @click="copy">复制批量结果</button
        ><button
          class="button"
          @click="downloadResult(`serverdeck-batch-${current.id}.json`, current)"
        >
          导出批量结果
        </button>
      </div>
      <p class="subtle">
        输出可能含敏感信息，复制/导出由你主动触发。每台 stdout/stderr 各最多 32
        KiB；超出裁剪最旧内容。文件传输继续使用 SFTP 的哈希校验和安全提交策略。
      </p>
      <article
        v-for="row in current.rows"
        :key="row.hostId"
        class="ops-detail batch-row"
        :data-host-id="row.hostId"
      >
        <h3>{{ label(row.hostId, row.sessionId) }} · {{ taskLabels[row.state] }}</h3>
        <p>
          HostId={{ row.hostId }} · SessionId={{ row.sessionId ?? '未连接' }} · 退出码：{{
            row.exitCode ?? (current.input.operation.kind === 'file' ? '不适用' : '未取得')
          }}
        </p>

        <template v-if="row.transfer"
          ><progress
            :value="row.transfer.transferredBytes"
            :max="row.transfer.totalBytes || 1"
          ></progress>
          <p>
            {{ row.transfer.transferredBytes }} / {{ row.transfer.totalBytes }} 字节 ·
            {{ row.transfer.bytesPerSecond }} B/s · SFTP {{ row.transfer.state }}
          </p>
          <p v-for="p in row.transfer.recoveryPaths" :key="p">待恢复临时文件：{{ p }}</p></template
        >
        <button
          v-if="
            current.finished &&
            current.input.operation.kind === 'file' &&
            ['failed', 'cancelled', 'uncertain'].includes(row.state)
          "
          class="button"
          @click="retry(row)"
        >
          预览重试此文件目标
        </button>
        <details v-if="current.input.operation.kind === 'command'">
          <summary>查看 stdout / stderr（裁剪 {{ row.droppedBytes }} 字节）</summary>
          <h4>stdout</h4>
          <pre class="ops-log-output">{{ row.stdout || '无输出' }}</pre>
          <h4>stderr</h4>
          <pre class="ops-log-output">{{ row.stderr || '无输出' }}</pre>
        </details>
      </article>
    </section>
    <p v-else class="subtle">
      {{ loading ? '正在读取批量任务…' : '暂无批量任务。选择主机、连接并输入操作后预览。' }}
    </p>
    <Modal v-if="preview" title="确认批量运维操作" wide :busy="busy" @close="preview = null"
      ><p class="banner error">
        将以各主机的 SSH 账号执行以下操作。命令可能删除数据或修改服务；应用不会判断任意 Shell
        命令是否安全，也不会自动撤销。
      </p>
      <ul>
        <li v-for="h in preview.labels" :key="h.id">
          {{ hostDisplayName(h) }} · {{ h.username }}@{{ h.hostname }}:{{ h.port }} ·
          {{ h.ready ? '已有连接' : '未连接，将记录失败且不执行' }} · {{ h.id }}
        </li>
      </ul>
      <pre class="ops-log-output">{{
        preview.input.operation.kind === 'command'
          ? preview.input.operation.command
          : JSON.stringify(preview.input.operation, null, 2)
      }}</pre>
      <p>
        并发 {{ preview.input.concurrency }}，每台超时
        {{ preview.input.timeoutSecs }} 秒。超时不能保证远端进程已停止。
      </p>
      <label
        >输入“执行 {{ preview.labels.length }} 台”确认
        <input v-model="phrase" aria-label="批量执行确认文字" autocomplete="off"
      /></label>

      <footer class="dialog-actions">
        <button class="button" :disabled="busy" @click="preview = null">取消</button
        ><button
          class="button danger"
          :disabled="busy || phrase !== `执行 ${preview.labels.length} 台`"
          @click="submit"
        >
          确认执行批量操作
        </button>
      </footer></Modal
    >
  </section>
</template>
