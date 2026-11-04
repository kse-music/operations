<script setup lang="ts">
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
      >请输入确认文字：<code>{{ plugins.prompt.confirmationText }}</code
      ><input v-model="phrase" aria-label="插件操作确认文字" autocomplete="off"
    /></label>
    <footer class="action-row">
      <button class="button" @click="plugins.decide(false)">
        {{ plugins.t('取消', 'Cancel') }}</button
      ><button
        class="button danger"
        :disabled="!!plugins.prompt.confirmationText && phrase !== plugins.prompt.confirmationText"
        @click="plugins.decide(true)"
      >
        {{ plugins.t('明确确认', 'Confirm') }}
      </button>
    </footer></Modal
  >
</template>
