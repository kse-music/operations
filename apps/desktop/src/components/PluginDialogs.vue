<script setup lang="ts">
import Modal from './Modal.vue';
import { usePluginsStore } from '../stores/plugins';
const plugins = usePluginsStore();
</script>
<template>
  <Modal v-if="plugins.prompt" :title="plugins.prompt.title" @close="plugins.decide(false)"
    ><p class="plugin-prompt">{{ plugins.prompt.message }}</p>
    <footer class="action-row">
      <button class="button" @click="plugins.decide(false)">
        {{ plugins.t('取消', 'Cancel') }}</button
      ><button class="button danger" @click="plugins.decide(true)">
        {{ plugins.t('明确确认', 'Confirm') }}
      </button>
    </footer></Modal
  >
</template>
