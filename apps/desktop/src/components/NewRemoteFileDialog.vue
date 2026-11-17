<script setup lang="ts">
import { computed, ref } from 'vue';
import Modal from './Modal.vue';
import { tr } from '../i18n/messages';

const props = defineProps<{ busy: boolean; error: string | null }>();
const emit = defineEmits<{ close: []; submit: [name: string] }>();
const name = ref('');
const help = ref(false);
const valid = computed(
  () =>
    !!name.value.trim() &&
    !['.', '..'].includes(name.value) &&
    !name.value.includes('/') &&
    !name.value.includes('\0'),
);
function submit(): void {
  if (!props.busy && valid.value) emit('submit', name.value);
}
</script>

<template>
  <Modal :title="tr('编辑文件')" panel-class="new-file-dialog" :busy="busy" @close="emit('close')">
    <form class="editor-form new-file-form" @submit.prevent="submit">
      <label>
        {{ tr('输入文件名') }}
        <input v-model="name" autofocus required maxlength="255" :disabled="busy" />
      </label>
      <p v-if="help" id="new-file-help" class="hint">
        {{
          tr('在当前远程目录创建空白文件并打开内置编辑器。同名文件、目录或链接已存在时不会覆盖。')
        }}
      </p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <footer class="dialog-actions">
        <button class="button primary" type="submit" :disabled="busy || !valid">
          {{ busy ? tr('正在打开编辑器…') : tr('确定') }}
        </button>
        <button class="button" type="button" :disabled="busy" @click="emit('close')">
          {{ tr('取消') }}
        </button>
        <button
          class="button"
          type="button"
          :aria-expanded="help"
          aria-controls="new-file-help"
          @click="help = !help"
        >
          {{ tr('帮助') }}
        </button>
      </footer>
    </form>
  </Modal>
</template>

<style scoped>
.new-file-form {
  gap: 14px;
  margin-top: 0;
}
.new-file-form p {
  margin: 0;
  overflow-wrap: anywhere;
}
.new-file-form .dialog-actions {
  margin-top: 0;
  padding-top: 0;
  border: 0;
  gap: 12px;
}
.dialog-actions .button {
  min-width: 92px;
}
</style>
