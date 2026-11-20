<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ListTodo, Pencil, Plus, Server, Square, Terminal, Trash2 } from '@lucide/vue';
import { tr } from '../i18n/messages';
import { useBatchCommands } from '../composables/useBatchCommands';
import { useApplicationStore } from '../stores/application';
import { filterHosts, useHostsStore } from '../stores/hosts';
import { folderAncestors, folderPath } from '../services/host-tree';
import { hostDisplayName } from '../types/hosts';
import { batchTargetLimit, type BatchCommand, type BatchStatus } from '../types/batch';
import { defaultTerminalPreferences, terminalThemes } from '../types/preferences';
import EnvironmentTagBadge from '../components/EnvironmentTagBadge.vue';
import Modal from '../components/Modal.vue';

const props = defineProps<{ active: boolean }>();
const emit = defineEmits<{ dirty: [boolean] }>();
const hosts = useHostsStore();
const app = useApplicationStore();
const {
  commands,
  current,
  selection,
  selections,
  editor,
  preview,
  visibleResult,
  showingTargets,
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
  edit,
  save,
  remove,
  prepare,
  start,
  stop,
  refreshStatus,
} = useBatchCommands();
const deletion = ref<BatchCommand | null>(null);
const commandControlsDisabled = computed(
  () =>
    loading.value ||
    busy.value ||
    !!editor.value ||
    !!preview.value ||
    Boolean(visibleResult.value && !visibleResult.value.finished),
);
const productionConfirmed = ref(false);
const inspected = ref('');
const nameField = ref<HTMLInputElement>();
const reviewHeading = ref<HTMLElement>();
const groups = computed(() => hosts.catalog?.groups ?? []);
const environments = computed(() => hosts.catalog?.environmentTags.tags ?? []);
const directoryOptions = computed(() =>
  groups.value.map((folder) => ({ id: folder.id, label: folderPath(groups.value, folder.id) })),
);
const visibleHosts = computed(() => {
  const selected = selection.value;
  if (!selected) return [];
  return filterHosts(hosts.catalog?.hosts ?? [], '').filter(
    (host) =>
      (!selected.folder || folderAncestors(groups.value, host.groupId).includes(selected.folder)) &&
      (!selected.environment || hosts.environmentTag(host.id)?.id === selected.environment),
  );
});
const visibleSelected = computed(
  () => visibleHosts.value.filter((host) => selection.value?.hostIds.includes(host.id)).length,
);
const allVisibleSelected = computed(
  () => visibleHosts.value.length !== 0 && visibleSelected.value === visibleHosts.value.length,
);
const elsewhere = computed(() => (selection.value?.hostIds.length ?? 0) - visibleSelected.value);
const exceedsLimit = computed(() => elsewhere.value + visibleHosts.value.length > batchTargetLimit);
const output = computed(
  () =>
    visibleResult.value?.results.find((row) => row.target.id === inspected.value) ??
    visibleResult.value?.results[0],
);
const failedToConnect = computed(
  () =>
    visibleResult.value?.results
      .filter((row) => row.status === 'connectionFailed')
      .map((row) => row.target.id) ?? [],
);
const productionCount = computed(
  () =>
    preview.value?.targets.filter(({ environment }) =>
      ['生产', 'production'].includes(environment?.name.toLowerCase() ?? ''),
    ).length ?? 0,
);
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
    new TextEncoder().encode(draft.command).length <= 8192,
  );
});

watch(dirty, (value) => emit('dirty', value));
watch(editor, async (value) => {
  if (!value || !props.active) return;
  await nextTick();
  nameField.value?.focus();
});
watch(preview, async (value) => {
  productionConfirmed.value = false;
  if (!value || !props.active) return;
  await nextTick();
  reviewHeading.value?.focus();
});
watch(
  () => hosts.catalog,
  (catalog) => {
    if (!catalog) return;
    const ids = new Set(catalog.hosts.map((host) => host.id));
    for (const selected of selections.values()) {
      selected.hostIds = selected.hostIds.filter((id) => ids.has(id));
      if (!catalog.groups.some((group) => group.id === selected.folder)) selected.folder = '';
      if (!environments.value.some((tag) => tag.id === selected.environment))
        selected.environment = '';
    }
  },
);

function setTarget(id: string, checked: boolean): void {
  const selected = selection.value;
  if (!selected) return;
  if (checked && !selected.hostIds.includes(id) && selected.hostIds.length < batchTargetLimit) {
    selected.hostIds.push(id);
  } else if (!checked) {
    selected.hostIds = selected.hostIds.filter((value) => value !== id);
  }
}

