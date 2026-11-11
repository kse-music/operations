<script setup lang="ts">
import { tr } from '../i18n/messages';

import Modal from './Modal.vue';
import { usePluginsStore } from '../stores/plugins';
import { ref, watch } from 'vue';
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
    ><p class="plugin-prompt">{{ plugins.prompt.message }}</p>
    <label v-if="plugins.prompt.confirmationText"
      >{{ tr('请输入确认文字：') }}<code>{{ plugins.prompt.confirmationText }}</code
      ><input v-model="phrase" :aria-label="tr('插件操作确认文字')" autocomplete="off"
    /></label>
    <footer class="dialog-actions">
      <button class="button" @click="plugins.decide(false)">{{ tr('取消') }}</button
      ><button
        class="button danger"
        :disabled="!!plugins.prompt.confirmationText && phrase !== plugins.prompt.confirmationText"
        @click="plugins.decide(true)"
      >
        {{ plugins.prompt.confirmLabel ?? tr('明确确认') }}
      </button>
    </footer></Modal
  >
</template>
<style scoped>
.plugin-prompt {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 55vh;
  overflow: auto;
}
</style>
