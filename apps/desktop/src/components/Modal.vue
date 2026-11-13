<script setup lang="ts">
import { tr } from '../i18n/messages';

import { onMounted, ref } from 'vue';
import { X } from '@lucide/vue';
const props = defineProps<{
  title: string;
  busy?: boolean;
  wide?: boolean;
  focusHeading?: boolean;
  panelClass?: string;
  closeLabel?: string;
}>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
onMounted(() => dialog.value?.showModal());
function close(): void {
  if (!props.busy) emit('close');
}
</script>
<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      :class="['modal', panelClass, { wide }]"
      :aria-label="title"
      @cancel.prevent="close"
    >
      <slot name="header"
        ><header class="modal-heading">
          <h2 :tabindex="focusHeading ? -1 : undefined" :autofocus="focusHeading">{{ title }}</h2>
          <button
            class="icon-button"
            type="button"
            :aria-label="closeLabel ?? tr('关闭对话框')"
            :title="closeLabel ?? tr('关闭对话框')"
            :disabled="busy"
            @click="close"
          >
            <X :size="16" aria-hidden="true" />
          </button></header
      ></slot>
      <slot />
    </dialog>
  </Teleport>
</template>

<style scoped>
.modal-heading h2[autofocus]:focus {
  outline: none;
}
</style>
