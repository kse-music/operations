<script setup lang="ts">
import { useErrorNotifications } from '../composables/error-notifications';
import { hostDisplayName } from '../types/hosts';
import { onBeforeUnmount, ref, shallowRef } from 'vue';
import Modal from './Modal.vue';
import { automationApi } from '../services/automation';
import { useHostsStore } from '../stores/hosts';
import {
  offsetLabel,
  type Entry,
  type Schedule,
  type ScheduleInput,
  type Timing,
  type Target,
} from '../types/automation';
import { errorMessage } from '../services/ipc';
const props = defineProps<{ entry: Entry; schedule?: Schedule; initialHostId?: string }>(),
  emit = defineEmits<{ close: []; saved: [] }>();
const hosts = useHostsStore(),
  name = ref(props.schedule?.name ?? `${props.entry.name}计划`),
  hostIds = ref(
    props.schedule?.spec.targets.map((t) => t.hostId) ??
      (props.initialHostId ? [props.initialHostId] : []),
  ),
  parameters = ref(
    Object.fromEntries(
      props.entry.parameters
        .filter((p) => !p.secret)
        .map((p) => [p.name, props.schedule?.spec.parameters[p.name] ?? p.default ?? '']),
    ),
  ),
  kind = ref(props.schedule?.timing.kind ?? 'daily'),
  hour = ref(props.schedule?.timing.kind !== 'cron' ? (props.schedule?.timing.hour ?? 8) : 8),
  minute = ref(props.schedule?.timing.kind !== 'cron' ? (props.schedule?.timing.minute ?? 0) : 0),
  weekday = ref(props.schedule?.timing.kind === 'weekly' ? props.schedule.timing.weekday : 1),
  expression = ref(
    props.schedule?.timing.kind === 'cron' ? props.schedule.timing.expression : '0 8 * * *',
  ),
  offset = ref(props.schedule?.offsetMinutes ?? -new Date().getTimezoneOffset()),
  missed = ref<'skip' | 'ask'>(props.schedule?.missedPolicy ?? 'skip'),
  enabled = ref(props.schedule?.enabled ?? false),
  authorized = ref(false),
  busy = ref(false),
  error = ref('');
