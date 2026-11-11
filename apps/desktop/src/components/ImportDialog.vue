<script setup lang="ts">
import { tr } from '../i18n/messages';

import { useErrorNotifications } from '../composables/error-notifications';
import { nextTick, ref, watch } from 'vue';
import { Eye, FileText, ShieldCheck } from '@lucide/vue';
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
const fileInput = ref<HTMLInputElement | null>(null);
const previewHeading = ref<HTMLHeadingElement | null>(null);
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
    if (file.size > 1024 * 1024) throw new Error(tr('配置文件不得超过 1 MiB。'));
    text.value = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    fileError.value = tr('无法读取文件：需要 1 MiB 以内的 UTF-8 文本。');
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
    await nextTick();
    previewHeading.value?.focus({ preventScroll: true });
    previewHeading.value?.scrollIntoView({ block: 'start' });
  }
}
async function submit(): Promise<void> {
  if (!preview.value || !acknowledged.value) return;
  const result = await store.run(
    () => hostsApi.import(text.value, [...selected.value], group.value),
    tr('选择的主机导入已完成。'),
  );
  if (result.ok) {
    store.notice = tr(
      '已导入 {0} 台主机。 {1}',
      result.value.value.length,
      result.value.warnings.join('；'),
    );
    emit('close');
  }
}
useErrorNotifications(fileError);
</script>
<template>
  <Modal :title="tr('导入 OpenSSH Config')" :busy="store.busy" @close="emit('close')">
    <div class="import-body">
      <p class="import-intro subtle">
        {{ tr('选择本机文件或粘贴配置，生成预览后勾选要导入的主机。') }}
      </p>
      <div class="import-file">
        <FileText :size="20" aria-hidden="true" />
        <div>
          <strong>{{ tr('本机配置文件') }}</strong>
          <p class="subtle">{{ tr('UTF-8 文本，最大 1 MiB') }}</p>
        </div>
        <input ref="fileInput" type="file" hidden :disabled="store.busy" @change="fileChange" />
        <button class="button" :disabled="store.busy" @click="fileInput?.click()">
          {{ tr('选择文件') }}
        </button>
      </div>
      <label class="import-editor">
        <strong>{{ tr('配置内容') }}</strong>
        <textarea
          v-model="text"
          :disabled="store.busy"
          rows="5"
          spellcheck="false"
          :aria-label="tr('OpenSSH Config 内容')"
          :placeholder="'Host web-prod\n  HostName 192.0.2.10\n  User deploy'"
        ></textarea>
      </label>
      <div class="import-controls">
        <div class="import-destination">
          <label for="openssh-import-group">{{ tr('导入到') }}</label>
          <select id="openssh-import-group" v-model="group" :disabled="store.busy">
            <option :value="null">{{ tr('根目录') }}</option>
            <option v-for="g in store.catalog?.groups" :key="g.id" :value="g.id">
              {{ folderPath(store.catalog?.groups ?? [], g.id) }}
            </option>
          </select>
        </div>
        <button
          class="button"
          :class="{ primary: !preview }"
          :disabled="!text.trim() || store.busy"
          @click="inspect"
        >
          <Eye :size="14" aria-hidden="true" />
          {{ store.busy ? tr('解析中…') : tr('生成导入预览') }}
        </button>
      </div>
      <p class="import-safety subtle">
        <ShieldCheck :size="15" aria-hidden="true" />
        <span>{{
          tr('仅读取配置。命令不会执行，原文件保持原样。未知选项会提示或阻止导入。')
        }}</span>
      </p>
      <section v-if="preview" class="import-preview" aria-labelledby="openssh-import-preview">
        <div class="import-preview-heading">
          <h3 id="openssh-import-preview" ref="previewHeading" tabindex="-1">
            {{ tr('导入预览') }}
          </h3>
          <span v-if="preview.candidates.length" class="subtle"
            >{{ tr(' 已选 ') }}{{ selected.length }} / {{ preview.candidates.length }}
          </span>
        </div>
        <p v-for="warning in preview.warnings" :key="warning" class="banner">{{ warning }}</p>
        <p v-if="!preview.candidates.length" class="subtle">
          {{ tr(' 没有明确的 Host 别名可导入。通配符规则不会扩展为新主机。 ') }}
        </p>
        <ul v-else class="import-candidates">
          <li v-for="candidate in preview.candidates" :key="candidate.alias">
            <label class="checkbox-label">
              <input
                v-model="selected"
                type="checkbox"
                :value="candidate.alias"
                :disabled="candidate.blocked || candidate.duplicate || store.busy"
              />
              <span class="import-candidate-name">
                <strong>{{ candidate.alias }}</strong>
                <span class="import-endpoint"
                  >{{ candidate.host.username }}@{{ candidate.host.hostname }}:{{
                    candidate.host.port
                  }}</span
                >
              </span>
              <span v-if="candidate.blocked" class="import-status danger">{{ tr('已阻止') }}</span>
              <span v-else-if="candidate.duplicate" class="import-status">{{ tr('重复') }}</span>
            </label>
            <div class="import-candidate-details subtle">
              <p>
                {{ tr(' 认证：') }}{{ authLabels[candidate.host.authType] }}{{ tr(' · 超时 ')
                }}{{ candidate.host.connectTimeoutSecs }}{{ tr(' 秒 ') }}
              </p>
              <p v-if="candidate.duplicate">
                {{ tr('已有同名或同端点/用户主机，将跳过，不覆盖。') }}
              </p>
              <p v-if="candidate.identityFile">
                IdentityFile：{{ candidate.identityFile
                }}{{ tr('（仅路径引用，口令需另行配置） ') }}
              </p>
              <p v-for="warning in candidate.warnings" :key="warning">
                {{ warning }}
              </p>
              <p v-if="candidate.blocked" class="danger">{{ tr('此条目已阻止导入。') }}</p>
            </div>
          </li>
        </ul>
        <label v-if="preview.candidates.length" class="checkbox-label import-confirm">
          <input v-model="acknowledged" type="checkbox" :disabled="store.busy" />{{
            tr(' 已检查预览、认证方式与警告，确认只导入选中的条目。 ')
          }}</label
        >
      </section>
    </div>
    <footer class="dialog-actions import-footer">
      <button class="button" :disabled="store.busy" @click="emit('close')">{{ tr('取消') }}</button>
      <button
        class="button"
        :class="{ primary: preview }"
        :disabled="!preview || !selected.length || !acknowledged || store.busy"
        @click="submit"
      >
        {{ selected.length ? tr('导入 {0} 台主机', selected.length) : tr('导入主机') }}
      </button>
    </footer>
  </Modal>
</template>
