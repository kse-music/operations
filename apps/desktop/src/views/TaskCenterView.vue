<script setup lang="ts">
import { useErrorNotifications } from '../composables/error-notifications';
import { computed, onMounted, ref } from 'vue';
import Modal from '../components/Modal.vue';
import TransferPanel from '../components/TransferPanel.vue';
import { useBackgroundStore } from '../stores/background';
import { useAutomationStore } from '../stores/automation';
import { useHostsStore } from '../stores/hosts';
import { tasksApi } from '../services/tasks';
import { automationApi } from '../services/automation';
import { labels, type RunSummary } from '../types/automation';
import { errorMessage } from '../services/ipc';
import { taskLabels } from '../types/tasks';
import type { BackgroundTask, WorkspaceView } from '../types/product';
import { hostDisplayName } from '../types/hosts';
const emit = defineEmits<{ navigate: [view: WorkspaceView, hostId?: string] }>();
const background = useBackgroundStore(),
  automation = useAutomationStore(),
  hosts = useHostsStore(),
  stopping = ref<BackgroundTask | null>(null),
  error = ref('');
const tasks = computed(() => [...background.tasks].reverse());
const schedules = ref<{ id: string; name: string; enabled: boolean }[]>([]),
  runs = ref<RunSummary[]>([]),
  loadingControls = ref(true),
  controlsError = ref(''),
  controlBusy = ref(false),
  control = ref<{ kind: 'schedule' | 'run'; id: string; name: string; running: boolean } | null>(
    null,
  );
