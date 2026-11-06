<script setup lang="ts">
import Modal from './Modal.vue';
import { usePluginsStore } from '../stores/plugins';
import { ref, watch } from 'vue';
import { CircleAlert } from '@lucide/vue';
const plugins = usePluginsStore();
const phrase = ref('');
watch(
  () => plugins.prompt,
  () => {
    phrase.value = '';
  },
);
</script>
<template>
  <Modal v-if="plugins.prompt" :title="plugins.prompt.title" @close="plugins.decide(false)"
    ><div v-if="plugins.prompt.imageRemoval" class="image-removal-review">
      <p class="image-removal-intro">
        <CircleAlert :size="20" aria-hidden="true" />确认后将从以下主机删除此镜像。
      </p>
      <dl class="image-removal-details">
        <div>
          <dt>目标主机</dt>
          <dd>
            <strong>{{ plugins.prompt.imageRemoval.hostName }}</strong
            ><span>{{ plugins.prompt.imageRemoval.hostAddress }}</span>
          </dd>
        </div>
        <div>
          <dt>镜像 ID</dt>
          <dd>
            <code>{{ plugins.prompt.imageRemoval.imageId }}</code>
          </dd>
        </div>
      </dl>
      <p class="image-removal-note">{{ plugins.prompt.message }}</p>
      <p class="image-removal-source">
        由 {{ plugins.prompt.imageRemoval.pluginName }} v{{
          plugins.prompt.imageRemoval.pluginVersion
        }}
        发起 · 本次确认 60 秒内有效
      </p>
    </div>
    <p v-else class="plugin-prompt">{{ plugins.prompt.message }}</p>
    <label v-if="plugins.prompt.confirmationText"
      >请输入确认文字：<code>{{ plugins.prompt.confirmationText }}</code
      ><input v-model="phrase" aria-label="插件操作确认文字" autocomplete="off"
    /></label>
    <footer :class="plugins.prompt.imageRemoval ? 'dialog-actions' : 'action-row'">
      <button class="button" @click="plugins.decide(false)">
        {{ plugins.t('取消', 'Cancel') }}</button
      ><button
        class="button danger"
        :disabled="!!plugins.prompt.confirmationText && phrase !== plugins.prompt.confirmationText"
        @click="plugins.decide(true)"
      >
        {{ plugins.prompt.imageRemoval ? '确认删除' : plugins.t('明确确认', 'Confirm') }}
      </button>
    </footer></Modal
  >
</template>

<style scoped>
.image-removal-review {
  display: grid;
  gap: 18px;
  margin-top: 20px;
  min-width: 0;
}
.image-removal-review p,
.image-removal-details {
  margin: 0;
}
.image-removal-intro {
  display: flex;
  align-items: center;
  gap: 10px;
  line-height: 1.6;
}
.image-removal-intro svg {
  color: var(--error);
  flex-shrink: 0;
}
.image-removal-details {
  display: grid;
  gap: 18px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}
.image-removal-details > div {
  display: grid;
  gap: 7px;
  min-width: 0;
}
.image-removal-details dt,
.image-removal-source {
  color: var(--muted);
  font-size: calc(12px * var(--interface-font-scale, 1));
}
.image-removal-details dd {
  display: grid;
  gap: 5px;
  margin: 0;
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.image-removal-details dd > span {
  color: var(--muted);
  font-size: calc(12px * var(--interface-font-scale, 1));
}
.image-removal-details code {
  font-size: calc(12px * var(--interface-font-scale, 1));
  user-select: text;
}
.image-removal-note {
  padding: 12px 14px;
  border-radius: 6px;
  background: var(--hover);
  color: var(--muted);
  font-size: calc(12px * var(--interface-font-scale, 1));
  line-height: 1.7;
}
.image-removal-source {
  line-height: 1.6;
  overflow-wrap: anywhere;
}
</style>
