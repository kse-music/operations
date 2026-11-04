<script setup lang="ts">
import { useErrorNotifications } from '@serverdeck/plugin-sdk/composables/error-notifications';
import { hostDisplayName } from '@serverdeck/plugin-sdk/types/hosts';
import { onBeforeUnmount, ref, shallowRef } from 'vue';
import Modal from '@serverdeck/plugin-sdk/ui/Modal.vue';
import TaskConnections from '@serverdeck/plugin-sdk/ui/TaskConnections.vue';
import { useHostsStore } from '@serverdeck/plugin-sdk/stores/hosts';
import { useAutomationApi } from '@serverdeck/plugin-sdk/services/plugin-tool-services';
const automationApi = useAutomationApi();
import type { Entry, Run, RunInput, Target } from '@serverdeck/plugin-sdk/types/automation';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
const props = defineProps<{ entry: Entry; initialHostId?: string; pendingRun?: Run }>(),
  emit = defineEmits<{ close: []; started: [run: Run] }>();
const hosts = useHostsStore(),
  hostIds = ref(
    props.pendingRun?.spec.targets.map((t) => t.hostId) ??
      (props.initialHostId ? [props.initialHostId] : []),
  ),
  parameters = ref<Record<string, string>>(
    Object.fromEntries(
      props.entry.parameters.map((p) => [
        p.name,
        props.pendingRun?.spec.parameters[p.name] ?? p.default ?? '',
      ]),
    ),
  ),
  concurrency = ref(props.pendingRun?.spec.concurrency ?? props.entry.concurrency),
  timeout = ref(props.pendingRun?.spec.timeoutSecs ?? props.entry.timeoutSecs),
  busy = ref(false),
  error = ref(''),
  phrase = ref(''),
  danger = ref(false);
const preview = shallowRef<{ entry: Entry; targets: Target[]; input: RunInput } | null>(null);
function clear() {
  for (const p of props.entry.parameters) if (p.secret) parameters.value[p.name] = '';
  if (preview.value)
    for (const p of props.entry.parameters)
      if (p.secret) preview.value.input.parameters[p.name] = '';
  preview.value = null;
}
onBeforeUnmount(clear);
async function review() {
  busy.value = true;
  error.value = '';
  try {
    const [entry, targets] = props.pendingRun
      ? [props.pendingRun.spec.entry, props.pendingRun.spec.targets]
      : await automationApi.prepare(props.entry.id, props.entry.revision, [...hostIds.value]);
    preview.value = {
      entry,
      targets,
      input: {
        entryId: entry.id,
        expectedRevision: entry.revision,
        hostIds: targets.map((t) => t.hostId),
        expectedProfiles: Object.fromEntries(targets.map((t) => [t.hostId, t.routeSignature])),
        parameters: { ...parameters.value },
        concurrency: concurrency.value,
        timeoutSecs: timeout.value,
        confirmed: false,
        dangerConfirmed: false,
      },
    };
    phrase.value = '';
    danger.value = false;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function execute() {
  const p = preview.value;
  if (
    !p ||
    phrase.value !== `执行 ${p.targets.length} 台` ||
    (p.entry.risk === 'dangerous' && !danger.value)
  )
    return;
  busy.value = true;
  error.value = '';
  try {
    const run = props.pendingRun
      ? await automationApi.approve(props.pendingRun.id, true, danger.value)
      : await automationApi.start({ ...p.input, confirmed: true, dangerConfirmed: danger.value });
    clear();
    emit('started', run);
  } catch (e) {
    error.value = errorMessage(e);
    clear();
  } finally {
    busy.value = false;
  }
}
useErrorNotifications(error);
</script>
<template>
  <Modal
    title="执行自动化任务"
    wide
    :busy="busy"
    @close="
      clear();
      emit('close');
    "
    ><form v-if="!preview" class="automation-form" @submit.prevent="review">
      <h3>{{ entry.name }} · {{ entry.risk === 'dangerous' ? '危险' : '普通' }}</h3>
      <fieldset class="batch-targets">
        <legend>执行目标</legend>
        <label v-for="h in hosts.catalog?.hosts" :key="h.id"
          ><input
            v-model="hostIds"
            type="checkbox"
            :value="h.id"
            :disabled="!!pendingRun"
            :aria-label="`自动化目标 ${hostDisplayName(h)}`"
          />{{ hostDisplayName(h) }} · {{ h.username }}@{{ h.hostname }}:{{ h.port }}</label
        >
      </fieldset>
      <TaskConnections v-if="hostIds.length" :ids="hostIds" />
      <label v-for="(p, i) in entry.parameters" :key="p.name"
        >${{ i + 1 }} · {{ p.label }}{{ p.secret ? '（秘密）' : ''
        }}<input
          v-model="parameters[p.name]"
          :type="p.secret ? 'password' : 'text'"
          :required="p.required"
          :readonly="!!pendingRun"
          maxlength="4096"
          autocomplete="off"
          :aria-label="`任务参数 ${p.name}`"
      /></label>
      <div class="ops-toolbar">
        <label
          >并发<input
            v-model.number="concurrency"
            type="number"
            min="1"
            max="8"
            :readonly="!!pendingRun"
            required
            aria-label="自动化并发" /></label
        ><label
          >每台超时（秒）<input
            v-model.number="timeout"
            type="number"
            min="1"
            max="3600"
            :readonly="!!pendingRun"
            required
            aria-label="自动化超时"
        /></label>
      </div>
      <details open>
        <summary>实际执行正文（参数单独传递）</summary>
        <pre class="ops-log-output">{{ entry.body }}</pre>
      </details>
      <p class="subtle">
        执行需要远端 Python 3 和
        /bin/sh；不自动提权或重试。位置参数可能被远端同账号/管理员通过进程信息查看。含秘密参数时不展示、不保存
        stdout/stderr，参数值也不写入历史。
      </p>
      <button class="button primary" :disabled="busy || !hostIds.length">预览自动化执行</button>
    </form>
    <section v-else class="automation-form">
      <h3>{{ preview.entry.name }} · {{ preview.entry.risk === 'dangerous' ? '危险' : '普通' }}</h3>
      <ul>
        <li v-for="t in preview.targets" :key="t.hostId">
          {{ t.name }} · {{ t.username }}@{{ t.hostname }}:{{ t.port }} · {{ t.hostId }}
        </li>
      </ul>
      <pre class="ops-log-output">{{ preview.entry.body }}</pre>
      <p v-for="p in preview.entry.parameters" :key="p.name">
        {{ p.label }}：{{ p.secret ? '••••••（不记录）' : preview.input.parameters[p.name] }}
      </p>
      <p>
        并发 {{ preview.input.concurrency }}，每台
        {{ preview.input.timeoutSecs }} 秒。超时/断线/请求停止后远端状态可能未知。
      </p>
      <label v-if="preview.entry.risk === 'dangerous'"
        ><input
          v-model="danger"
          type="checkbox"
          aria-label="确认危险自动化正文"
        />我已审查危险正文，确认所有目标和副作用。</label
      ><label
        >输入“执行 {{ preview.targets.length }} 台”<input
          v-model="phrase"
          aria-label="自动化执行确认文字"
          autocomplete="off"
      /></label>
      <footer class="dialog-actions">
        <button class="button" :disabled="busy" @click="clear">返回修改</button
        ><button
          class="button danger"
          :disabled="
            busy ||
            phrase !== `执行 ${preview.targets.length} 台` ||
            (preview.entry.risk === 'dangerous' && !danger)
          "
          @click="execute"
        >
          确认执行自动化
        </button>
      </footer>
    </section>
  </Modal>
</template>
