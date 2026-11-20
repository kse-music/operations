<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ListTodo, Play, Plus, Server, Square, Terminal, Trash2 } from '@lucide/vue';
import { tr } from '../i18n/messages';
import { useBatchCommands } from '../composables/useBatchCommands';
import { useApplicationStore } from '../stores/application';
import { filterHosts, useHostsStore } from '../stores/hosts';
import { folderAncestors } from '../services/host-tree';
import { hostDisplayName } from '../types/hosts';
import type { BatchCommand, BatchStatus } from '../types/batch';
import { defaultTerminalPreferences, terminalThemes } from '../types/preferences';
import EnvironmentTagBadge from '../components/EnvironmentTagBadge.vue';
import HostFolderPicker from '../components/HostFolderPicker.vue';
import Modal from '../components/Modal.vue';

const props = defineProps<{ active: boolean }>();
const emit = defineEmits<{ dirty: [boolean] }>();
const hosts = useHostsStore();
const app = useApplicationStore();
const {
  commands,
  current,
  editor,
  editorDirty,
  preview,
  productionCount,
  result,
  visibleResult,
  showingResult,
  running,
  dirty,
  loading,
  busy,
  cancelling,
  listError,
  actionError,
  statusError,
  load,
  activate,
  create,
  cancelNewDraft,
  restoreSaved,
  showEditor,
  hasChanges,
  isRunning,
  save,
  remove,
  runSaved,
  start,
  stop,
  refreshStatus,
} = useBatchCommands();
const deletion = ref<BatchCommand | null>(null);
const productionConfirmed = ref(false);
const inspected = ref('');
const nameField = ref<HTMLInputElement>();
const reviewHeading = ref<HTMLElement>();
const groups = computed(() => hosts.catalog?.groups ?? []);
const environments = computed(() => hosts.catalog?.environmentTags.tags ?? []);
const knownHosts = computed(() =>
  hosts.catalog ? new Set(hosts.catalog.hosts.map(({ id }) => id)) : null,
);
const missingCount = computed(() => editor.value?.hostIds.filter(isMissing).length ?? 0);
const visibleHosts = computed(() => {
  const selected = editor.value;
  if (!selected) return [];
  return filterHosts(hosts.catalog?.hosts ?? [], '').filter(
    (host) =>
      (!selected.folder || folderAncestors(groups.value, host.groupId).includes(selected.folder)) &&
      (!selected.environment || hosts.environmentTag(host.id)?.id === selected.environment),
  );
});
const selectedIds = computed(() => new Set(editor.value?.hostIds));
const visibleSelected = computed(
  () => visibleHosts.value.filter((host) => selectedIds.value.has(host.id)).length,
);
const allVisibleSelected = computed(
  () => visibleHosts.value.length !== 0 && visibleSelected.value === visibleHosts.value.length,
);
const elsewhere = computed(
  () => (editor.value?.hostIds.length ?? 0) - visibleSelected.value - missingCount.value,
);
const output = computed(
  () =>
    visibleResult.value?.results.find((row) => row.target.id === inspected.value) ??
    visibleResult.value?.results[0],
);
const canRetry = computed(() => {
  const run = visibleResult.value;
  return (
    run &&
    current.value?.revision === run.command.revision &&
    run.results.some((row) => row.status === 'connectionFailed')
  );
});
const runSummary = computed(() => {
  const rows = visibleResult.value?.results ?? [];
  const count = (status: BatchStatus) => rows.filter((row) => row.status === status).length;
  return tr(
    '{0} 成功 · {1} 失败 · {2} 结果未知 · {3} 未发送',
    count('succeeded'),
    count('connectionFailed') + count('commandFailed'),
    count('unknown'),
    count('notSent'),
  );
});
const completed = computed(
  () =>
    visibleResult.value?.results.filter(
      (row) => !['queued', 'connecting', 'running'].includes(row.status),
    ).length ?? 0,
);
const shellStyle = computed(() => {
  const prefs = app.state?.config.terminal ?? defaultTerminalPreferences();
  const colors = terminalThemes[prefs.theme];
  return {
    '--batch-shell-bg': colors.background,
    '--batch-shell-text': colors.foreground,
    '--batch-shell-accent': colors.cursor,
    '--batch-shell-font': prefs.fontFamily,
    '--batch-shell-size': `${app.state?.config.terminalFontSize ?? 16}px`,
  };
});
const validDraft = computed(() => {
  const draft = editor.value;
  return Boolean(
    draft?.name.trim() &&
    draft.command.trim() &&
    !missingCount.value &&
    new TextEncoder().encode(draft.command).length <= 8192,
  );
});

