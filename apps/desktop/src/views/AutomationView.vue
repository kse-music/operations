<script setup lang="ts">
import { clipboardApi } from '../services/clipboard';
import { useErrorNotifications } from '../composables/error-notifications';
import { ChevronRight } from '@lucide/vue';
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { automationApi } from '../services/automation';
import { useHostsStore } from '../stores/hosts';
import { useAutomationStore } from '../stores/automation';
import { errorMessage } from '../services/ipc';
import { downloadResult } from '../services/tasks';
import {
  entryInput,
  labels,
  finished,
  offsetLabel,
  type Catalog,
  type Entry,
  type EntryInput,
  type Run,
  type RunSummary,
  type Schedule,
  type State,
} from '../types/automation';
import Modal from '../components/Modal.vue';
import AutomationEntryEditor from '../components/AutomationEntryEditor.vue';
import AutomationRunDialog from '../components/AutomationRunDialog.vue';
import AutomationScheduleDialog from '../components/AutomationScheduleDialog.vue';
const emit = defineEmits<{ intentConsumed: [] }>();
const props = defineProps<{ hostId?: string; entryId?: string }>(),
  hosts = useHostsStore(),
  automation = useAutomationStore();
const catalog = shallowRef<Catalog>({ entries: [], groups: [], schedules: [], templates: [] }),
  tab = ref<'library' | 'schedules' | 'history'>('library'),
  search = ref(''),
  kind = ref('all'),
  group = ref('all'),
  favorite = ref(false),
  loading = ref(true),
  busy = ref(false),
  error = ref(''),
  editor = shallowRef<{ entry?: Entry; template?: EntryInput } | null>(null),
  execute = shallowRef<{ entry: Entry; pendingRun?: Run } | null>(null),
  plan = shallowRef<{ entry: Entry; schedule?: Schedule } | null>(null),
  groupName = ref(''),
  groupId = ref<string | null>(null),
  groupOpen = ref(false);
const historyPlan = ref('');
const history = shallowRef<RunSummary[]>([]),
  selectedRun = shallowRef<Run | null>(null),
  historyState = ref<State | ''>(''),
  historySearch = ref(''),
  historyBusy = ref(false),
  more = ref(false);
const deletion = ref<{
  kind: 'entry' | 'schedule' | 'group' | 'run';
  id: string;
  name: string;
} | null>(null);
const initialHost = computed(() => props.hostId ?? '');
const entries = computed(() =>
  catalog.value.entries
    .filter(
      (e) =>
        (kind.value === 'all' || e.kind === kind.value) &&
        (group.value === 'all' ||
          (group.value === 'none' ? !e.groupId : e.groupId === group.value)) &&
        (!favorite.value || e.favorite) &&
        `${e.name} ${e.description} ${e.body}`.toLowerCase().includes(search.value.toLowerCase()),
    )
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name)),
);
let disposed = false,
  timer: ReturnType<typeof setTimeout> | undefined;
