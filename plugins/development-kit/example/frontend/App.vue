<script setup lang="ts">
import { errorMessage, invoke } from '@serverdeck/plugin-sdk';
import { ref } from 'vue';

const name = ref('');
const output = ref('');
const error = ref('');
const busy = ref(false);

async function greet() {
  output.value = '';
  error.value = '';
  busy.value = true;
  try {
    const result = await invoke<{ output: string }>('greet', { name: name.value });
    output.value = result.output;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="hello-example">
    <h1>问候示例</h1>
    <p>输入姓名，调用这个插件的 WASM 动作。</p>
    <form @submit.prevent="greet">
      <label>姓名 <input v-model="name" required maxlength="80" /></label>
      <button class="button" :disabled="busy">{{ busy ? '正在生成…' : '生成问候' }}</button>
    </form>
    <p v-if="output" role="status">{{ output }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.hello-example {
  padding: 16px;
}
form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
</style>
