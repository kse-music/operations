<script setup lang="ts">
import { ref, watch } from 'vue';
import ProductSettings from './ProductSettings.vue';
import { defaultProductPreferences } from '../types/product';
import { useApplicationStore } from '../stores/application';
import type { AppConfig } from '../types/ipc';
import { shortcutLabels, shortcutKey, defaultTerminalPreferences } from '../types/preferences';

const application = useApplicationStore();
const draft = ref<AppConfig | null>(null);
let baseline = '';
const submitting = ref(false);
watch(
  () => application.state?.config,
  (config) => {
    if (config && draft.value && !submitting.value && JSON.stringify(draft.value) !== baseline) {
      draft.value.sidebarWidth = config.sidebarWidth;
      baseline = JSON.stringify(config);
      return;
    }
    draft.value = config ? (JSON.parse(JSON.stringify(config)) as AppConfig) : null;
    if (draft.value) draft.value.product ??= defaultProductPreferences();
    baseline = JSON.stringify(draft.value);
  },
  { immediate: true },
);

async function submit(): Promise<void> {
  if (draft.value) {
    submitting.value = true;
    try {
      await application.save(draft.value);
    } finally {
      submitting.value = false;
    }
  }
}
function capture(action: string, event: KeyboardEvent): void {
  if (event.key === 'Tab') return;
  event.preventDefault();
  const key = shortcutKey(event);
  if (key && draft.value) draft.value.terminal.shortcuts[action] = key;
}
</script>

<template>
  <section class="settings-panel" aria-labelledby="settings-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">PREFERENCES</p>
        <h1 id="settings-title">全局设置</h1>
      </div>
      <span class="subtle">仅保存在此设备</span>
    </div>
    <p class="section-description">保存后应用界面和终端偏好。连接参数在新建连接时生效。</p>
    <form v-if="draft" class="settings-form" @submit.prevent="submit">
      <fieldset :disabled="application.saving">
        <label
          >每主机并发传输数<input
            v-model.number="draft.transferConcurrency"
            aria-label="每主机并发传输数"
            type="number"
            min="1"
            max="6"
            required
        /></label>
        <label
          >外观主题
          <select v-model="draft.theme" data-testid="theme-select">
            <option value="dark">深色</option>
            <option value="light">浅色</option>
            <option value="system">跟随系统</option>
          </select>
        </label>
        <label
          >侧边栏宽度 <span class="subtle">{{ draft.sidebarWidth }} px</span>
          <input v-model.number="draft.sidebarWidth" type="range" min="200" max="400" />
        </label>
        <label
          >终端字号 <span class="subtle">应用于已打开及新建终端</span>
          <input v-model.number="draft.terminalFontSize" type="number" min="10" max="32" required />
        </label>
        <label
          >SSH 连接超时（秒）
          <input
            v-model.number="draft.connectTimeoutSecs"
            type="number"
            min="1"
            max="120"
            required
          />
        </label>
        <label
          >终端字体<input
            v-model="draft.terminal.fontFamily"
            maxlength="128"
            required
            aria-label="终端字体"
        /></label>
        <label
          >终端行高（%）<input
            v-model.number="draft.terminal.lineHeight"
            type="number"
            min="100"
            max="200"
            required
            aria-label="终端行高"
        /></label>
        <label
          >滚动历史行数<input
            v-model.number="draft.terminal.scrollback"
            type="number"
            min="0"
            max="20000"
            required
            aria-label="滚动历史行数"
        /></label>
        <label
          >终端主题<select v-model="draft.terminal.theme" aria-label="终端主题">
            <option value="deck">ServerDeck 深色</option>
            <option value="light">浅色</option>
            <option value="nord">Nord</option>
            <option value="solarized">Solarized Dark</option>
          </select></label
        >
        <label
          >光标样式<select v-model="draft.terminal.cursorStyle" aria-label="光标样式">
            <option value="block">方块</option>
            <option value="bar">竖线</option>
            <option value="underline">下划线</option>
          </select></label
        >
        <label class="checkbox-label"
          ><input v-model="draft.terminal.cursorBlink" type="checkbox" />光标闪烁</label
        >
        <label
          >大文本粘贴确认阈值（字符）<input
            v-model.number="draft.terminal.pasteConfirmChars"
            type="number"
            min="256"
            max="65536"
            required
        /></label>
        <label
          >监控采样间隔
          <select v-model.number="draft.monitorIntervalSecs">
            <option :value="3">3 秒</option>
            <option :value="5">5 秒</option>
            <option :value="10">10 秒</option>
            <option :value="30">30 秒</option>
          </select>
        </label>
        <label
          >日志级别 <span class="subtle">重启后生效</span>
          <select v-model="draft.logLevel">
            <option value="error">ERROR</option>
            <option value="warn">WARN</option>
            <option value="info">INFO</option>
            <option value="debug">DEBUG</option>
          </select>
        </label>
      </fieldset>
      <fieldset :disabled="application.saving">
        <legend>终端快捷键</legend>
        <p class="subtle">
          选中后按新组合键。使用 Ctrl+Shift、Meta+Shift 或 Ctrl+Alt，避免拦截远端 Ctrl+C / Z
          等常用按键。
        </p>
        <label v-for="(label, action) in shortcutLabels" :key="action"
          >{{ label
          }}<input
            :value="draft.terminal.shortcuts[action]"
            readonly
            :aria-label="`${label}快捷键`"
            @keydown="capture(action, $event)" /></label
        ><button
          type="button"
          class="button"
          @click="draft.terminal.shortcuts = defaultTerminalPreferences().shortcuts"
        >
          恢复默认快捷键
        </button>
      </fieldset>
      <ProductSettings v-model="draft.product" />
      <div class="form-footer">
        <p class="subtle">配置不包含密码、私钥或私钥口令。</p>
        <button class="button primary" type="submit" :disabled="application.saving">
          {{ application.saving ? '保存中…' : '保存设置' }}
        </button>
      </div>
    </form>
    <p v-else class="subtle">连接本地后端后即可读取和修改设置。</p>
  </section>
</template>
