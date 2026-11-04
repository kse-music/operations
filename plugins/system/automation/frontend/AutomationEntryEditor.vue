<script setup lang="ts">
import { useErrorNotifications } from '@serverdeck/plugin-sdk/composables/error-notifications';
import { reactive, ref } from 'vue';
import Modal from '@serverdeck/plugin-sdk/ui/Modal.vue';
import { useAutomationApi } from '@serverdeck/plugin-sdk/services/plugin-tool-services';
const automationApi = useAutomationApi();
import {
  entryInput,
  type Entry,
  type EntryInput,
  type Group,
} from '@serverdeck/plugin-sdk/types/automation';
import { errorMessage } from '@serverdeck/plugin-sdk/services/ipc';
const props = defineProps<{ entry?: Entry; template?: EntryInput; groups: Group[] }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const form = reactive(entryInput(props.entry ?? props.template)),
  busy = ref(false),
  error = ref('');
async function save() {
  busy.value = true;
  error.value = '';
  try {
    const input = entryInput(form);
    input.parameters = input.parameters.map((p) => ({
      ...p,
      default: p.secret || p.default === '' ? null : p.default,
    }));
    await automationApi.save(props.entry?.id ?? null, props.entry?.revision ?? null, input);
    emit('saved');
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
function add() {
  form.parameters.push({
    name: `arg${form.parameters.length + 1}`,
    label: `参数 ${form.parameters.length + 1}`,
    kind: 'text',
    required: true,
    secret: false,
    default: null,
  });
}
useErrorNotifications(error);
</script>
<template>
  <Modal
    :title="entry ? '编辑命令 / 脚本' : '新建命令 / 脚本'"
    wide
    :busy="busy"
    @close="emit('close')"
    ><form class="automation-form" @submit.prevent="save">
      <div class="ops-toolbar">
        <label
          >名称<input
            v-model="form.name"
            required
            maxlength="128"
            aria-label="自动化条目名称" /></label
        ><label
          >类型<select
            v-model="form.kind"
            aria-label="自动化条目类型"
            @change="form.kind === 'command' && (form.parameters = [])"
          >
            <option value="command">常用命令</option>
            <option value="script">Shell 脚本</option>
          </select></label
        ><label
          >分组<select v-model="form.groupId" aria-label="条目分组">
            <option :value="null">未分组</option>
            <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select></label
        ><label
          >风险<select v-model="form.risk" aria-label="条目风险等级">
            <option value="normal">普通</option>
            <option value="dangerous">危险（每次明确确认）</option>
          </select></label
        ><label><input v-model="form.favorite" type="checkbox" />收藏</label>
      </div>
      <label
        >描述<textarea
          v-model="form.description"
          maxlength="8192"
          rows="2"
          aria-label="自动化条目描述"
        ></textarea>
      </label>
      <label
        >实际 Shell 正文<textarea
          v-model="form.body"
          required
          maxlength="65536"
          rows="8"
          spellcheck="false"
          aria-label="自动化条目正文"
        ></textarea>
      </label>
      <p class="subtle">
        以 /bin/sh 非交互执行，参数为 "$1"、"$2"…，不做正文模板替换。Shell
        正文本身可执行任意操作；参数需正确引用，eval 或再次 sh -c
        会重新解释输入。不要把密码写入正文或普通默认值。
      </p>
      <section v-if="form.kind === 'script'">
        <h3>参数定义（顺序决定 $1、$2…）</h3>
        <div v-for="(p, i) in form.parameters" :key="i" class="automation-param ops-detail">
          <strong>${{ i + 1 }}</strong>
          <div class="ops-toolbar">
            <label
              >参数名<input
                v-model="p.name"
                required
                maxlength="64"
                :aria-label="`参数 ${i + 1} 名称`" /></label
            ><label>显示名称<input v-model="p.label" required maxlength="128" /></label
            ><label
              >类型<select v-model="p.kind">
                <option value="text">文本</option>
                <option value="integer">整数</option>
                <option value="port">端口</option>
                <option value="path">远端绝对路径</option>
                <option value="host">IP / 域名</option>
              </select></label
            ><label><input v-model="p.required" type="checkbox" />必填</label
            ><label
              ><input
                v-model="p.secret"
                type="checkbox"
                :aria-label="`参数 ${i + 1} 为秘密`"
                @change="p.default = null"
              />秘密</label
            ><label v-if="!p.secret">普通默认值<input v-model="p.default" maxlength="4096" /></label
            ><button type="button" class="button" @click="form.parameters.splice(i, 1)">
              移除此参数
            </button>
          </div>
        </div>
        <button type="button" class="button" :disabled="form.parameters.length >= 32" @click="add">
          添加脚本参数
        </button>
      </section>
      <div class="ops-toolbar">
        <label
          >默认每台超时（秒）<input
            v-model.number="form.timeoutSecs"
            type="number"
            min="1"
            max="3600"
            required /></label
        ><label
          >默认并发<input
            v-model.number="form.concurrency"
            type="number"
            min="1"
            max="8"
            required /></label
        ><label
          ><input
            v-model="form.retainOutput"
            type="checkbox"
            aria-label="持久化任务输出"
          />保存执行输出（可能含敏感内容）</label
        >
      </div>
      <p class="subtle">
        默认只持久化状态/退出码与非秘密参数。含秘密参数时无论此选项如何均不展示或保存输出。修改正文、参数、风险或执行选项会停用关联计划；收藏、名称、分组和描述修改不影响计划授权。
      </p>

      <footer class="dialog-actions">
        <button type="button" class="button" :disabled="busy" @click="emit('close')">取消</button
        ><button class="button primary" :disabled="busy">保存条目</button>
      </footer>
    </form></Modal
  >
</template>
