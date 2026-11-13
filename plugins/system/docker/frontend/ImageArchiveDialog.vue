<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Modal from '@serverdeck/plugin-sdk/ui/Modal.vue';
import { pickLocalFiles } from '@serverdeck/plugin-sdk/local-files';
import { displayLocalPath } from '@serverdeck/plugin-sdk/paths';
import { cancelCurrent } from '@serverdeck/plugin-sdk/actions';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
import { useErrorNotifications } from '@serverdeck/plugin-sdk/composables/error-notifications';
import { usePlatformContext } from '@serverdeck/plugin-sdk/context';
import {
  runImageArchive,
  archiveFileName,
  imageReference,
  localFileName,
  validArchiveName,
  inspectImageTarget,
  type ArchiveProgress,
} from './image-archive';
import { tr } from './i18n/messages';
const props = defineProps<{
  hostId: string;
  hostLabel: string;
  row?: Record<string, unknown>;
  remoteTransfer?: boolean;
  visible: boolean;
}>();
const emit = defineEmits<{ close: []; completed: [] }>();
const exporting = computed(() => !!props.row && !props.remoteTransfer);
const platform = usePlatformContext();
const targets = computed(() => platform.hosts.filter((host) => host.id !== props.hostId));
const targetHostId = ref('');
const conflict = ref<string | null>(null);
const conflictNotice = ref<HTMLElement>();
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
const valid = computed(() =>
  props.remoteTransfer
    ? !!props.row && targets.value.some((host) => host.id === targetHostId.value)
    : !!path.value &&
      validArchiveName(exporting.value ? name.value : localFileName(path.value)) &&
      (!exporting.value || name.value.toLowerCase().endsWith('.tar')),
);
const stageLabel = computed(
  () =>
    ({
      preparing: tr('正在准备…'),
      uploading: tr('正在上传镜像归档…'),
      transferring: tr('正在中转镜像归档…'),
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
    ['uploading', 'downloading', 'transferring'].includes(value.stage) &&
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
    let expectedTargetId: string | null = null;
    const replaceConfirmed = conflict.value !== null;
    if (props.remoteTransfer) {
      expectedTargetId =
        conflict.value ??
        (await inspectImageTarget(
          targetHostId.value,
          imageReference(props.row!),
          controller.signal,
        ));
      if (expectedTargetId && expectedTargetId !== String(props.row!.ID) && !replaceConfirmed) {
        conflict.value = expectedTargetId;
        await nextTick();
        conflictNotice.value?.scrollIntoView?.({ block: 'start' });
        return;
      }
    }
    await runImageArchive(
      props.hostId,
      props.remoteTransfer
        ? {
            kind: 'transfer',
            id: String(props.row!.ID),
            reference: imageReference(props.row!),
            fileName: archiveFileName(props.row!),
            targetHostId: targetHostId.value,
            expectedTargetId,
            replaceConfirmed,
            confirmed: true,
          }
        : exporting.value
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
    if (!disposed) {
      error.value = errorMessage(cause);
      conflict.value = null;
    }
  } finally {
    if (!disposed) busy.value = false;
  }
}
watch(targetHostId, () => {
  conflict.value = null;
  error.value = '';
});
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
  <Modal
    :title="remoteTransfer ? tr('远程传输镜像') : exporting ? tr('导出镜像') : tr('导入镜像')"
    :busy="picking"
    @close="close"
  >
    <form class="docker-archive" @submit.prevent="start">
      <div class="docker-archive-content">
        <p>
          {{ remoteTransfer ? tr('来源主机：{0}', hostLabel) : tr('目标主机：{0}', hostLabel) }}
        </p>
        <p v-if="row">{{ tr('镜像：{0}', imageReference(row)) }}</p>
        <p class="subtle">
          {{
            remoteTransfer
              ? tr(
                  '经本机中转到目标主机并自动导入，保留所选标签；无标签镜像按 ID 传输。不会自动更新或重启已有容器。',
                )
              : exporting
                ? tr(
                    '生成 tar 归档并下载到本机，保留所选标签；无标签镜像按 ID 导出。不会覆盖已有文件。',
                  )
                : tr(
                    '选择其它环境通过 docker save 生成的归档，上传后执行 load。归档中的同名标签可能被替换，已有容器不会自动更新。',
                  )
          }}
        </p>
        <template v-if="remoteTransfer">
          <label
            >{{ tr('目标主机') }}
            <select v-model="targetHostId" :disabled="busy || done" :aria-label="tr('目标主机')">
              <option disabled value="">{{ tr('请选择目标主机') }}</option>
              <option v-for="host in targets" :key="host.id" :value="host.id">
                {{ host.name || host.hostname }} ({{ host.username }}@{{ host.hostname }}:{{
                  host.port
                }})
              </option>
            </select>
          </label>
          <p v-if="!targets.length" class="subtle">
            {{ tr('没有其它可选主机，请先在主机管理中添加目标主机。') }}
          </p>
          <p v-if="conflict && !done" ref="conflictNotice" class="banner" role="alert">
            {{
              tr(
                '目标已有标签 {0}，当前指向 {1}。确认后将替换为来源镜像 {2}，已有容器保持不变。',
                imageReference(row!),
                conflict,
                String(row!.ID),
              )
            }}
          </p>
        </template>
        <label v-else
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
            remoteTransfer
              ? tr('镜像已传输并导入目标主机。')
              : exporting
                ? tr('镜像已导出到：{0}', displayLocalPath(target))
                : tr('镜像导入完成，请核对镜像列表。')
          }}
        </p>
        <p v-if="error" role="status">{{ tr('镜像任务失败，请查看错误通知和任务输出。') }}</p>
        <details v-if="progress?.output" :open="!!error">
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
          {{
            remoteTransfer
              ? conflict
                ? tr('确认替换并传输')
                : tr('传输并导入')
              : exporting
                ? tr('导出')
                : tr('上传并导入')
          }}
        </button>
      </footer>
    </form>
  </Modal>
</template>
