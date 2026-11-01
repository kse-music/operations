<script setup lang="ts">
import { ref, shallowRef, watch } from 'vue';
import { productApi } from '../services/product';
import { downloadResult } from '../services/tasks';
import { errorMessage } from '../services/ipc';
import { useHostsStore } from '../stores/hosts';
import { useApplicationStore } from '../stores/application';
import { useNotificationsStore } from '../stores/notifications';
import type { BackupPreview, RestoreResult } from '../types/product';
const hosts = useHostsStore(),
  application = useApplicationStore(),
  notifications = useNotificationsStore();
const text = ref(''),
  exported = ref(''),
  preview = shallowRef<BackupPreview | null>(null),
  selected = ref<string[]>([]),
  policy = ref<'skip' | 'copy'>('skip'),
  preferences = ref(false),
  confirmed = ref(false),
  busy = ref(false),
  error = ref(''),
  result = shallowRef<RestoreResult | null>(null),
  limit = ref(200);
watch([selected, policy, preferences], () => (confirmed.value = false), { deep: true });
function reset() {
  preview.value = null;
  confirmed.value = false;
  result.value = null;
}
async function file(event: Event) {
  const f = (event.target as HTMLInputElement).files?.[0];
  if (!f) return;
  reset();
  if (f.size > 8 * 1024 * 1024) {
    error.value = '备份文件超过 8 MiB';
    return;
  }
  try {
    text.value = await f.text();
  } catch (e) {
    error.value = errorMessage(e);
  }
}
async function exportBackup() {
  busy.value = true;
  error.value = '';
  try {
    exported.value = await productApi.export();
    downloadResult('serverdeck-backup-v1.json', exported.value);
    notifications.push('非敏感备份已生成，请妥善保管脚本正文和备注。');
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function inspect() {
  busy.value = true;
  error.value = '';
  reset();
  try {
    preview.value = await productApi.preview(text.value);
    selected.value = preview.value.items.filter((i) => !i.blocked && !i.duplicate).map((i) => i.id);
    limit.value = 200;
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
async function restore() {
  if (!preview.value || !confirmed.value) return;
  busy.value = true;
  error.value = '';
  try {
    result.value = await productApi.restore({
      text: text.value,
      selected: [...selected.value],
      conflict: policy.value,
      restorePreferences: preferences.value,
      confirmed: true,
    });
    preview.value = null;
    confirmed.value = false;
    await hosts.load();
    if (result.value.preferencesRestored) await application.initialize();
    notifications.push('备份恢复完成；未自动连接或执行任务。');
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="operations-view" aria-label="备份恢复工作区">
    <header>
      <p class="eyebrow">LOCAL BACKUP</p>
      <h1>备份与恢复</h1>
      <p class="subtle">
        版本化 JSON，最多 8
        MiB。包含主机、分组、标签、命令/脚本定义和非敏感偏好。不会包含凭据、私钥路径、秘密参数值、信任记录、运行历史或自动执行计划。请自行检查正文/备注/普通默认值中是否写入了秘密。
      </p>
    </header>
    <button class="button primary" :disabled="busy" @click="exportBackup">导出非敏感备份</button>
    <details v-if="exported">
      <summary>查看导出内容</summary>
      <textarea class="export-text" :value="exported" readonly aria-label="非敏感备份内容" />
    </details>
    <h2>导入预览</h2>
    <input
      type="file"
      accept=".json,application/json"
      aria-label="选择备份文件"
      :disabled="busy"
      @change="file"
    /><textarea
      v-model="text"
      class="export-text"
      aria-label="待恢复备份 JSON"
      placeholder="选择文件或粘贴备份 JSON"
      :disabled="busy"
      @input="reset"
    /><button class="button" :disabled="busy || !text" @click="inspect">校验并预览备份</button>
    <p v-if="busy" role="status">正在处理本地备份…</p>
    <p v-if="error" class="banner error" role="alert">{{ error }}</p>
    <section v-if="preview" aria-label="备份恢复预览">
      <h2>格式 v{{ preview.version }} · {{ preview.items.length }} 个条目</h2>
      <p v-for="w in preview.warnings" :key="w" class="subtle">{{ w }}</p>
      <label
        >冲突处理<select v-model="policy" aria-label="备份冲突策略">
          <option value="skip">跳过已有条目</option>
          <option value="copy">新增副本，不覆盖</option>
        </select></label
      ><button
        class="text-button"
        @click="
          selected = preview.items
            .filter((i) => !i.blocked && (policy === 'copy' || !i.duplicate))
            .map((i) => i.id)
        "
      >
        选择所有可恢复项</button
      ><button class="text-button" @click="selected = []">取消选择</button>
      <div v-for="i in preview.items.slice(0, limit)" :key="i.id" class="ops-detail">
        <label
          ><input
            v-model="selected"
            type="checkbox"
            :value="i.id"
            :disabled="i.blocked || busy"
            :aria-label="`恢复 ${i.name}`"
          />{{ i.kind === 'host' ? '主机' : '命令/脚本' }} · {{ i.name }} · {{ i.detail }}
          {{ i.duplicate ? '（重复）' : '' }} {{ i.blocked ? '（阻止恢复）' : '' }}</label
        >
        <p v-for="w in i.warnings" :key="w" class="subtle">{{ w }}</p>
      </div>
      <button v-if="preview.items.length > limit" class="button" @click="limit += 200">
        显示更多恢复条目
      </button>
      <p>将恢复选中的 {{ selected.length }} 个条目；主机/命令分组始终按名称合并。已有数据保留。</p>
      <label
        ><input
          v-model="preferences"
          type="checkbox"
          aria-label="恢复备份偏好"
        />同时替换全局非敏感偏好设置</label
      ><label
        ><input
          v-model="confirmed"
          type="checkbox"
          aria-label="确认备份恢复"
        />我已核对上述内容、选择项和冲突策略，同意新增配置。</label
      ><button
        class="button primary"
        :disabled="busy || !confirmed || (!selected.length && !preferences)"
        @click="restore"
      >
        确认恢复所选配置
      </button>
    </section>
    <section v-if="result" role="status">
      <h2>恢复完成</h2>
      <p>
        新增 {{ result.hosts }} 台主机、{{ result.entries }} 条命令/脚本，跳过
        {{ result.skipped }} 项。
      </p>
      <p v-for="w in result.warnings" :key="w">{{ w }}</p>
    </section>
  </section>
</template>
