<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import Modal from '@serverdeck/plugin-sdk/ui/Modal.vue';
import { pickLocalFiles } from '@serverdeck/plugin-sdk/local-files';
import { displayLocalPath } from '@serverdeck/plugin-sdk/paths';
import { cancelCurrent } from '@serverdeck/plugin-sdk/actions';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import { useErrorNotifications } from '@serverdeck/plugin-sdk/composables/error-notifications';
import {
  runImageArchive,
  archiveFileName,
  imageReference,
  localFileName,
  validArchiveName,
  type ArchiveProgress,
} from './image-archive';
import { tr } from './i18n/messages';
const props = defineProps<{
  hostId: string;
  hostLabel: string;
  row?: Record<string, unknown>;
  visible: boolean;
}>();
const emit = defineEmits<{ close: []; completed: [] }>();
const exporting = computed(() => !!props.row);
const path = ref(''),
  name = ref(props.row ? archiveFileName(props.row) : '');
const busy = ref(false),
  picking = ref(false),
  done = ref(false),
  error = ref('');
const progress = ref<ArchiveProgress>();
let controller: AbortController | undefined;
let pending: Promise<void> | undefined;
let disposed = false;
const target = computed(() =>
  exporting.value ? `${path.value.replace(/[\\/]$/, '')}/${name.value}` : path.value,
);
const valid = computed(
  () =>
    !!path.value &&
    validArchiveName(exporting.value ? name.value : localFileName(path.value)) &&
    (!exporting.value || name.value.toLowerCase().endsWith('.tar')),
);
const stageLabel = computed(
  () =>
    ({
      preparing: tr('正在准备…'),
      uploading: tr('正在上传镜像归档…'),
      verifying: tr('正在校验并提交镜像归档…'),
      loading: tr('正在导入镜像…'),
      saving: tr('正在生成镜像归档…'),
      downloading: tr('正在下载镜像归档…'),
      finishing: tr('正在清理暂存文件…'),
    })[progress.value?.stage ?? 'preparing'],
);
const transferring = computed(() => {
  const value = progress.value;
  return (
    value &&
    ['uploading', 'downloading'].includes(value.stage) &&
    value.transfer?.state === 'running' &&
    value.transfer.transferredBytes < value.transfer.totalBytes
  );
});
async function pick() {
  picking.value = true;
  try {
    const selected = await pickLocalFiles(exporting.value ? 'folder' : 'files');
    if (disposed) return;
    if (selected.length > 1) throw new Error(tr('一次请选择一个镜像归档文件。'));
    if (selected[0]) path.value = selected[0];
  } catch (cause) {
    if (!disposed) error.value = errorMessage(cause);
  } finally {
    picking.value = false;
  }
}
async function submit() {
  if (busy.value || !valid.value || done.value) return;
  busy.value = true;
  error.value = '';
  controller = new AbortController();
  try {
    await runImageArchive(
      props.hostId,
      exporting.value
        ? {
            kind: 'export',
            id: String(props.row!.ID),
            reference: imageReference(props.row!),
            fileName: name.value,
            confirmed: true,
          }
        : { kind: 'import', fileName: localFileName(path.value), confirmed: true },
      target.value,
      controller.signal,
      (value) => {
        if (!disposed) progress.value = value;
      },
    );
    if (!disposed) {
      done.value = true;
      emit('completed');
    }
  } catch (cause) {
    if (!disposed) error.value = errorMessage(cause);
  } finally {
    if (!disposed) busy.value = false;
  }
}
function start() {
  pending = submit();
}
async function cancel() {
  controller?.abort();
  try {
    await cancelCurrent();
  } catch (cause) {
    if (!disposed) error.value = errorMessage(cause);
  }
  await pending;
}
async function close() {
  if (busy.value) {
    await cancel();
    if (props.visible) return;
  }
  if (!disposed) emit('close');
}
watch(
  () => props.visible,
  (visible) => {
    if (!visible) void close();
  },
);
onBeforeUnmount(() => {
  disposed = true;
  controller?.abort();
  if (busy.value)
    void cancelCurrent().catch((cause) =>
      console.error(
        'Image archive cancellation failed',
        (cause as { code?: string })?.code ?? 'UNKNOWN',
      ),
    );
});
useErrorNotifications(() => [error.value]);
</script>
<template>
  <Modal :title="exporting ? tr('导出镜像') : tr('导入镜像')" :busy="picking" @close="close">
    <form class="docker-archive" @submit.prevent="start">
      <div class="docker-archive-content">
        <p>{{ tr('目标主机：{0}', hostLabel) }}</p>
        <p v-if="row">{{ tr('镜像：{0}', imageReference(row)) }}</p>
        <p class="subtle">
          {{
            exporting
              ? tr(
                  '生成 tar 归档并下载到本机，保留所选标签；无标签镜像按 ID 导出。不会覆盖已有文件。',
                )
              : tr(
                  '选择其它环境通过 docker save 生成的归档，上传后执行 load。归档中的同名标签可能被替换，已有容器不会自动更新。',
                )
          }}
        </p>
        <label
          >{{ exporting ? tr('本机保存目录') : tr('本机镜像归档') }}
          <div class="docker-archive-picker">
            <input
              :value="displayLocalPath(path)"
              readonly
              :aria-label="exporting ? tr('本机保存目录') : tr('本机镜像归档')"
            /><button
              type="button"
              class="button"
              :disabled="busy || picking || done"
              @click="pick"
            >
              {{ tr('选择…') }}
            </button>
          </div>
        </label>
        <label v-if="exporting"
          >{{ tr('文件名（.tar）')
          }}<input v-model="name" :disabled="busy || done" :aria-label="tr('文件名（.tar）')"
        /></label>
        <p v-if="exporting && path" class="subtle">{{ displayLocalPath(target) }}</p>
        <p v-if="!valid && path" class="banner error">
          {{ tr('请选择有效文件；导出文件名须以 .tar 结尾，不能包含路径分隔符。') }}
        </p>
        <div v-if="busy" role="status">
          <p>{{ stageLabel }}</p>
          <template v-if="progress?.transfer">
            <progress
              :value="progress.transfer.transferredBytes"
              :max="progress.transfer.totalBytes || 1"
            />
            <p v-if="transferring">
              {{
                tr(
                  '{0} / {1} MB · {2} MB/s',
                  (progress.transfer.transferredBytes / 1_000_000).toFixed(2),
                  (progress.transfer.totalBytes / 1_000_000).toFixed(2),
                  (progress.transfer.bytesPerSecond / 1_000_000).toFixed(2),
                )
              }}
            </p>
            <p v-else>
              {{
                tr(
                  '{0} / {1} MB',
                  (progress.transfer.transferredBytes / 1_000_000).toFixed(2),
                  (progress.transfer.totalBytes / 1_000_000).toFixed(2),
                )
              }}
            </p>
          </template>
          <progress v-else :aria-label="stageLabel" />
          <p v-if="progress?.stage === 'verifying'" class="subtle">
            {{ tr('归档字节已传完，正在回读校验并安全保存；大文件可能需要较长时间。') }}
          </p>
          <p v-if="progress?.stage === 'loading'" class="subtle">
            {{ tr('归档已通过校验，正在加载到 Docker；此阶段没有文件传输速度。') }}
          </p>
        </div>
        <p v-if="done" class="banner success" role="status">
          {{
            exporting
              ? tr('镜像已导出到：{0}', displayLocalPath(target))
              : tr('镜像导入完成，请核对镜像列表。')
          }}
        </p>
        <p v-if="error" class="banner error" role="alert">{{ error }}</p>
        <details v-if="progress?.output">
          <summary>{{ tr('任务输出') }}</summary>
          <pre>{{ progress.output }}</pre>
        </details>
        <p v-if="busy" class="subtle">
          {{ tr('取消不会回滚已导入的镜像；异常后请刷新核对，不要直接重复执行。') }}
        </p>
      </div>
      <footer class="dialog-actions">
        <button type="button" class="button" :disabled="picking" @click="close">
          {{ busy ? tr('取消任务') : tr('关闭') }}
        </button>
        <button
          v-if="!done"
          type="submit"
          class="button primary"
          :disabled="busy || picking || !valid"
        >
          {{ exporting ? tr('导出') : tr('上传并导入') }}
        </button>
      </footer>
    </form>
  </Modal>
</template>
