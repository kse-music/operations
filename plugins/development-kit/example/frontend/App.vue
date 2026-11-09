<script setup lang="ts">
import { errorMessage, invoke } from '@serverdeck/plugin-sdk';
import { ref } from 'vue';
import type { PluginUiPage } from '@serverdeck/plugin-sdk/types/plugins';
const props = defineProps<{ page?: PluginUiPage; hostId?: string }>();
const memory = ref<{
  total: number;
  used: number;
  available: number;
  status: string;
  sampledAt: number;
}>();
async function inspect() {
  busy.value = true;
  error.value = '';
  memory.value = undefined;
  try {
    memory.value = await invoke('inspect_memory', { hostId: props.hostId ?? '' });
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}

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
  <section v-if="page?.id !== 'host'" class="hello-example">
    <h1>问候示例</h1>
    <p>输入姓名，调用这个插件的 WASM 动作。</p>
    <form @submit.prevent="greet">
      <label>姓名 <input v-model="name" required maxlength="80" /></label>
      <button class="button" :disabled="busy">{{ busy ? '正在生成…' : '生成问候' }}</button>
    </form>
    <p v-if="output" role="status">{{ output }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
  <section v-else class="hello-example">
    <h1>内存巡检示例</h1>
    <p>插件负责命令、解析和健康判断；平台负责 SSH、目标验证与确认。</p>
    <button class="button" :disabled="busy || !hostId" @click="inspect">
      {{ busy ? '正在读取…' : '读取主机内存' }}
    </button>
    <p v-if="!hostId" role="status">请从主机工作区打开此页面。</p>
    <div v-if="memory">
      <p>{{ memory.status }}</p>
      <p>
        总量 {{ memory.total }} 字节 · 已用 {{ memory.used }} 字节 · 可用
        {{ memory.available }} 字节
      </p>
      <p>{{ new Date(memory.sampledAt).toLocaleString() }}</p>
    </div>
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