async function load() {
  loading.value = true;
  error.value = '';
  try {
    catalog.value = await automationApi.catalog();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}
watch(
  () => props.entryId,
  (id) => {
    if (!id) return;
    const entry = catalog.value.entries.find((e) => e.id === id);
    if (entry) {
      execute.value = { entry };
      emit('intentConsumed');
    }
  },
);
let paged = false;
let runGeneration = 0;
async function histories(append = false, silent = false) {
  historyBusy.value = true;
  if (!silent) {
    error.value = '';
    paged = append;
  }
  if (append) paged = true;
  try {
    const last = append ? history.value.at(-1) : undefined;
    const rows = await automationApi.history({
      state: historyState.value || undefined,
      search: historySearch.value,
      scheduleId: historyPlan.value || undefined,
      before: last?.createdAt,
      beforeId: last?.id,
    });
    history.value = append ? [...history.value, ...rows] : rows;
    more.value = rows.length === 50;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    historyBusy.value = false;
  }
}
async function inspect(id: string) {
  try {
    const generation = ++runGeneration;
    const run = await automationApi.run(id);
    if (generation === runGeneration) selectedRun.value = run;
    tab.value = 'history';
  } catch (e) {
    error.value = errorMessage(e);
  }
}
async function poll() {
  try {
    if (selectedRun.value && !finished(selectedRun.value.state)) {
      const id = selectedRun.value.id,
        generation = runGeneration;
      const run = await automationApi.run(id);
      if (runGeneration === generation && selectedRun.value?.id === id) selectedRun.value = run;
    }
    if (tab.value === 'history' && !historyBusy.value && !paged) await histories(false, true);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    if (!disposed) timer = setTimeout(() => void poll(), 1500);
  }
}
onMounted(async () => {
  await load();
  const entry = catalog.value.entries.find((e) => e.id === props.entryId);
  if (entry) execute.value = { entry };
  if (props.entryId) emit('intentConsumed');
  await histories();
  if (!disposed) void poll();
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
async function saved() {
  editor.value = null;
  plan.value = null;
  await load();
  void automation.poll();
}
async function started(run: Run) {
  execute.value = null;
  runGeneration++;
  selectedRun.value = run;
  tab.value = 'history';
  await histories();
  void automation.poll();
}
async function toggle(e: Entry) {
  busy.value = true;
  try {
    const input = entryInput(e);
    input.favorite = !input.favorite;
    await automationApi.save(e.id, e.revision, input);
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function disable(p: Schedule) {
  try {
    await automationApi.scheduleDisable(p.id);
    await load();
    void automation.poll();
  } catch (e) {
    error.value = errorMessage(e);
  }
}
function scheduleView(p: Schedule) {
  const status = automation.status?.schedules.find((s) => s.id === p.id);
  return status ? { ...p, ...status } : p;
}
async function groupSave() {
  busy.value = true;
  try {
    await automationApi.groupSave(groupId.value, groupName.value);
    groupId.value = null;
    groupName.value = '';
    await load();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function remove() {
  const d = deletion.value;
  if (!d) return;
  busy.value = true;
  try {
    if (d.kind === 'entry') await automationApi.remove(d.id, true);
    else if (d.kind === 'schedule') await automationApi.scheduleRemove(d.id, true);
    else if (d.kind === 'group') await automationApi.groupRemove(d.id, true);
    else await automationApi.runRemove(d.id, true);
    if (d.kind === 'run' && selectedRun.value?.id === d.id) selectedRun.value = null;
    deletion.value = null;
    await load();
    await histories();
    void automation.poll();
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function cancel(running: boolean) {
  if (!selectedRun.value) return;
  try {
    await automationApi.cancel(selectedRun.value.id, running);
    await inspect(selectedRun.value.id);
    await histories();
  } catch (e) {
    error.value = errorMessage(e);
  }
}
async function copy(value: string) {
  try {
    await clipboardApi.writeText(value);
  } catch (e) {
    error.value = errorMessage(e);
  }
}
useErrorNotifications(() => [
  error.value,
  ...catalog.value.schedules.map((plan) => scheduleView(plan).lastMessage),
  selectedRun.value?.message,
  ...(selectedRun.value?.rows.map((row) => row.message) ?? []),
]);
</script>
<template>
  <section class="operations-view automation-view page-view">
    <header>
      <p class="eyebrow">OPERATIONS AUTOMATION</p>
      <h1>运维任务库</h1>
      <p class="subtle">
        当前服务器：{{
          hosts.catalog?.hosts.find((h) => h.id === initialHost)?.name ?? '未选择'
        }}。复用可信 SSH 上下文，非交互执行；不自动提权、修复或重试。
      </p>
    </header>
    <div class="tabs-heading">
      <div class="ops-tabs" role="tablist" aria-label="自动化工作区">
        <button
          class="button"
          role="tab"
          :aria-selected="tab === 'library'"
          @click="tab = 'library'"
        >
          命令与脚本库</button
        ><button
          class="button"
          role="tab"
          :aria-selected="tab === 'schedules'"
          @click="tab = 'schedules'"
        >
          本地计划</button
        ><button
          class="button"
          role="tab"
          :aria-selected="tab === 'history'"
          @click="
            tab = 'history';
            histories();
          "
        >
          执行历史
        </button>
      </div>
      <button
        class="button"
        @click="
          load();
          histories();
        "
      >
        刷新自动化数据
      </button>
    </div>

    <p v-if="loading" role="status">正在读取任务库…</p>
    <template v-if="tab === 'library'"
      ><div class="ops-toolbar">
        <input
          v-model="search"
          placeholder="搜索名称、描述、正文"
          aria-label="搜索自动化条目"
        /><select v-model="kind" aria-label="条目类型筛选">
          <option value="all">全部类型</option>
          <option value="command">常用命令</option>
          <option value="script">Shell 脚本</option></select
        ><select v-model="group" aria-label="命令分组筛选">
          <option value="all">全部分组</option>
          <option value="none">未分组</option>
          <option v-for="g in catalog.groups" :key="g.id" :value="g.id">
            {{ g.name }}
          </option></select
        ><label><input v-model="favorite" type="checkbox" />只看收藏</label
        ><button class="button primary" @click="editor = {}">新建命令 / 脚本</button
        ><button class="button" @click="groupOpen = true">管理命令分组</button>
      </div>
      <p v-if="!entries.length && !loading" class="subtle automation-library-empty">
        暂无匹配条目。可新建或从下方可审查模板创建，不会自动执行。
      </p>
      <article v-for="e in entries" :key="e.id" class="ops-detail" :data-entry-id="e.id">
        <h3>
          {{ e.favorite ? '★ ' : '' }}{{ e.name }} · {{ e.kind === 'script' ? '脚本' : '命令' }} ·
          {{ e.risk === 'dangerous' ? '危险' : '普通' }}
        </h3>
        <p>{{ e.description }}</p>
        <div class="ops-toolbar">
          <button class="button primary" @click="execute = { entry: e }">快捷执行</button
          ><button class="button" @click="editor = { entry: e }">编辑条目</button
          ><button class="button" :disabled="busy" @click="toggle(e)">
            {{ e.favorite ? '取消收藏' : '收藏条目' }}</button
          ><button
            class="button"
            :disabled="e.parameters.some((p) => p.secret)"
            @click="plan = { entry: e }"
          >
            创建本地计划</button
          ><button class="button" @click="copy(e.body)">复制正文</button
          ><button
            class="button danger"
            @click="deletion = { kind: 'entry', id: e.id, name: e.name }"
          >
            删除条目
          </button>
        </div>
        <details>
          <summary>查看实际正文与参数定义</summary>
          <pre class="ops-log-output">{{ e.body }}</pre>
          <p v-for="(p, i) in e.parameters" :key="p.name">
            ${{ i + 1 }} {{ p.label }} · {{ p.kind }} ·
            {{ p.secret ? '秘密，不保存默认值' : '普通参数' }}
          </p>
        </details>
      </article>
      <section class="automation-templates" aria-label="常用模板">
        <header class="automation-templates-heading">
          <strong>常用模板</strong>
          <span class="subtle">点击模板展开详情，再创建</span>
        </header>
        <div class="automation-template-list">
          <details v-for="t in catalog.templates" :key="t.name" class="automation-template-drawer">
            <summary>
              <ChevronRight :size="16" aria-hidden="true" />
              <strong>{{ t.name }}</strong>
            </summary>
            <div class="automation-template-content">
              <pre class="ops-log-output" tabindex="0" :aria-label="`${t.name}模板正文`">{{
                t.body
              }}</pre>
              <footer>
                <button
                  class="button"
                  :aria-label="`使用“${t.name}”模板`"
                  @click="editor = { template: t }"
                >
                  使用模板
                </button>
              </footer>
            </div>
          </details>
        </div>
      </section></template
    >
    <template v-else-if="tab === 'schedules'"
      ><p class="banner">
        桌面退出、休眠或关机时不能保证执行。到期仅使用已有可信 SSH
        运维连接；错过只跳过或等待手动确认，危险计划每次均需确认。修改正文/参数/执行选项会停用计划。
      </p>
      <p v-if="!catalog.schedules.length && !loading" class="subtle">
        暂无计划。请在库条目中选择“创建本地计划”。
      </p>
      <article
        v-for="p in catalog.schedules"
        :key="p.id"
        class="ops-detail"
        :data-schedule-id="p.id"
      >
        <h3>{{ p.name }} · {{ scheduleView(p).enabled ? '已启用' : '已停用' }}</h3>
        <p>
          {{ p.spec.entry.name }} · {{ JSON.stringify(p.timing) }} ·
          {{ offsetLabel(p.offsetMinutes) }}（固定偏移）
        </p>
        <p>
          下次运行（本机显示）：{{ new Date(scheduleView(p).nextAt).toLocaleString() }} ·
          {{ p.spec.targets.length }} 台 · 错过 {{ p.missedPolicy === 'skip' ? '跳过' : '待确认' }}
        </p>

        <p v-if="p.spec.entry.risk === 'dangerous'" class="danger">危险计划：只生成待确认任务。</p>
        <div class="ops-toolbar">
          <button v-if="scheduleView(p).enabled" class="button" @click="disable(p)">停用计划</button
          ><button
            class="button"
            @click="
              plan = {
                entry: catalog.entries.find((e) => e.id === p.spec.entry.id) ?? p.spec.entry,
                schedule: scheduleView(p),
              }
            "
          >
            编辑 / 重新授权计划</button
          ><button
            class="button danger"
            @click="deletion = { kind: 'schedule', id: p.id, name: p.name }"
          >
            删除计划
          </button>
        </div>
        <button
          class="button"
          @click="
            historyPlan = p.id;
            selectedRun = null;
            tab = 'history';
            histories();
          "
        >
          查看此计划历史
        </button>
        <details>
          <summary>查看授权的实际正文与目标</summary>
          <pre class="ops-log-output">{{ p.spec.entry.body }}</pre>
          <p v-for="t in p.spec.targets" :key="t.hostId">
            {{ t.name }} · {{ t.username }}@{{ t.hostname }}:{{ t.port }}
          </p>
        </details>
      </article></template
    >
    <template v-else>
      <p v-if="historyPlan">
        当前计划：{{ catalog.schedules.find((p) => p.id === historyPlan)?.name ?? historyPlan }}
        <button
          class="text-button"
          @click="
            historyPlan = '';
            histories();
          "
        >
          显示全部任务历史
        </button>
      </p>
      <form class="ops-toolbar" @submit.prevent="histories()">
        <input
          v-model="historySearch"
          maxlength="128"
          placeholder="搜索历史任务名称"
          aria-label="搜索自动化历史"
        /><select v-model="historyState" aria-label="自动化历史状态">
          <option value="">全部状态</option>
          <option v-for="(label, s) in labels" :key="s" :value="s">{{ label }}</option></select
        ><button class="button" :disabled="historyBusy">查询历史</button>
      </form>
      <p v-if="historyBusy" role="status">正在读取历史…</p>
      <p v-else-if="!history.length" class="subtle">暂无执行记录。</p>
      <p class="subtle">
        历史保存于
        SQLite，不自动清理，可主动删除单条已结束记录；默认只保存元数据，保存输出需明确选择。历史较多时请留意本地磁盘空间。
      </p>
      <div class="ops-log-tabs" aria-label="自动化历史列表">
        <button
          v-for="r in history"
          :key="r.id"
          class="button"
          :data-run-id="r.id"
          @click="inspect(r.id)"
        >
          {{ r.entryName }} · {{ r.approvalRequired ? '待手动确认' : labels[r.state] }} ·
          {{ r.targets }} 台 · {{ new Date(r.createdAt).toLocaleString() }}
        </button>
      </div>
      <button v-if="more" class="button" :disabled="historyBusy" @click="histories(true)">
        加载更早历史
      </button>
      <article v-if="selectedRun" class="ops-detail" aria-label="自动化执行详情">
        <h2>
          {{ selectedRun.spec.entry.name }} ·
          {{ selectedRun.approvalRequired ? '待手动确认' : labels[selectedRun.state] }}
        </h2>
        <p>
          RunId={{ selectedRun.id }} · {{ selectedRun.trigger }} ·
          {{ new Date(selectedRun.createdAt).toLocaleString() }}
        </p>
        <p v-if="selectedRun.scheduleId">
          计划：{{
            catalog.schedules.find((p) => p.id === selectedRun!.scheduleId)?.name ??
            selectedRun.scheduleId
          }}
          · 原定触发：{{
            new Date(selectedRun.scheduledFor ?? selectedRun.createdAt).toLocaleString()
          }}
        </p>

        <p class="subtle">
          {{
            selectedRun.spec.hasSecrets
              ? '含秘密参数：不展示/缓存/持久化输出。'
              : selectedRun.spec.entry.retainOutput
                ? '本次输出已选择持久化，每流最多 8 KiB。'
                : '输出仅保留在本次进程的最近任务内；状态、退出码和普通参数会保存。'
          }}超时/断线/请求停止的远端进程可能仍在运行，不自动重试。
        </p>
        <div class="ops-toolbar">
          <button
            v-if="selectedRun.approvalRequired"
            class="button primary"
            @click="execute = { entry: selectedRun.spec.entry, pendingRun: selectedRun }"
          >
            预览并确认待执行任务</button
          ><button class="button" :disabled="finished(selectedRun.state)" @click="cancel(false)">
            取消未开始任务</button
          ><button class="button" :disabled="finished(selectedRun.state)" @click="cancel(true)">
            请求停止在途任务</button
          ><button
            class="button"
            @click="downloadResult(`serverdeck-automation-${selectedRun.id}.json`, selectedRun)"
          >
            导出任务结果</button
          ><button
            class="button danger"
            :disabled="!finished(selectedRun.state)"
            @click="
              deletion = { kind: 'run', id: selectedRun.id, name: selectedRun.spec.entry.name }
            "
          >
            删除此历史
          </button>
        </div>
        <details>
          <summary>实际执行正文与非秘密参数快照</summary>
          <pre class="ops-log-output">{{ selectedRun.spec.entry.body }}</pre>
          <pre>{{ JSON.stringify(selectedRun.spec.parameters, null, 2) }}</pre>
        </details>
        <section
          v-for="row in selectedRun.rows"
          :key="row.hostId"
          class="ops-detail"
          :data-auto-host-id="row.hostId"
        >
          <h3>
            {{ selectedRun.spec.targets.find((t) => t.hostId === row.hostId)?.name ?? row.hostId }}
            · {{ labels[row.state] }}
          </h3>
          <p>
            {{ row.hostId }} · 退出码 {{ row.exitCode ?? '未取得' }} · 已裁剪
            {{ row.droppedBytes }} 字节
          </p>

          <template v-if="!selectedRun.spec.hasSecrets"
            ><h4>stdout</h4>
            <pre class="ops-log-output">{{
              row.stdout || (finished(row.state) ? '无输出 / 未保存输出' : '等待输出…')
            }}</pre>
            <h4>stderr</h4>
            <pre class="ops-log-output">{{ row.stderr || '无错误输出' }}</pre>
          </template>
        </section>
      </article></template
    >
    <AutomationEntryEditor
      v-if="editor"
      :entry="editor.entry"
      :template="editor.template"
      :groups="catalog.groups"
      @close="editor = null"
      @saved="saved"
    /><AutomationRunDialog
      v-if="execute"
      :entry="execute.entry"
      :pending-run="execute.pendingRun"
      :initial-host-id="initialHost"
      @close="execute = null"
      @started="started"
    /><AutomationScheduleDialog
      v-if="plan"
      :entry="plan.entry"
      :schedule="plan.schedule"
      :initial-host-id="initialHost"
      @close="plan = null"
      @saved="saved"
    />
    <Modal v-if="groupOpen" title="命令与脚本分组" :busy="busy" @close="groupOpen = false"
      ><form class="automation-form" @submit.prevent="groupSave">
        <label
          >分组名称<input
            v-model="groupName"
            required
            maxlength="128"
            aria-label="命令分组名称" /></label
        ><button class="button primary" :disabled="busy">
          {{ groupId ? '保存分组名称' : '新增命令分组' }}
        </button>
      </form>

      <div v-for="g in catalog.groups" :key="g.id" class="ops-toolbar">
        <strong>{{ g.name }}</strong
        ><button
          class="button"
          @click="
            groupId = g.id;
            groupName = g.name;
          "
        >
          编辑分组名称</button
        ><button
          class="button danger"
          @click="
            groupOpen = false;
            deletion = { kind: 'group', id: g.id, name: g.name };
          "
        >
          删除分组
        </button>
      </div></Modal
    >
    <Modal v-if="deletion" title="确认删除自动化数据" :busy="busy" @close="deletion = null"
      ><p>
        删除“{{ deletion.name }}”？{{
          deletion.kind === 'entry'
            ? '关联计划会删除，历史保留；已开始任务继续，需另行停止。'
            : deletion.kind === 'group'
              ? '库条目保留并移至未分组。'
              : deletion.kind === 'schedule'
                ? '仅停止未来触发，在途任务需另行停止。'
                : '此历史删除后无法恢复。'
        }}
      </p>

      <footer class="dialog-actions">
        <button class="button" :disabled="busy" @click="deletion = null">取消</button
        ><button class="button danger" :disabled="busy" @click="remove">确认删除自动化数据</button>
      </footer></Modal
    >
  </section>
</template>
