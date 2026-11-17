<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';

const props = defineProps<{
  name: string;
  label: string;
  required: boolean;
  busy: boolean;
  error: string | null;
}>();
const emit = defineEmits<{
  change: [name: string];
  submit: [reason: 'enter' | 'blur'];
  cancel: [];
}>();
const input = ref<HTMLInputElement>();
onMounted(() => {
  input.value?.focus({ preventScroll: true });
  input.value?.select();
});
function keys(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229 || props.busy || event.repeat) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    emit('submit', 'enter');
  } else if (event.key === 'Escape') {
    event.preventDefault();
    emit('cancel');
  }
}
async function blur(): Promise<void> {
  await nextTick();
  if (input.value?.isConnected && document.activeElement !== input.value && !props.busy)
    emit('submit', 'blur');
}
</script>

<template>
  <span
    class="tree-rename"
    :aria-busy="busy"
    @pointerdown.stop
    @click.stop
    @dblclick.stop
    @contextmenu.stop
  >
    <input
      ref="input"
      class="tree-rename-input"
      :value="name"
      :aria-label="label"
      :aria-invalid="!!error"
      :aria-describedby="error ? 'tree-rename-error' : undefined"
      :readonly="busy"
      :required="required"
      maxlength="128"
      @input="emit('change', ($event.target as HTMLInputElement).value)"
      @keydown.stop="keys"
      @blur="blur"
    />
    <span v-if="error" id="tree-rename-error" class="tree-rename-error error-text" role="alert">
      {{ error }}
    </span>
  </span>
</template>
