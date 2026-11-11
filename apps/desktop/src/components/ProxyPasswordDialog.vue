<script setup lang="ts">
import { tr } from '../i18n/messages';

import { onBeforeUnmount, ref } from 'vue';
import Modal from './Modal.vue';
import { useHostsStore } from '../stores/hosts';
import { hostsApi } from '../services/hosts';

const emit = defineEmits<{ close: []; saved: [id: string] }>();
const store = useHostsStore();
const name = ref('');
const password = ref('');
onBeforeUnmount(() => {
  password.value = '';
});

async function submit(): Promise<void> {
  const result = await store.run(
    () =>
      hostsApi.credentialSave(null, null, {
        name: name.value,
        kind: 'password',
        keyPath: null,
        secret: password.value,
        clearSecret: false,
      }),
    tr('代理密码已保存。'),
  );
  if (result.ok) {
    password.value = '';
    emit('saved', result.value.value.id);
  }
}
</script>

<template>
  <Modal :title="tr('新建代理密码')" :busy="store.busy" @close="emit('close')">
    <form class="editor-form" @submit.prevent="submit">
      <fieldset :disabled="store.busy">
        <label>{{ tr('名称') }}<input v-model="name" autofocus maxlength="128" required /></label>
        <label
          >{{ tr(' 代理密码 ')
          }}<input
            v-model="password"
            type="password"
            autocomplete="new-password"
            maxlength="2048"
            required
          />
        </label>
      </fieldset>
      <p class="subtle">{{ tr('保存到系统凭据库，可供其他代理配置使用。') }}</p>
      <footer class="dialog-actions">
        <button class="button" type="button" :disabled="store.busy" @click="emit('close')">
          {{ tr(' 取消 ') }}
        </button>
        <button class="button primary" type="submit" :disabled="store.busy">
          {{ store.busy ? tr('保存中…') : tr('保存代理密码') }}
        </button>
      </footer>
    </form>
  </Modal>
</template>
