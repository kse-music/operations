<script setup lang="ts">
import { CircleArrowUp, Download, RotateCw, X } from '@lucide/vue';
import { tr } from '../i18n/messages';
import type { UpdateStatus } from '../services/updates';
import { useUpdatesStore } from '../stores/updates';
import Modal from './Modal.vue';
import UpdateDownloadProgress from './UpdateDownloadProgress.vue';
import UpdateReleaseNotes from './UpdateReleaseNotes.vue';

defineProps<{ currentVersion: string; release: NonNullable<UpdateStatus['release']> }>();
const updates = useUpdatesStore();
</script>

<template>
  <Modal
    :title="tr('发现新版本')"
    panel-class="update-notice-dialog"
    :busy="updates.saving"
    @close="updates.closeNotice"
  >
    <template #header>
      <header class="notice-header">
        <div class="notice-icon">
          <CircleArrowUp :size="20" aria-hidden="true" />
        </div>
        <div class="notice-heading">
          <h2 tabindex="-1" autofocus>{{ tr('发现新版本') }}</h2>
          <p class="notice-versions">
            <span>{{ tr('当前 v{0}', currentVersion) }}</span>
            <span aria-hidden="true">→</span>
            <strong>{{ tr('新版本 v{0}', release.version) }}</strong>
          </p>
        </div>
        <button
          class="icon-button"
          type="button"
          :aria-label="tr('关闭更新提示')"
          :disabled="updates.saving"
          @click="updates.closeNotice"
        >
          <X :size="16" aria-hidden="true" />
        </button>
      </header>
    </template>

    <div class="notice-body">
      <h3>{{ tr('更新内容') }}</h3>
      <UpdateReleaseNotes :content="release.notes || tr('此版本未提供更新说明。')" />
      <UpdateDownloadProgress v-if="updates.downloading" />
      <p v-if="updates.state?.phase === 'ready'" class="notice-ready" role="status">
        {{ tr('更新包已验证，可以安装。') }}
      </p>
      <p v-if="updates.error" class="error-text" role="alert">{{ updates.error }}</p>
    </div>

    <footer class="notice-footer">
      <button v-if="updates.downloading" class="button" type="button" @click="updates.cancel">
        {{ tr('取消') }}
      </button>
      <button
        v-else-if="updates.state?.phase !== 'ready'"
        class="button notice-ignore"
        type="button"
        :disabled="updates.busy || updates.saving"
        @click="updates.ignoreNotice"
      >
        {{ tr('忽略此版本') }}
      </button>
      <div class="notice-actions">
        <button
          class="button"
          type="button"
          :disabled="updates.saving"
          @click="updates.closeNotice"
        >
          {{ tr('稍后') }}
        </button>
        <button
          v-if="updates.state?.phase === 'ready'"
          class="button primary"
          type="button"
          :disabled="updates.busy"
          @click="updates.requestInstall"
        >
          <RotateCw :size="16" aria-hidden="true" />
          {{ tr('安装并重启') }}
        </button>
        <button
          v-else
          class="button primary"
          type="button"
          :disabled="updates.busy || updates.saving"
          @click="updates.download"
        >
          <Download :size="16" aria-hidden="true" />
          {{ updates.downloading ? tr('正在下载更新…') : tr('下载更新') }}
        </button>
      </div>
    </footer>
  </Modal>
</template>

<style scoped>
:global(.modal.update-notice-dialog) {
  box-sizing: border-box;
  width: min(560px, calc(100vw - 28px));
  padding: 0;
  background: var(--panel);
}
.notice-header {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  padding: 22px 23px 18px;
}
.notice-icon {
  display: grid;
  flex: 0 0 42px;
  height: 42px;
  place-items: center;
  border-radius: 8px;
  background: var(--accent-bg);
  color: var(--accent);
}
.notice-heading {
  flex: 1;
  min-width: 0;
}
.notice-heading h2 {
  margin: 0;
  font-size: var(--font-size-title);
}
.notice-heading h2:focus {
  outline: none;
}
.notice-versions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  margin: 5px 0 0;
  font-size: var(--font-size-caption);
  color: var(--muted);
}
.notice-versions strong,
.notice-ready {
  color: var(--accent);
}
.notice-header .icon-button {
  flex-shrink: 0;
  border-color: transparent;
}
.notice-body {
  border-block: 1px solid var(--border);
  padding: 17px 23px 19px;
}
.notice-body h3 {
  margin: 0;
  font-size: var(--font-size-body);
}
.notice-body .update-notes {
  margin-top: 8px;
}
.notice-body > p {
  margin: 12px 0 0;
}
.notice-footer,
.notice-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.notice-footer {
  padding: 14px 23px;
}
.notice-actions {
  margin-inline-start: auto;
}
.notice-ignore {
  color: var(--muted);
  border-color: transparent;
  background: transparent;
}
@media (max-width: 430px) {
  .notice-header,
  .notice-body,
  .notice-footer {
    padding-inline: 15px;
  }
}
</style>