watch(dirty, (value) => emit('dirty', value));
watch(preview, async (value) => {
  productionConfirmed.value = false;
  if (!value || !props.active) return;
  await nextTick();
  reviewHeading.value?.focus();
});
watch([() => hosts.catalog, editor], ([catalog, draft]) => {
  if (!catalog || !draft) return;
  if (draft.folder && !catalog.groups.some((group) => group.id === draft.folder))
    draft.folder = null;
  if (!environments.value.some((tag) => tag.id === draft.environment)) draft.environment = '';
});

function isMissing(id: string): boolean {
  return knownHosts.value?.has(id) === false;
}

function runHint(entry: BatchCommand): string {
  if (hasChanges(entry.id)) return tr('保存修改后运行');
  if (!entry.hostIds.length) return tr('请先为命令保存目标主机');
  if (entry.hostIds.some(isMissing)) return tr('部分目标主机已删除，请修改命令的目标主机');
  if (running.value) return tr('另有批次正在执行。');
  return tr('运行 {0}', entry.name);
}

function runDisabled(entry: BatchCommand): boolean {
  return (
    busy.value ||
    running.value ||
    hasChanges(entry.id) ||
    !entry.hostIds.length ||
    entry.hostIds.some(isMissing)
  );
}

async function createCommand(): Promise<void> {
  create();
  await nextTick();
  nameField.value?.focus();
}

function removeMissing(): void {
  if (editor.value) editor.value.hostIds = editor.value.hostIds.filter((id) => !isMissing(id));
}

function setTarget(id: string, checked: boolean): void {
  const selected = editor.value;
  if (!selected) return;
  if (checked && !selectedIds.value.has(id)) {
    selected.hostIds.push(id);
  } else if (!checked) {
    selected.hostIds = selected.hostIds.filter((value) => value !== id);
  }
}

function toggleVisible(checked: boolean): void {
  const draft = editor.value;
  if (!draft) return;
  const visibleIds = new Set(visibleHosts.value.map(({ id }) => id));
  draft.hostIds = checked
    ? [...new Set([...draft.hostIds, ...visibleIds])]
    : draft.hostIds.filter((id) => !visibleIds.has(id));
}

function login(target: { hostname: string; username: string; port: number }): string {
  const host = target.hostname.includes(':') ? `[${target.hostname}]` : target.hostname;
  return `${target.username}@${host}:${target.port}`;
}

function statusLabel(status: BatchStatus): string {
  switch (status) {
    case 'queued':
      return tr('排队中');
    case 'connecting':
      return tr('连接中');
    case 'running':
      return tr('执行中');
    case 'succeeded':
      return tr('成功');
    case 'connectionFailed':
      return tr('连接失败');
    case 'commandFailed':
      return tr('命令失败');
    case 'unknown':
      return tr('结果未知');
    case 'notSent':
      return tr('未发送');
  }
}

async function confirmDeletion(): Promise<void> {
  if (!deletion.value) return;
  await remove(deletion.value);
  if (!actionError.value) deletion.value = null;
}
</script>

