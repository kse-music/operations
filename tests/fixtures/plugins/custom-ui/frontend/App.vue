<script setup lang="ts">
import { ref } from 'vue';
import { invoke, request, errorMessage } from '@serverdeck/plugin-sdk';
const name = ref(''),
  output = ref(''),
  error = ref(''),
  busy = ref(false);
async function greet() {
  busy.value = true;
  error.value = '';
  try {
    output.value = (await invoke<{ output: string }>('greet', { name: name.value })).output;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
async function checkPermission() {
  try {
    await request('hosts.list');
    error.value = '检测失败：意外获得宿主能力';
  } catch (cause) {
    error.value =
      cause &&
      typeof cause === 'object' &&
      'code' in cause &&
      cause.code === 'PLUGIN_PERMISSION_DENIED'
        ? '未授权能力已拒绝'
        : errorMessage(cause);
  }
}
</script>
<template>
  <section aria-label="自定义插件工作区">
    <h1>完全由上传包定义的页面</h1>
    <form @submit.prevent="greet">
      <label>姓名<input v-model="name" aria-label="姓名" /></label
      ><button class="button" :disabled="busy">{{ busy ? '正在调用…' : '调用自己的 WASM' }}</button>
    </form>
    <button class="button" @click="checkPermission">检查权限隔离</button>
    <p v-if="output" role="status">{{ output }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