const cursors = ref<{ Pending: RunSummary | null; Running: RunSummary | null }>({
  Pending: null,
  Running: null,
});
const moreRuns = computed(() => !!cursors.value.Pending || !!cursors.value.Running);
async function readRuns(append = false) {
  const pages = await Promise.all(
    (['Pending', 'Running'] as const).map(async (state) => {
      const cursor = append ? cursors.value[state] : null;
      if (append && !cursor) return [];
      const page = await automationApi.history({
        state,
        ...(cursor ? { before: cursor.createdAt, beforeId: cursor.id } : {}),
      });
      cursors.value[state] = page.length === 50 ? page.at(-1)! : null;
      return page;
    }),
  );
  runs.value = [
    ...new Map(
      [...(append ? runs.value : []), ...pages.flat()].map((run) => [run.id, run]),
    ).values(),
  ].filter((run) => run.state === 'Pending' || run.state === 'Running');
}
async function loadMoreRuns() {
  loadingControls.value = true;
  try {
    await readRuns(true);
    controlsError.value = '';
  } catch (e) {
    controlsError.value = errorMessage(e);
  } finally {
    loadingControls.value = false;
  }
}
async function refreshControls() {
  loadingControls.value = true;
  try {
    const [catalog] = await Promise.all([automationApi.catalog(), readRuns()]);
    schedules.value = catalog.schedules.map(({ id, name, enabled }) => ({ id, name, enabled }));
    controlsError.value = '';
  } catch (e) {
    controlsError.value = errorMessage(e);
  } finally {
    loadingControls.value = false;
  }
}
async function stopAutomation() {
  const selected = control.value;
  if (!selected || controlBusy.value) return;
  controlBusy.value = true;
  try {
    if (selected.kind === 'schedule') await automationApi.scheduleDisable(selected.id);
    else await automationApi.cancel(selected.id, selected.running);
    control.value = null;
    await Promise.all([refreshControls(), automation.poll()]);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    controlBusy.value = false;
  }
}
onMounted(refreshControls);
function names(ids: string[]) {
  return ids.map((id) => {
    const h = hosts.catalog?.hosts.find((h) => h.id === id);
    return h
      ? `${hostDisplayName(h)} · HostId=${h.id} · 当前配置 ${h.username}@${h.hostname}:${h.port}`
      : id;
  });
}
function open(view: WorkspaceView, hostId = '') {
  emit('navigate', view, hostId);
}
async function stop() {
  if (!stopping.value) return;
  try {
    const t = stopping.value;
    if (t.kind === 'diagnostic') await tasksApi.stop(t.id);
    else await tasksApi.cancel(t.id, true);
    stopping.value = null;
  } catch (e) {
    error.value = errorMessage(e);
  }
}
useErrorNotifications(error);
</script>
<template>
  <section class="page-view" aria-label="任务中心">
    <header class="section-heading"><h1>任务中心</h1></header>
    <p class="subtle">
      统一查看文件传输、网络诊断、批量运维和自动化任务。关闭此页面不会停止任务；停止在途远端命令后仍需核对实际状态。
    </p>

    <TransferPanel @retry="(t) => open('files', t.hostId)" />
    <section class="work-section" aria-label="网络与批量任务">
      <div class="section-heading">
        <h2>网络与批量任务</h2>
        <span>{{ background.pending }} 个活动任务</span>
      </div>
      <p v-if="background.connections === null && !background.error" role="status">
        正在读取后台任务…
      </p>
      <p v-else-if="background.error && !tasks.length" class="subtle">后台任务暂不可用</p>
      <p v-else-if="!tasks.length" class="host-empty">没有网络或批量任务</p>
      <article v-for="t in tasks" :key="t.id" class="ops-detail">
        <strong>{{ t.label }} · {{ taskLabels[t.state] ?? t.state }}</strong>
        <ul v-if="t.hostIds.length">
          <li v-for="name in names(t.hostIds)" :key="name">{{ name }}</li>
        </ul>
        <p v-else>执行来源：本机</p>
        <div class="action-row">
          <button
            class="button"
            @click="open(t.kind === 'batch' ? 'batch' : 'network', t.hostIds[0])"
          >
            查看任务结果</button
          ><button v-if="t.active" class="button" @click="stopping = t">请求停止此任务</button>
        </div>
      </article>
    </section>
    <section class="work-section" aria-label="自动化任务">
      <h2>自动化任务</h2>
      <p v-if="!automation.status && !automation.error" role="status">正在读取自动化状态…</p>
      <p v-else-if="!automation.status" class="subtle">自动化状态暂不可用</p>
      <p v-else>
        {{ automation.status.active }} 个活动任务，{{ automation.status.awaiting }}
        个待确认。
      </p>
      <button class="button" @click="open('automation', hosts.selectedId ?? '')">
        查看自动化历史与全部目标
      </button>
      <p class="subtle">
        已提交的任务和计划由任务中心继续管理，停用或卸载插件后仍可在这里请求停止或暂停。
      </p>
      <p v-if="loadingControls" role="status">正在读取任务与计划…</p>
      <div v-else-if="controlsError" role="alert">
        <p>{{ controlsError }}</p>
        <button class="button" @click="refreshControls">重新读取任务与计划</button>
      </div>
      <template v-else>
        <div class="action-row">
          <button class="button" @click="refreshControls">刷新任务与计划</button>
        </div>
        <p v-if="!runs.length && !schedules.length" class="host-empty">
          没有活动的自动化任务或计划
        </p>
        <article v-for="run in runs" :key="run.id" class="ops-detail">
          <strong>{{ run.entryName }} · {{ labels[run.state] }}</strong>
          <p>{{ run.id }} · {{ run.targets }} 个目标</p>
          <button
            class="button"
            @click="
              control = {
                kind: 'run',
                id: run.id,
                name: run.entryName,
                running: run.state === 'Running',
              }
            "
          >
            请求停止自动化任务
          </button>
        </article>
        <button v-if="moreRuns" class="button" @click="loadMoreRuns">加载更多活动任务</button>
        <article v-for="schedule in schedules" :key="schedule.id" class="ops-detail">
          <strong
            >{{ schedule.name }} · {{ schedule.enabled ? '计划已启用' : '计划已暂停' }}</strong
          >
          <button
            v-if="schedule.enabled"
            class="button"
            @click="
              control = { kind: 'schedule', id: schedule.id, name: schedule.name, running: false }
            "
          >
            暂停计划
          </button>
        </article>
      </template>
    </section>
  </section>
  <Modal v-if="stopping" title="确认停止后台任务" @close="stopping = null"
    ><p>{{ stopping.label }} · {{ stopping.id }}</p>
    <ul>
      <li v-for="name in names(stopping.hostIds)" :key="name">{{ name }}</li>
    </ul>
    <p>将取消排队并请求停止在途操作；远端进程可能仍在运行，已提交文件不会回滚。</p>
    <footer class="dialog-actions">
      <button class="button" @click="stopping = null">继续执行</button
      ><button class="button danger" @click="stop">确认请求停止</button>
    </footer></Modal
  >
  <Modal
    v-if="control"
    :title="control.kind === 'schedule' ? '确认暂停自动化计划' : '确认停止自动化任务'"
    @close="!controlBusy && (control = null)"
  >
    <p>{{ control.name }} · {{ control.id }}</p>
    <p v-if="control.kind === 'schedule'">
      暂停后不再按此计划提交新任务，已经提交的任务需要单独停止。
    </p>
    <p v-else>将取消排队并请求停止在途操作；远端进程可能仍在运行，请核对实际状态。</p>
    <footer class="dialog-actions">
      <button class="button" :disabled="controlBusy" @click="control = null">继续执行</button>
      <button class="button danger" :disabled="controlBusy" @click="stopAutomation">
        {{ control.kind === 'schedule' ? '确认暂停计划' : '确认停止任务' }}
      </button>
    </footer>
  </Modal>
</template>