function toggleVisible(checked: boolean): void {
  if (checked && exceedsLimit.value) return;
  for (const host of visibleHosts.value) setTarget(host.id, checked);
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
            :disabled="loading || busy || !!editor || !commands"
            @click="edit(null)"
          >
            <Plus :size="15" aria-hidden="true" />{{ tr('新建') }}
          </button>
        </div>
        <p v-if="loading" class="batch-library-empty" role="status">{{ tr('正在读取命令…') }}</p>
        <p v-else-if="!commands?.length && !listError" class="batch-library-empty">
          {{ tr('暂无已保存的命令') }}
        </p>
        <div class="batch-command-list">
          <button
            v-for="entry in commands"
            :key="entry.id"
            type="button"
            class="batch-command-item"
            :aria-pressed="current?.id === entry.id"
            :title="entry.name"
            :disabled="busy || !!editor"
            @click="activate(entry.id)"
          >
            <Terminal :size="16" aria-hidden="true" />
            <span class="batch-command-label">{{ entry.name }}</span>
            <code dir="ltr">{{ entry.command.split('\n', 1)[0] }}</code>
          </button>
        </div>
        <div v-if="current" class="batch-library-actions">
          <button
            class="button"
            type="button"
            :disabled="commandControlsDisabled"
            @click="edit(current)"
          >
            <Pencil :size="15" aria-hidden="true" />{{ tr('编辑命令') }}
          </button>
          <button
            class="icon-button"
            type="button"
            :title="tr('删除命令')"
            :aria-label="tr('删除命令')"
            :disabled="commandControlsDisabled"
            @click="
              deletion = current;
              actionError = null;
            "
          >
            <Trash2 :size="16" aria-hidden="true" />
          </button>
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
    <div class="content-scroll batch-content" :aria-busy="busy">
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

      <form v-if="editor" class="batch-flow batch-edit" @submit.prevent="save">
        <h2>{{ editor.previous ? tr('编辑命令') : tr('新建命令') }}</h2>
        <label class="batch-field">
          <span>{{ tr('命令名称') }}</span>
          <input ref="nameField" v-model="editor.name" maxlength="128" :disabled="busy" required />
        </label>
        <label class="batch-field">
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
        <p class="muted">{{ tr('命令文本保存在本机，请勿在其中填写密码、密钥或令牌。') }}</p>
        <div class="dialog-actions">
          <button
            class="button"
            type="button"
            :disabled="busy"
            @click="
              editor = null;
              actionError = null;
            "
          >
            {{ tr('取消') }}
          </button>
          <button class="button primary" type="submit" :disabled="busy || !validDraft">
            {{ tr('保存命令') }}
          </button>
        </div>
      </form>

      <section v-else-if="preview" class="batch-flow">
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

      <section v-else-if="visibleResult" class="batch-flow">
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
              <button class="button" type="button" :disabled="busy" @click="showingTargets = true">
                {{ tr('重新选择目标') }}
              </button>
              <button
                v-if="
                  failedToConnect.length && current?.revision === visibleResult.command.revision
                "
                class="button"
                type="button"
                :disabled="busy || running"
                @click="prepare(failedToConnect, visibleResult)"
              >
                {{ tr('重试连接失败') }}
              </button>
            </template>
          </div>
        </div>
        <div class="batch-command-preview batch-flow">
          <div class="batch-row" role="status">
            <strong>{{ visibleResult.command.name }}</strong>
            <span>{{
              visibleResult.finished
                ? runSummary
                : tr('已处理 {0} / {1} 台', completed, visibleResult.results.length)
            }}</span>
          </div>
          <pre class="batch-shell" dir="ltr">{{ visibleResult.command.command }}</pre>
        </div>
        <div class="batch-results">
          <div class="batch-table-scroll">
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
          <section v-if="output" class="batch-output" :aria-label="tr('主机命令输出')">
            <div class="batch-row">
              <h3>{{ output.target.name }}</h3>
              <EnvironmentTagBadge :tag="output.target.environment ?? undefined" />
            </div>
            <code class="muted" dir="ltr">{{ login(output.target) }}</code>
            <p v-if="output.message" class="muted">{{ tr(output.message) }}</p>
            <template v-if="output.stdout"
              ><strong>{{ tr('标准输出') }}</strong>
              <pre class="batch-shell" dir="ltr">{{ output.stdout }}</pre>
            </template>
            <template v-if="output.stderr"
              ><strong>{{ tr('错误输出') }}</strong>
              <pre class="batch-shell" dir="ltr">{{ output.stderr }}</pre>
            </template>
            <p v-if="output.truncated" class="muted">{{ tr('输出超过 16 KiB，已截断显示。') }}</p>
            <p v-if="!output.stdout && !output.stderr && !output.message" class="muted">
              {{ tr('暂无输出') }}
            </p>
          </section>
        </div>
      </section>

      <section v-else-if="current && selection" class="batch-flow">
        <h2>{{ current.name }}</h2>
        <pre
          class="batch-shell batch-command-text"
          dir="ltr"
        ><span class="batch-prompt" aria-hidden="true">$ </span>{{ current.command }}</pre>
        <div class="batch-row">
          <h3>{{ tr('目标主机') }}</h3>
          <span class="muted" role="status"
            >{{ tr('已选 {0} 台', selection.hostIds.length)
            }}<template v-if="elsewhere">
              · {{ tr('其中 {0} 台在当前筛选范围外', elsewhere) }}</template
            ></span
          >
        </div>
        <div v-if="hosts.catalog?.hosts.length" class="batch-filters">
          <label class="batch-filter"
            ><span>{{ tr('目录') }}</span
            ><select v-model="selection.folder" :disabled="busy">
              <option value="">{{ tr('全部目录') }}</option>
              <option v-for="folder in directoryOptions" :key="folder.id" :value="folder.id">
                {{ folder.label }}
              </option>
            </select></label
          >
          <label class="batch-filter"
            ><span>{{ tr('环境标签') }}</span
            ><select v-model="selection.environment" :disabled="busy">
              <option value="">{{ tr('全部环境') }}</option>
              <option v-for="tag in environments" :key="tag.id" :value="tag.id">
                {{ tag.name }}
              </option>
            </select></label
          >
          <button
            v-if="selection.hostIds.length"
            class="button"
            type="button"
            :disabled="busy"
            @click="selection.hostIds = []"
          >
            {{ tr('清空选择') }}
          </button>
        </div>
        <div v-if="!hosts.catalog && hosts.error" class="banner batch-alert" role="alert">
          <span>{{ hosts.error }}</span>
          <button class="button" type="button" :disabled="hosts.busy" @click="hosts.load">
            {{ tr('重新加载主机') }}
          </button>
        </div>
        <p v-else-if="!hosts.catalog" class="muted" role="status">{{ tr('正在读取主机目录…') }}</p>
        <p v-else-if="!hosts.catalog.hosts.length" class="muted">
          {{ tr('暂无主机，请先在主机管理中添加。') }}
        </p>
        <p v-else-if="!visibleHosts.length" class="muted">{{ tr('当前筛选范围内没有主机') }}</p>
        <div v-else class="batch-table-scroll">
          <table class="batch-table" :aria-label="tr('选择目标主机')">
            <thead>
              <tr>
                <th scope="col" class="batch-check">
                  <input
                    type="checkbox"
                    :aria-label="tr('全选当前筛选范围的主机')"
                    :checked="allVisibleSelected"
                    :indeterminate="visibleSelected > 0 && !allVisibleSelected"
                    :disabled="busy || (exceedsLimit && !allVisibleSelected)"
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
                    :checked="selection.hostIds.includes(host.id)"
                    :disabled="
                      busy ||
                      (selection.hostIds.length >= batchTargetLimit &&
                        !selection.hostIds.includes(host.id))
                    "
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
        <p v-if="exceedsLimit || selection.hostIds.length >= batchTargetLimit" class="muted">
          {{ tr('每批最多选择 32 台主机。') }}
        </p>
        <div class="batch-row">
          <label class="batch-filter"
            ><span>{{ tr('并发上限') }}</span
            ><select v-model.number="selection.concurrency" :disabled="busy">
              <option v-for="limit in [1, 3, 5]" :key="limit" :value="limit">
                {{ tr('{0} 台', limit) }}
              </option>
            </select></label
          >
          <span v-if="running" class="muted">{{ tr('另有批次正在执行。') }}</span>
          <button
            class="button primary"
            type="button"
            :disabled="busy || running || !selection.hostIds.length"
            @click="prepare(selection.hostIds)"
          >
            {{ tr('预览发送') }}
          </button>
        </div>
      </section>

      <section v-else-if="commands && !listError" class="batch-empty">
        <Terminal :size="26" aria-hidden="true" />
        <h2>{{ tr('新建批量命令') }}</h2>
        <p class="muted">{{ tr('保存一条 SSH 命令，再选择要发送到的主机。') }}</p>
        <button
          class="button primary"
          type="button"
          :disabled="busy || loading"
          @click="edit(null)"
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
.batch-library-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--border);
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
.batch-command-item:hover {
  background: var(--hover);
}
.batch-command-item[aria-pressed='true'] {
  color: var(--accent);
  background: var(--accent-bg);
}
.batch-command-item code {
  grid-column: 2;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.batch-command-label,
.batch-command-item code {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.batch-content {
  width: 100%;
  min-height: 0;
  overflow: auto;
}
.batch-content > .banner,
.batch-content > .error-text {
  margin-bottom: 10px;
}
.batch-flow,
.batch-output {
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
.batch-filter select {
  max-width: min(20rem, 100%);
}
.batch-edit {
  max-width: 850px;
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
.batch-command-text {
  min-height: 70px;
  max-height: 160px;
  overflow: auto;
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
.batch-command-preview,
.batch-output {
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
.batch-results {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  align-items: start;
  gap: 12px;
}
.batch-inspect {
  border: 0;
  background: transparent;
  padding: 4px 0;
  color: inherit;
  text-align: left;
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
.batch-output pre {
  max-height: 260px;
  overflow: auto;
}
.batch-output > code {
  overflow-wrap: anywhere;
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
@media (max-width: 1050px) {
  .batch-results {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
