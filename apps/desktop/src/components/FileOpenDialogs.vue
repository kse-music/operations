<script setup lang="ts">
import { tr } from '../i18n/messages';
import { displayLocalPath } from '@serverdeck/plugin-sdk/paths';

import { computed, ref, watch } from 'vue';
import { useFilesStore } from '../stores/files';
import { bytes, taskLabels, unfinished } from '../types/files';
import Modal from './Modal.vue';
const store = useFilesStore();
const confirmed = ref(false),
  closing = ref(false),
  saved = ref(false);
const task = computed(() =>
  store.tasks.find((task) => task.id === store.externalDocument?.transferId),
);
watch(
  () => store.externalDocument?.token,
  () => {
    confirmed.value = false;
    saved.value = false;
  },
);
async function save(): Promise<void> {
  saved.value = false;
  await store.saveExternal(confirmed.value);
  if (!store.externalError) {
    saved.value = true;
    confirmed.value = false;
  }
}
</script>
<template>
  <Modal
    v-if="store.openIssue"
    :title="tr('打开远程文件')"
    :busy="store.externalBusy"
    @close="
      store.openIssue = null;
      store.externalError = null;
    "
  >
    <p class="file-open-path">{{ store.openIssue.path }}</p>
    <p>{{ store.openIssue.message }}</p>
    <p class="subtle">
      {{
        tr(
          ' 使用系统应用时先下载本地副本。编辑并保存后，返回 ServerDeck 确认回传；本地副本会保留。 ',
        )
      }}
    </p>
    <p v-if="store.externalError" role="alert">{{ store.externalError }}</p>
    <footer class="dialog-actions">
      <button
        class="button"
        :disabled="store.externalBusy"
        @click="
          store.openIssue = null;
          store.externalError = null;
        "
      >
        {{ tr(' 取消 ') }}
      </button>
      <button
        class="button primary"
        :disabled="store.externalBusy || !!store.document"
        @click="store.startExternal"
      >
        {{ store.externalBusy ? tr('准备副本…') : tr('使用系统应用编辑…') }}
      </button>
    </footer>
  </Modal>
  <Modal
    v-if="store.externalDocument"
    :title="tr('外部编辑远程文件')"
    :busy="store.externalBusy"
    @close="closing = true"
  >
    <p class="file-open-path">{{ tr('远程：') }}{{ store.externalDocument.path }}</p>
    <p class="file-open-path">
      {{ tr('本地副本：') }}{{ displayLocalPath(store.externalDocument.localPath) }}
    </p>
    <p v-if="!store.externalDocument.ready" role="status">
      {{ taskLabels[task?.state ?? 'queued'] ?? tr('下载中') }} ·
      {{ bytes(task?.transferredBytes ?? 0) }} / {{ bytes(task?.totalBytes ?? 0) }}
    </p>
    <template v-else>
      <p>{{ tr('请在系统应用中保存并停止修改文件，然后返回此处确认回传。') }}</p>
      <label class="checkbox-label"
        ><input
          v-model="confirmed"
          type="checkbox"
          :disabled="store.externalBusy || !store.externalDocument.atomicSave"
        />{{
          tr(
            '确认回传覆盖原文件；原子替换会改变 inode，保留基本权限和属主，不保留 ACL、扩展属性或硬链接关系。',
          )
        }}</label
      >
      <p v-if="!store.externalDocument.atomicSave" role="status">
        {{ tr(' 服务器缺少原子替换扩展，只能查看本地副本。 ') }}
      </p>
    </template>
    <p v-if="store.externalError" role="alert">
      {{ store.externalError }}{{ tr('；本地副本保留。') }}
    </p>
    <p v-if="saved" role="status">{{ tr('回传成功，文件已校验。继续编辑后需再次确认回传。') }}</p>
    <footer class="dialog-actions">
      <button
        v-if="store.externalBusy && !store.externalDocument.ready"
        class="button"
        @click="store.cancelExternalSave"
      >
        {{ tr(' 取消准备 ') }}
      </button>
      <button v-if="store.externalSaving" class="button" @click="store.cancelExternalSave">
        {{ tr(' 取消回传 ') }}
      </button>
      <button class="button" :disabled="store.externalBusy" @click="closing = true">
        {{ task && unfinished(task) ? tr('取消下载并结束') : tr('结束外部编辑') }}
      </button>
      <button
        v-if="store.externalDocument.ready"
        class="button"
        :disabled="store.externalBusy"
        @click="store.openLocal(store.externalDocument.localPath)"
      >
        {{ tr(' 选择应用打开… ') }}
      </button>
      <button
        v-if="store.externalDocument.ready"
        class="button primary"
        :disabled="store.externalBusy || !confirmed || !store.externalDocument.atomicSave"
        @click="save"
      >
        {{ store.externalBusy ? tr('处理中…') : tr('确认回传服务器') }}
      </button>
    </footer>
  </Modal>
  <Modal
    v-if="closing && store.externalDocument"
    :title="tr('结束外部编辑')"
    :busy="store.externalBusy"
    @close="closing = false"
  >
    <p>
      {{
        tr(
          ' 尚未回传的本地修改不会自动上传。本地副本继续保留，外部应用也不会被关闭。确认结束本次编辑？ ',
        )
      }}
    </p>
    <footer class="dialog-actions">
      <button class="button" :disabled="store.externalBusy" @click="closing = false">
        {{ tr(' 继续编辑 ') }}
      </button>
      <button
        class="button"
        :disabled="store.externalBusy"
        @click="
          store.closeExternal().then(() => {
            closing = false;
          })
        "
      >
        {{ tr(' 确认结束 ') }}
      </button>
    </footer>
  </Modal>
</template>
<style scoped>
.file-open-path {
  overflow-wrap: anywhere;
}
</style>