<template>
  <section class="batch-workspace" :aria-label="tr('批量命令')" :style="shellStyle">
    <Teleport to="#batch-command-list">
      <section class="batch-library" :aria-label="tr('命令列表')">
        <div class="host-list-heading batch-library-heading">
          <h2>{{ tr('命令列表') }}</h2>
          <button
            class="button"
            type="button"
            :disabled="loading || busy || !commands"
            @click="createCommand"
          >
            <Plus :size="15" aria-hidden="true" />{{ tr('新建') }}
          </button>
        </div>
        <p v-if="loading" class="batch-library-empty" role="status">{{ tr('正在读取命令…') }}</p>
        <p v-else-if="!commands?.length && !listError" class="batch-library-empty">
          {{ tr('暂无已保存的命令') }}
        </p>
        <div class="batch-command-list">
          <div
            v-for="entry in commands"
            :key="entry.id"
            class="batch-command-row"
            :class="{ selected: current?.id === entry.id }"
          >
            <button
              type="button"
              class="batch-command-item"
              :aria-pressed="current?.id === entry.id"
              :title="entry.name"
              :disabled="busy"
              @click="activate(entry.id)"
            >
              <Terminal :size="16" aria-hidden="true" />
              <span class="batch-command-label">{{ entry.name }}</span>
              <span class="batch-command-meta">{{
                tr('{0} 台目标主机', entry.hostIds.length)
              }}</span>
            </button>
            <div class="batch-command-actions">
              <button
                class="icon-button batch-run"
                type="button"
                :title="runHint(entry)"
                :aria-label="tr('运行 {0}', entry.name)"
                :disabled="runDisabled(entry)"
                @click="runSaved(entry)"
              >
                <Play :size="15" aria-hidden="true" />
              </button>
              <button
                class="icon-button"
                type="button"
                :title="tr('删除命令')"
                :aria-label="tr('删除命令 {0}', entry.name)"
                :disabled="busy || isRunning(entry.id)"
                @click="
                  deletion = entry;
                  actionError = null;
                "
              >
                <Trash2 :size="15" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </section>
    </Teleport>
    <div class="workspace-navigation">
      <div class="tabbar workspace-tabs">
        <span class="batch-workspace-label"
          ><ListTodo :size="16" aria-hidden="true" />{{ tr('批量命令') }}</span
        >
      </div>
    </div>
    <div
      class="content-scroll batch-content"
      :class="{ 'batch-content-results': !!visibleResult && !preview }"
      :aria-busy="busy"
    >
      <div v-if="listError" class="banner batch-alert" role="alert">
        <span>{{ listError }}</span>
        <button class="button" type="button" @click="load">{{ tr('重新加载') }}</button>
      </div>
      <div v-if="statusError" class="banner batch-alert" role="alert">
        <span>{{ tr('无法读取批次状态：{0}', statusError) }}</span>
        <button class="button" type="button" @click="refreshStatus">
          {{ tr('刷新执行状态') }}
        </button>
      </div>
      <p v-if="actionError && !deletion" class="error-text" role="alert">{{ actionError }}</p>

      <section v-if="preview" class="batch-flow">
        <h2 ref="reviewHeading" tabindex="-1">{{ tr('确认发送') }}</h2>
        <div class="batch-command-preview">
          <div class="batch-row">
            <strong>{{ preview.command.name }}</strong
            ><span class="muted">{{ tr('并发上限 {0} 台', preview.concurrency) }}</span>
          </div>
          <pre class="batch-shell" dir="ltr">{{ preview.command.command }}</pre>
        </div>
        <h3>{{ tr('目标主机 · {0} 台', preview.targets.length) }}</h3>
        <div class="batch-table-scroll">
          <table class="batch-table" :aria-label="tr('确认发送的目标主机')">
            <thead>
              <tr>
                <th scope="col">{{ tr('主机') }}</th>
                <th scope="col">{{ tr('SSH 登录') }}</th>
                <th scope="col">{{ tr('环境标签') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="target in preview.targets" :key="target.id">
                <td>{{ target.name }}</td>
                <td>
                  <code dir="ltr">{{ login(target) }}</code>
                </td>
                <td><EnvironmentTagBadge :tag="target.environment ?? undefined" /></td>
              </tr>
            </tbody>
          </table>
        </div>
        <label v-if="productionCount" class="banner batch-confirm">
          <input v-model="productionConfirmed" type="checkbox" :disabled="busy" />
          {{ tr('我已核对本次选中的 {0} 台生产主机', productionCount) }}
        </label>
        <div class="batch-row">
          <button class="button" type="button" :disabled="busy" @click="preview = null">
            {{ tr('返回修改') }}
          </button>
          <button
            class="button primary"
            type="button"
            :disabled="busy || (!!productionCount && !productionConfirmed)"
            @click="start(productionConfirmed)"
          >
            {{ tr('发送到 {0} 台主机', preview.targets.length) }}
          </button>
        </div>
      </section>

      <section v-else-if="visibleResult" class="batch-flow batch-result-view">
        <div class="batch-row">
          <h2>{{ tr('执行结果') }}</h2>
          <div class="action-row">
            <button
              v-if="!visibleResult.finished"
              class="button"
              type="button"
              :disabled="cancelling || visibleResult.stopping"
              @click="stop(visibleResult)"
            >
              <Square :size="14" aria-hidden="true" />{{
                visibleResult.stopping ? tr('正在停止…') : tr('停止执行')
              }}
            </button>
            <template v-else>
              <button class="button" type="button" :disabled="busy" @click="showEditor">
                {{ tr('返回命令') }}
              </button>
              <button
                v-if="canRetry && current"
                class="button"
                type="button"
                :disabled="runDisabled(current)"
                @click="runSaved(current, visibleResult)"
              >
                {{ tr('重试连接失败') }}
              </button>
            </template>
          </div>
        </div>
        <div class="batch-row batch-run-summary">
          <div class="batch-run-command">
            <strong>{{ visibleResult.command.name }}</strong>
            <pre class="batch-shell" dir="ltr">{{ visibleResult.command.command }}</pre>
          </div>
          <span role="status" class="muted">{{
            visibleResult.finished
              ? runSummary
              : tr('已处理 {0} / {1} 台', completed, visibleResult.results.length)
          }}</span>
        </div>
        <div class="batch-results">
          <div class="batch-result-hosts">
            <table class="batch-table" :aria-label="tr('逐台执行结果')">
              <thead>
                <tr>
                  <th scope="col">{{ tr('主机') }}</th>
                  <th scope="col">{{ tr('状态') }}</th>
                  <th scope="col">{{ tr('退出码') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in visibleResult.results"
                  :key="row.target.id"
                  :class="{ 'batch-inspected': output?.target.id === row.target.id }"
                >
                  <td>
                    <button
                      class="batch-inspect"
                      type="button"
                      :aria-pressed="output?.target.id === row.target.id"
                      @click="inspected = row.target.id"
                    >
                      {{ row.target.name }}
                    </button>
                  </td>
                  <td>
                    <span class="batch-state" :data-state="row.status">{{
                      statusLabel(row.status)
                    }}</span>
                  </td>
                  <td>{{ row.exitCode ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <section v-if="output" class="batch-output">
            <header class="batch-output-header">
              <div class="batch-row">
                <h3>{{ output.target.name }}</h3>
                <EnvironmentTagBadge :tag="output.target.environment ?? undefined" />
              </div>
              <code class="muted" dir="ltr">{{ login(output.target) }}</code>
            </header>
            <div
              :key="`${visibleResult.id}:${output.target.id}`"
              class="batch-output-scroll"
              tabindex="0"
              role="region"
              :aria-label="tr('主机命令输出')"
            >
              <p v-if="output.message" class="muted">{{ tr(output.message) }}</p>
              <section v-if="output.stdout" class="batch-output-stream">
                <h4>{{ tr('标准输出') }}</h4>
                <pre dir="ltr">{{ output.stdout }}</pre>
              </section>
              <section v-if="output.stderr" class="batch-output-stream batch-output-error">
                <h4>{{ tr('错误输出') }}</h4>
                <pre dir="ltr">{{ output.stderr }}</pre>
              </section>
              <p v-if="output.truncated" class="muted">
                {{ tr('输出超过 16 KiB，已截断显示。') }}
              </p>
              <p v-if="!output.stdout && !output.stderr && !output.message" class="muted">
                {{ tr('暂无输出') }}
              </p>
            </div>
          </section>
        </div>
      </section>

      <form v-else-if="editor" class="batch-flow batch-edit" @submit.prevent="save">
        <div class="batch-row">
          <h2>{{ editor.previous ? tr('命令配置') : tr('新建命令') }}</h2>
          <button v-if="result" class="button" type="button" @click="showingResult = true">
            {{ tr('查看执行结果') }}
          </button>
        </div>
        <div class="batch-editor-grid">
          <section class="batch-fields batch-command-fields" :aria-label="tr('命令配置')">
            <label class="batch-field">
              <span>{{ tr('命令名称') }}</span>
              <input
                ref="nameField"
                v-model="editor.name"
                maxlength="128"
                :disabled="busy"
                required
              />
            </label>
            <label class="batch-field batch-command-field">
              <span>{{ tr('SSH 命令') }}</span>
              <span class="batch-shell batch-shell-editor">
                <span aria-hidden="true" class="batch-prompt">$</span>
                <textarea
                  v-model="editor.command"
                  rows="10"
                  dir="ltr"
                  autocapitalize="off"
                  autocomplete="off"
                  spellcheck="false"
                  :disabled="busy"
                  :placeholder="tr('例如 df -h /')"
                  required
                ></textarea>
              </span>
            </label>
          </section>
          <section class="batch-fields batch-target-fields" :aria-label="tr('目标主机')">
            <div class="batch-row">
              <h3>{{ tr('目标主机') }}</h3>
              <span class="muted" role="status"
                >{{ tr('已选 {0} 台', editor.hostIds.length)
                }}<template v-if="elsewhere">
                  · {{ tr('其中 {0} 台在当前筛选范围外', elsewhere) }}</template
                ></span
              >
            </div>
            <div v-if="hosts.catalog?.hosts.length || current" class="batch-filters">
              <template v-if="hosts.catalog?.hosts.length">
                <div class="batch-folder-filter">
                  <HostFolderPicker
                    id="batch-folder-filter"
                    v-model="editor.folder"
                    :label="tr('目录')"
                    :root-label="tr('全部目录')"
                    :groups="groups"
                    :disabled="busy || !active"
                  />
                </div>
                <select v-model="editor.environment" :aria-label="tr('环境标签')" :disabled="busy">
                  <option value="">{{ tr('全部环境') }}</option>
                  <option v-for="tag in environments" :key="tag.id" :value="tag.id">
                    {{ tag.name }}
                  </option>
                </select>
              </template>
              <button
                v-if="current"
                class="button batch-restore"
                type="button"
                :disabled="busy || !editorDirty"
                @click="restoreSaved"
              >
                {{ tr('还原') }}
              </button>
            </div>
            <div v-if="missingCount" class="banner batch-alert" role="status">
              <span>{{ tr('{0} 台已保存的目标主机已删除', missingCount) }}</span>
              <button class="button" type="button" :disabled="busy" @click="removeMissing">
                {{ tr('移除失效主机') }}
              </button>
            </div>
            <div v-if="!hosts.catalog && hosts.error" class="banner batch-alert" role="alert">
              <span>{{ hosts.error }}</span>
              <button class="button" type="button" :disabled="hosts.busy" @click="hosts.load">
                {{ tr('重新加载主机') }}
              </button>
            </div>
            <p v-else-if="!hosts.catalog" class="muted" role="status">
              {{ tr('正在读取主机目录…') }}
            </p>
            <p v-else-if="!hosts.catalog.hosts.length" class="muted">
              {{ tr('暂无主机，请先在主机管理中添加。') }}
            </p>
            <p v-else-if="!visibleHosts.length" class="muted">{{ tr('当前筛选范围内没有主机') }}</p>
            <div
              v-else
              class="batch-table-scroll batch-picker-scroll"
              tabindex="0"
              :aria-label="tr('选择目标主机')"
            >
              <table class="batch-table" :aria-label="tr('选择目标主机')">
                <thead>
                  <tr>
                    <th scope="col" class="batch-check">
                      <input
                        type="checkbox"
                        :aria-label="tr('全选当前筛选范围的主机')"
                        :checked="allVisibleSelected"
                        :indeterminate="visibleSelected > 0 && !allVisibleSelected"
                        :disabled="busy"
                        @change="toggleVisible(($event.target as HTMLInputElement).checked)"
                      />
                    </th>
                    <th scope="col">{{ tr('主机') }}</th>
                    <th scope="col">{{ tr('SSH 登录') }}</th>
                    <th scope="col">{{ tr('环境标签') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="host in visibleHosts" :key="host.id">
                    <td class="batch-check">
                      <input
                        type="checkbox"
                        :aria-label="tr('选择主机 {0}', hostDisplayName(host))"
                        :checked="selectedIds.has(host.id)"
                        :disabled="busy"
                        @change="setTarget(host.id, ($event.target as HTMLInputElement).checked)"
                      />
                    </td>
                    <td><Server :size="14" aria-hidden="true" /> {{ hostDisplayName(host) }}</td>
                    <td>
                      <code dir="ltr">{{ login(host) }}</code>
                    </td>
                    <td><EnvironmentTagBadge :tag="hosts.environmentTag(host.id)" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <footer class="batch-row batch-editor-actions">
          <label class="batch-filter">
            <span>{{ tr('并发上限') }}</span>
            <select v-model.number="editor.concurrency" :disabled="busy">
              <option v-for="limit in [1, 3, 5]" :key="limit" :value="limit">
                {{ tr('{0} 台', limit) }}
              </option>
            </select>
          </label>
          <div class="action-row">
            <button
              v-if="!editor.previous"
              class="button"
              type="button"
              :disabled="busy"
              @click="cancelNewDraft"
            >
              {{ tr('取消') }}
            </button>
            <button
              class="button primary"
              type="submit"
              :disabled="busy || !validDraft || !editorDirty"
            >
              {{ tr('保存') }}
            </button>
            <button
              class="button"
              type="button"
              :title="current ? runHint(current) : tr('保存修改后运行')"
              :disabled="!current || runDisabled(current)"
              @click="current && runSaved(current)"
            >
              <Play :size="15" aria-hidden="true" />{{ tr('运行') }}
            </button>
          </div>
        </footer>
      </form>

      <section v-else-if="commands && !listError" class="batch-empty">
        <Terminal :size="26" aria-hidden="true" />
        <h2>{{ tr('新建批量命令') }}</h2>
        <p class="muted">{{ tr('保存命令和目标主机，下次可从列表直接运行。') }}</p>
        <button
          class="button primary"
          type="button"
          :disabled="busy || loading"
          @click="createCommand"
        >
          <Plus :size="16" aria-hidden="true" />{{ tr('新建命令') }}
        </button>
      </section>
    </div>
    <Modal
      v-if="active && deletion"
      :title="tr('删除命令')"
      :busy="busy"
      focus-heading
      @close="deletion = null"
    >
      <p>{{ tr('删除已保存的命令“{0}”？', deletion.name) }}</p>
      <p v-if="actionError" class="error-text" role="alert">{{ actionError }}</p>
      <div class="dialog-actions">
        <button class="button" type="button" :disabled="busy" @click="deletion = null">
          {{ tr('取消') }}
        </button>
        <button class="button danger" type="button" :disabled="busy" @click="confirmDeletion">
          {{ tr('删除') }}
        </button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.batch-workspace {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  flex: 1;
}
.batch-workspace-label {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  padding: 0 14px;
  background: var(--panel);
  border-top: 2px solid var(--accent);
}
.batch-workspace-label svg,
.batch-command-item svg {
  color: var(--accent);
  flex-shrink: 0;
}
.batch-library {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.batch-library-heading {
  gap: 8px;
}
.batch-library-heading .button {
  padding-inline: 8px;
}
.batch-command-list {
  min-height: 0;
  display: grid;
  align-content: start;
  gap: 3px;
  overflow-y: auto;
  padding: 5px 8px;
}
.batch-library-empty {
  color: var(--muted);
  padding: 4px 12px;
}
.batch-command-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  min-width: 0;
  padding-right: 4px;
  border-radius: 5px;
}
.batch-command-row:hover {
  background: var(--hover);
}
.batch-command-row.selected {
  background: var(--accent-bg);
}
.batch-command-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.batch-command-actions .icon-button {
  width: var(--compact-height);
  height: var(--compact-height);
}
.batch-run {
  color: var(--accent);
}
.batch-command-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 2px 8px;
  min-width: 0;
  padding: 8px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  text-align: left;
}
.batch-command-item[aria-pressed='true'] {
  color: var(--accent);
}
.batch-command-meta {
  grid-column: 2;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.batch-command-label,
.batch-command-meta {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.batch-content {
  width: 100%;
  min-height: 0;
  overflow: auto;
  container-type: inline-size;
}
.batch-content > .banner,
.batch-content > .error-text {
  margin-bottom: 10px;
}
.batch-flow {
  display: grid;
  align-content: start;
  gap: 12px;
}
.batch-flow :is(h2, h3, p),
.batch-empty :is(h2, p) {
  margin: 0;
  overflow-wrap: anywhere;
}
.batch-flow h2,
.batch-empty h2 {
  font-size: var(--font-size-title);
}
.batch-flow h3 {
  font-size: var(--font-size-body);
}
.batch-row,
.batch-filters,
.batch-filter,
.batch-alert,
.batch-confirm {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.batch-row,
.batch-alert {
  justify-content: space-between;
}
.batch-field {
  display: grid;
  gap: 6px;
}
.batch-field > span,
.batch-filter > span {
  font-weight: 600;
}
.batch-filter select,
.batch-filters > select {
  max-width: min(20rem, 100%);
}
.batch-folder-filter {
  min-width: 0;
  max-width: 100%;
}
.batch-folder-filter :deep(.host-folder-picker) {
  width: clamp(132px, 16vw, 205px);
  max-width: 100%;
  min-height: var(--control-height);
}
.batch-restore {
  margin-left: auto;
}
.batch-edit {
  max-width: 1440px;
}
.batch-editor-grid,
.batch-fields {
  display: grid;
  align-content: start;
  min-width: 0;
  gap: 12px;
}
.batch-editor-grid {
  --batch-target-padding: 12px;
  grid-template-columns: minmax(0, 1fr);
}
.batch-target-fields {
  padding: var(--batch-target-padding);
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
}
.batch-picker-scroll {
  max-height: min(42vh, 420px);
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 5px;
}
.batch-picker-scroll th {
  position: sticky;
  top: 0;
  background: var(--panel);
}
.batch-picker-scroll td {
  padding-block: 6px;
}
.batch-picker-scroll td:nth-child(2) svg {
  vertical-align: middle;
}
.batch-editor-actions {
  position: sticky;
  bottom: 0;
  z-index: 1;
  padding-block: 10px;
  border-top: 1px solid var(--border);
  background: var(--bg);
}
.batch-editor-actions .action-row {
  flex-wrap: wrap;
  margin-left: auto;
}
@container (min-width: 880px) {
  .batch-editor-grid {
    grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
    gap: 18px;
  }
  .batch-editor-grid:has(.batch-picker-scroll) .batch-command-fields,
  .batch-editor-grid:has(.batch-picker-scroll) .batch-command-field {
    grid-template-rows: auto minmax(0, 1fr);
  }
  .batch-editor-grid:has(.batch-picker-scroll) .batch-command-fields {
    padding-bottom: calc(var(--batch-target-padding) + 1px);
  }
  .batch-editor-grid:has(.batch-picker-scroll) .batch-shell-editor textarea {
    height: 0;
    min-height: 100%;
    resize: none;
  }
  .batch-picker-scroll {
    min-height: 240px;
  }
}
.batch-shell {
  background: var(--batch-shell-bg);
  color: var(--batch-shell-text);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: var(--batch-shell-font);
}
pre.batch-shell {
  min-width: 0;
  margin: 0;
  padding: 10px 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
}
.batch-shell-editor {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  padding: 12px 14px;
  font-size: var(--batch-shell-size);
  line-height: 1.55;
}
.batch-shell-editor:focus-within {
  outline: 2px solid var(--batch-shell-accent);
  outline-offset: -2px;
}
.batch-shell-editor textarea {
  display: block;
  min-height: 240px;
  width: 100%;
  padding: 0;
  border: 0;
  outline: 0;
  font: inherit;
  color: inherit;
  caret-color: var(--batch-shell-accent);
  background: transparent;
  resize: vertical;
}
.batch-shell-editor textarea::placeholder {
  color: color-mix(in srgb, var(--batch-shell-text) 65%, var(--batch-shell-bg));
}
.batch-prompt {
  color: var(--batch-shell-accent);
  font-weight: 600;
  user-select: none;
}
.batch-command-preview {
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  min-width: 0;
}
.batch-command-preview > .batch-shell {
  margin-top: 6px;
  max-height: 200px;
  overflow: auto;
}
.batch-table-scroll {
  overflow-x: auto;
}
.batch-table {
  border-collapse: collapse;
  width: 100%;
}
.batch-table :is(th, td) {
  padding: 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  overflow-wrap: anywhere;
}
.batch-table th {
  color: var(--muted);
  background: var(--panel);
  font-weight: 600;
}
.batch-table code {
  white-space: nowrap;
}
.batch-check {
  width: 1%;
}
.batch-confirm {
  justify-content: flex-start;
}
.batch-content-results,
.batch-result-view {
  display: flex;
  flex-direction: column;
}
.batch-result-view {
  flex: 1;
  min-height: 0;
}
.batch-result-view > .batch-row {
  flex: none;
}
.batch-run-summary {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  font-variant-numeric: tabular-nums;
}
.batch-run-command {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
  gap: 6px 10px;
  overflow-wrap: anywhere;
}
.batch-run-command > .batch-shell {
  max-width: 100%;
  max-height: 4em;
  padding: 3px 8px;
  overflow: auto;
  scrollbar-width: thin;
}
.batch-results {
  display: grid;
  grid-template-columns: clamp(230px, 28%, 340px) minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr);
  flex: 1;
  min-block-size: 240px;
  gap: 12px;
}
.batch-result-hosts,
.batch-output {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
}
.batch-result-hosts,
.batch-output-scroll {
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
  overscroll-behavior: contain;
}
.batch-result-hosts {
  align-self: start;
  max-height: 100%;
}
.batch-result-hosts th {
  position: sticky;
  top: 0;
  white-space: nowrap;
}
.batch-result-hosts :is(th, td) {
  padding-block: 6px;
}
.batch-result-hosts :is(th, td):not(:first-child) {
  width: 1%;
  font-variant-numeric: tabular-nums;
}
.batch-result-hosts tr:last-child td {
  border-bottom: 0;
}
.batch-inspect {
  border: 0;
  background: transparent;
  padding: 4px 0;
  min-height: var(--compact-height);
  color: inherit;
  text-align: left;
  overflow-wrap: anywhere;
}
.batch-inspected {
  background: var(--accent-bg);
}
.batch-inspected .batch-inspect {
  color: var(--accent);
}
.batch-state {
  white-space: nowrap;
}
.batch-state[data-state='succeeded'] {
  color: var(--accent);
}
.batch-state:is([data-state='connectionFailed'], [data-state='commandFailed']) {
  color: var(--error);
}
.batch-state[data-state='unknown'] {
  color: light-dark(#805716, #e8c17b);
}
.batch-output {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.batch-output-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 12px;
  flex: none;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
}
.batch-output-header > .batch-row {
  justify-content: flex-start;
}
.batch-output-header code {
  min-width: 0;
  overflow-wrap: anywhere;
}
.batch-output-scroll {
  flex: 1;
  min-height: 0;
  padding: 10px 12px;
  background: var(--batch-shell-bg);
  color: var(--batch-shell-text);
}
.batch-output-scroll .muted,
.batch-output-stream h4 {
  color: color-mix(in srgb, var(--batch-shell-text) 80%, var(--batch-shell-bg));
}
.batch-output-scroll > * + * {
  margin-top: 12px;
}
.batch-output-stream h4 {
  margin: 0 0 6px;
  font-size: var(--font-size-caption);
}
.batch-output-stream pre {
  margin: 0;
  color: inherit;
  font-family: var(--batch-shell-font);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
}
.batch-output-error {
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--batch-shell-text) 18%, transparent);
}
.batch-empty {
  display: grid;
  justify-items: center;
  align-content: center;
  text-align: center;
  gap: 12px;
  min-height: 240px;
  padding: 20px;
}
.batch-empty svg {
  color: var(--muted);
}
@container (max-width: 660px) {
  .batch-result-view,
  .batch-results {
    gap: 8px;
  }
  .batch-run-summary {
    padding-block: 4px;
  }
  .batch-results {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    min-block-size: 330px;
  }
  .batch-result-hosts {
    max-height: 136px;
  }
  .batch-result-hosts :is(th, td) {
    padding-block: 4px;
  }
}
</style>