const preview = shallowRef<{ entry: Entry; targets: Target[]; input: ScheduleInput } | null>(null);
onBeforeUnmount(() => {
  preview.value = null;
});
async function review() {
  busy.value = true;
  error.value = '';
  try {
    const [entry, targets] = await automationApi.prepare(props.entry.id, props.entry.revision, [
      ...hostIds.value,
    ]);
    const timing: Timing =
      kind.value === 'cron'
        ? { kind: 'cron', expression: expression.value }
        : kind.value === 'weekly'
          ? { kind: 'weekly', weekday: weekday.value, hour: hour.value, minute: minute.value }
          : { kind: 'daily', hour: hour.value, minute: minute.value };
    preview.value = {
      entry,
      targets,
      input: {
        name: name.value,
        entryId: entry.id,
        expectedEntryRevision: entry.revision,
        hostIds: targets.map((t) => t.hostId),
        expectedProfiles: Object.fromEntries(targets.map((t) => [t.hostId, t.routeSignature])),
        parameters: { ...parameters.value },
        timing,
        offsetMinutes: offset.value,
        missedPolicy: missed.value,
        enabled: enabled.value,
        authorized: false,
      },
    };
    authorized.value = false;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function save() {
  const p = preview.value;
  if (!p || (p.input.enabled && !authorized.value)) return;
  busy.value = true;
  error.value = '';
  try {
    await automationApi.scheduleSave(props.schedule?.id ?? null, props.schedule?.revision ?? null, {
      ...p.input,
      authorized: authorized.value,
    });
    emit('saved');
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
useErrorNotifications(error);
</script>
<template>
  <Modal title="本地定时计划" wide :busy="busy" @close="emit('close')"
    ><p class="banner error">
      桌面应用退出、休眠或关机期间不能保证执行。本地计划只使用已有可信 SSH
      运维连接，未连接会记录失败；不会自动登录、提权或补跑。
    </p>
    <p v-if="entry.parameters.some((p) => p.secret)" class="banner error">
      此脚本含秘密参数，计划不保存秘密，请使用手动执行。
    </p>
    <form v-if="!preview" class="automation-form" @submit.prevent="review">
      <label>计划名称<input v-model="name" required maxlength="128" aria-label="计划名称" /></label>
      <fieldset class="batch-targets">
        <legend>全部目标</legend>
        <label v-for="h in hosts.catalog?.hosts" :key="h.id"
          ><input
            v-model="hostIds"
            type="checkbox"
            :value="h.id"
            :aria-label="`计划目标 ${hostDisplayName(h)}`"
          />{{ hostDisplayName(h) }} · {{ h.username }}@{{ h.hostname }}:{{ h.port }}</label
        >
      </fieldset>
      <label v-for="p in entry.parameters.filter((p) => !p.secret)" :key="p.name"
        >{{ p.label
        }}<input
          v-model="parameters[p.name]"
          :required="p.required"
          maxlength="4096"
          :aria-label="`计划参数 ${p.name}`"
      /></label>
      <div class="ops-toolbar">
        <label
          >周期<select v-model="kind" aria-label="计划周期">
            <option value="daily">每日</option>
            <option value="weekly">每周</option>
            <option value="cron">五字段 Cron</option>
          </select></label
        ><template v-if="kind !== 'cron'"
          ><label v-if="kind === 'weekly'"
            >星期<select v-model.number="weekday">
              <option
                v-for="(day, i) in ['周日', '周一', '周二', '周三', '周四', '周五', '周六']"
                :key="i"
                :value="i"
              >
                {{ day }}
              </option>
            </select></label
          ><label>时<input v-model.number="hour" type="number" min="0" max="23" required /></label
          ><label
            >分<input
              v-model.number="minute"
              type="number"
              min="0"
              max="59"
              required /></label></template
        ><label v-else
          >Cron<input
            v-model="expression"
            required
            maxlength="256"
            aria-label="计划 Cron"
            placeholder="分 时 日 月 星期" /></label
        ><label
          >固定 UTC 偏移（分钟）<input
            v-model.number="offset"
            type="number"
            min="-720"
            max="840"
            required
            aria-label="计划时区偏移"
        /></label>
      </div>
      <p class="subtle">
        {{ offsetLabel(offset) }}，创建后固定，不跟随系统时区或夏令时变化。Cron
        支持数字、*、范围、列表、步长；日期和星期均不以 * 开头时为 OR，其余为
        AND。不支持秒、名称、L/W/#/@。
      </p>
      <label
        >错过计划<select v-model="missed" aria-label="错过计划策略">
          <option value="skip">跳过并记录</option>
          <option value="ask">生成待手动确认任务</option>
        </select></label
      ><label><input v-model="enabled" type="checkbox" aria-label="启用本地计划" />启用计划</label
      ><button
        class="button primary"
        :disabled="busy || !hostIds.length || entry.parameters.some((p) => p.secret)"
      >
        预览计划授权
      </button>
    </form>
    <section v-else class="automation-form">
      <h3>{{ preview.input.name }} · {{ preview.input.enabled ? '启用' : '停用' }}</h3>
      <ul>
        <li v-for="t in preview.targets" :key="t.hostId">
          {{ t.name }} · {{ t.username }}@{{ t.hostname }}:{{ t.port }} · {{ t.hostId }}
        </li>
      </ul>
      <pre class="ops-log-output">{{ preview.entry.body }}</pre>
      <pre>{{ JSON.stringify(preview.input.parameters, null, 2) }}</pre>
      <p>
        周期 {{ JSON.stringify(preview.input.timing) }} ·
        {{ offsetLabel(preview.input.offsetMinutes) }} · 错过：{{
          preview.input.missedPolicy === 'skip' ? '跳过' : '等待手动确认'
        }}
      </p>
      <p v-if="preview.entry.risk === 'dangerous'" class="banner error">
        此为危险任务：到期只创建 Pending 待确认任务，每次必须人工预览后执行。
      </p>
      <p v-else>
        启用即授权按当前正文、参数和目标自动执行。风险等级由你指定，应用不能证明任意 Shell 安全。
      </p>
      <label v-if="preview.input.enabled"
        ><input
          v-model="authorized"
          type="checkbox"
          aria-label="授权计划执行规则"
        />我已审查完整内容和全部目标，理解本地调度限制及上述规则。</label
      >
      <footer class="dialog-actions">
        <button class="button" :disabled="busy" @click="preview = null">返回修改</button
        ><button
          class="button primary"
          :disabled="busy || (preview.input.enabled && !authorized)"
          @click="save"
        >
          保存本地计划
        </button>
      </footer>
    </section>
  </Modal>
</template>
