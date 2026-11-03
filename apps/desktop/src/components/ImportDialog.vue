<script setup lang="ts">
import { useErrorNotifications } from '../composables/error-notifications';
import { ref, watch } from 'vue';
import Modal from './Modal.vue';
import { useHostsStore } from '../stores/hosts';
import { hostsApi } from '../services/hosts';
import { folderPath } from '../services/host-tree';
import { authLabels, type ImportPreview } from '../types/hosts';
const emit = defineEmits<{ close: [] }>();
const store = useHostsStore();
const text = ref('');
const preview = ref<ImportPreview | null>(null);
const selected = ref<string[]>([]);
const group = ref<string | null>(null);
const acknowledged = ref(false);
const fileError = ref('');
watch(text, () => {
  preview.value = null;
  selected.value = [];
  acknowledged.value = false;
});
async function fileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  fileError.value = '';
  try {
    if (file.size > 1024 * 1024) throw new Error('配置文件不得超过 1 MiB。');
    text.value = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    fileError.value = '无法读取文件：需要 1 MiB 以内的 UTF-8 文本。';
  } finally {
    input.value = '';
  }
}
async function inspect(): Promise<void> {
  const result = await store.run(() => hostsApi.preview(text.value));
  if (result.ok) {
    preview.value = result.value;
    selected.value = result.value.candidates
      .filter((c) => !c.blocked && !c.duplicate)
      .map((c) => c.alias);
    acknowledged.value = false;
  }
}
async function submit(): Promise<void> {
  if (!preview.value || !acknowledged.value) return;
  const result = await store.run(
    () => hostsApi.import(text.value, [...selected.value], group.value),
    '选择的主机导入已完成。',
  );
  if (result.ok) {
    store.notice = `已导入 ${result.value.value.length} 台主机。 ${result.value.warnings.join('；')}`;
    emit('close');
  }
}
useErrorNotifications(fileError);
</script>
<template>
  <Modal title="导入 OpenSSH Config" :busy="store.busy" wide @close="emit('close')">
    <p class="subtle">
      只读取你选择或粘贴的配置，不执行任何命令，不修改原文件。支持明确 Host
      别名及常见字段；未知选项会提示或阻止导入。
    </p>

    <label class="file-picker"
      >选择配置文件<input type="file" :disabled="store.busy" @change="fileChange"
    /></label>
    <label class="editor-form"
      >或粘贴配置<textarea
        v-model="text"
        :disabled="store.busy"
        rows="8"
        spellcheck="false"
        aria-label="OpenSSH Config 内容"
      ></textarea>
    </label>
    <div class="toolbar">
      <button class="button" :disabled="!text.trim() || store.busy" @click="inspect">
        {{ store.busy ? '解析中…' : '生成导入预览' }}</button
      ><label
        >导入到
        <select v-model="group" :disabled="store.busy">
          <option :value="null">根目录</option>
          <option v-for="g in store.catalog?.groups" :key="g.id" :value="g.id">
            {{ folderPath(store.catalog?.groups ?? [], g.id) }}
          </option>
        </select></label
      >
    </div>
    <section v-if="preview" class="import-preview">
      <p v-for="warning in preview.warnings" :key="warning" class="banner">{{ warning }}</p>
      <p v-if="!preview.candidates.length" class="subtle">
        没有明确的 Host 别名可导入。通配符规则不会扩展为新主机。
      </p>
      <ul class="management-list">
        <li v-for="candidate in preview.candidates" :key="candidate.alias">
          <div>
            <label class="checkbox-label"
              ><input
                v-model="selected"
                type="checkbox"
                :value="candidate.alias"
                :disabled="candidate.blocked || candidate.duplicate || store.busy"
              /><strong>{{ candidate.alias }}</strong
              ><span
                >{{ candidate.host.username }}@{{ candidate.host.hostname }}:{{
                  candidate.host.port
                }}</span
              ></label
            >
            <p class="subtle">
              认证：{{ authLabels[candidate.host.authType] }} · 超时
              {{ candidate.host.connectTimeoutSecs }} 秒
            </p>
            <p v-if="candidate.duplicate" class="subtle">
              已有同名或同端点/用户主机，将跳过，不覆盖。
            </p>
            <p v-if="candidate.identityFile" class="path">
              IdentityFile：{{ candidate.identityFile }}（仅路径引用，口令需另行配置）
            </p>
            <p v-for="warning in candidate.warnings" :key="warning" class="import-warning">
              {{ warning }}
            </p>
            <p v-if="candidate.blocked" class="danger">此条目已阻止导入。</p>
          </div>
        </li>
      </ul>
      <label class="checkbox-label"
        ><input
          v-model="acknowledged"
          type="checkbox"
          :disabled="store.busy"
        />已检查预览、认证方式与警告，确认只导入选中的条目。</label
      >
    </section>
    <footer class="dialog-actions">
      <button class="button" :disabled="store.busy" @click="emit('close')">取消</button
      ><button
        class="button primary"
        :disabled="!preview || !selected.length || !acknowledged || store.busy"
        @click="submit"
      >
        导入 {{ selected.length }} 台主机
      </button>
    </footer>
  </Modal>
</template>
