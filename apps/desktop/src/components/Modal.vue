<script setup lang="ts">
import { onMounted, ref } from 'vue';
const props = defineProps<{ title: string; busy?: boolean; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
onMounted(() => dialog.value?.showModal());
function close(): void {
  if (!props.busy) emit('close');
}
</script>
<template>
  <Teleport to="body">
    <dialog ref="dialog" :class="['modal', { wide }]" :aria-label="title" @cancel.prevent="close">
      <header class="modal-heading">
        <h2>{{ title }}</h2>
        <button
          class="icon-button"
          type="button"
          aria-label="关闭对话框"
          :disabled="busy"
          @click="close"
        >
          ×
        </button>
      </header>
      <slot />
    </dialog>
  </Teleport>
</template>
