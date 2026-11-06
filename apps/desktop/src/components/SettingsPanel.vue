<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import ProductSettings from './ProductSettings.vue';
import Modal from './Modal.vue';
import { useStorageMigration } from '../composables/storage-migration';
import {
  defaultProductPreferences,
  settingsCategories,
  type SettingsCategory,
} from '../types/product';
import { useApplicationStore } from '../stores/application';
import type { AppConfig } from '../types/ipc';
import {
  defaultInterfaceFontSize,
  defaultTerminalPreferences,
  interfaceFontSizes,
  shortcutKey,
  shortcutLabels,
} from '../types/preferences';

const application = useApplicationStore();
const migration = useStorageMigration();
const { target, preview, discardDocuments, busy, changed } = migration;
const props = withDefaults(defineProps<{ category?: SettingsCategory }>(), { category: 'general' });
const emit = defineEmits<{ category: [category: SettingsCategory] }>();
const categoryLabel = computed(
  () => settingsCategories.find((item) => item.id === props.category)!.label,
);
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
    if (draft.value) {
      draft.value.product ??= defaultProductPreferences();
      draft.value.interfaceFontSize ??= defaultInterfaceFontSize;
    }
    baseline = JSON.stringify(draft.value);
  },
  { immediate: true },
);

const fontSizeStep = computed({
  get: () =>
    interfaceFontSizes.findIndex(
      (size) => size.value === (draft.value?.interfaceFontSize ?? defaultInterfaceFontSize),
    ),
  set: (step: number) => {
    const size = interfaceFontSizes[step];
    if (draft.value && size) draft.value.interfaceFontSize = size.value;
  },
});
watch(
  () =>
    draft.value?.interfaceFontSize === application.state?.config.interfaceFontSize
      ? undefined
      : draft.value?.interfaceFontSize,
  (preview) => (application.interfaceFontSizePreview = preview),
  { immediate: true },
);
onBeforeUnmount(() => (application.interfaceFontSizePreview = undefined));

async function submit(event: Event): Promise<void> {
  const form = event.currentTarget as HTMLFormElement;
  const invalid = form.querySelector<HTMLInputElement | HTMLSelectElement>(
    'input:invalid, select:invalid',
  );
  if (invalid) {
    const panel = invalid.closest('.settings-category');
    const category = settingsCategories.find((item) => panel?.id === `settings-panel-${item.id}`);
    if (category) emit('category', category.id);
    await nextTick();
    invalid.focus();
    invalid.reportValidity();
    return;
  }
  if (draft.value) {
    submitting.value = true;
    try {
      if (changed.value) await migration.review(draft.value);
      else await application.save(draft.value);
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

function restoreDefaults(): void {
  const config = draft.value;
  if (!config) return;
  const product = defaultProductPreferences();
  // Scalar defaults mirror serverdeck_core::AppConfig::default().
  switch (props.category) {
    case 'general':
      config.theme = 'dark';
      config.interfaceFontSize = defaultInterfaceFontSize;
      config.sidebarWidth = 248;
      config.monitorIntervalSecs = 3;
      config.product.language = product.language;
      break;
    case 'terminal':
      config.terminalFontSize = 14;
      config.terminal = { ...defaultTerminalPreferences(), shortcuts: config.terminal.shortcuts };
      config.connectTimeoutSecs = 15;
      config.product.sshDefaults = product.sshDefaults;
      break;
    case 'shortcuts':
      config.terminal.shortcuts = defaultTerminalPreferences().shortcuts;
      config.product.shortcuts = product.shortcuts;
      break;
    case 'storage':
      config.product.downloadDirectory = product.downloadDirectory;
      config.transferConcurrency = 3;
      config.logLevel = 'info';
      target.value = application.state?.storage?.rootDirectory ?? '';
      break;
  }
}
</script>

<template>
  <section class="settings-panel page-view" aria-labelledby="settings-title">
    <div class="section-heading">
      <div>
        <h1 id="settings-title">{{ categoryLabel }}</h1>
        <p class="section-description">界面字号可即时预览，连接参数在新建连接时生效。</p>
      </div>
      <span class="subtle">仅保存在此设备</span>
    </div>
    <form v-if="draft" class="settings-form" novalidate @submit.prevent="submit">
      <div v-show="category === 'general'" id="settings-panel-general" class="settings-category">
        <ProductSettings
          v-model="draft.product"
          section="general"
          :disabled="application.saving || busy"
        >
          <label
            >外观主题
            <select v-model="draft.theme" data-testid="theme-select">
              <option value="dark">深色</option>
              <option value="light">浅色</option>
              <option value="system">跟随系统</option>
            </select>
          </label>
          <div class="settings-field interface-font-size">
            <label for="interface-font-size">界面字号</label>
            <div class="interface-font-ticks">
              <button
                v-for="(size, step) in interfaceFontSizes"
                :key="size.value"
                type="button"
                :aria-pressed="fontSizeStep === step"
                @click="fontSizeStep = step"
              >
                {{ size.label }}
              </button>
            </div>
            <input
              id="interface-font-size"
              v-model.number="fontSizeStep"
              type="range"
              min="0"
              :max="interfaceFontSizes.length - 1"
              step="1"
              :aria-valuetext="interfaceFontSizes[fontSizeStep]?.label"
              aria-describedby="interface-font-size-help"
            />
            <p id="interface-font-size-help" class="subtle">
              即时预览，保存后记住。终端字号单独设置。
            </p>
          </div>
          <label
            ><span class="settings-label"
              >侧边栏宽度 <span class="subtle">{{ draft.sidebarWidth }} px</span></span
            >
            <input
              v-model.number="draft.sidebarWidth"
              aria-label="侧边栏宽度"
              type="range"
              min="200"
              max="400"
            />
          </label>
          <label
            >监控采样间隔<select v-model.number="draft.monitorIntervalSecs">
              <option :value="3">3 秒</option>
              <option :value="5">5 秒</option>
              <option :value="10">10 秒</option>
              <option :value="30">30 秒</option>
            </select></label
          >
        </ProductSettings>
      </div>
      <div v-show="category === 'terminal'" id="settings-panel-terminal" class="settings-category">
        <fieldset :disabled="application.saving || busy">
          <legend>终端显示</legend>
          <div class="settings-fields">
            <label
              >终端字号<input
                v-model.number="draft.terminalFontSize"
                type="number"
                min="10"
                max="32"
                required
            /></label>
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
          </div>
        </fieldset>
        <fieldset :disabled="application.saving || busy">
          <legend>输入与粘贴</legend>
          <div class="settings-fields">
            <label
              >大文本粘贴确认阈值（字符）<input
                v-model.number="draft.terminal.pasteConfirmChars"
                type="number"
                min="256"
                max="65536"
                required
            /></label>
            <div class="settings-field">
              <label class="checkbox-label"
                ><input
                  v-model="draft.terminal.quickCopyPaste"
                  type="checkbox"
                  aria-describedby="quick-copy-paste-help"
                />选中即复制，右键即粘贴</label
              >
              <p id="quick-copy-paste-help" class="subtle settings-help">
                默认关闭，仅在终端内容区生效；大文本粘贴仍需确认。
              </p>
            </div>
          </div>
        </fieldset>
        <ProductSettings
          v-model="draft.product"
          section="connection"
          :disabled="application.saving || busy"
        >
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
        </ProductSettings>
      </div>
      <div
        v-show="category === 'shortcuts'"
        id="settings-panel-shortcuts"
        class="settings-category settings-shortcuts"
      >
        <fieldset :disabled="application.saving || busy">
          <legend>终端快捷键</legend>
          <div class="settings-fields">
            <p class="subtle full-width">
              选中后按新组合键。使用 Ctrl+Shift、Meta+Shift 或 Ctrl+Alt，避免拦截远端 Ctrl+C / Z
              等常用按键。
            </p>
            <label v-for="(label, action) in shortcutLabels" :key="action"
              >{{ label
              }}<input
                :value="draft.terminal.shortcuts[action]"
                readonly
                :aria-label="`${label}快捷键`"
                @keydown="capture(action, $event)"
            /></label>
          </div>
        </fieldset>
        <ProductSettings
          v-model="draft.product"
          section="shortcuts"
          :disabled="application.saving || busy"
        />
      </div>
      <div v-show="category === 'storage'" id="settings-panel-storage" class="settings-category">
        <fieldset v-if="application.state?.storage" :disabled="application.saving || busy">
          <legend>应用数据位置</legend>
          <div class="settings-fields">
            <div class="full-width settings-field">
              <label for="data-root-directory">数据根目录</label>
              <div class="input-action">
                <input id="data-root-directory" v-model="target" aria-label="数据根目录" required />
                <button type="button" class="button" @click="migration.browse">选择数据目录</button>
              </div>
            </div>
            <dl class="full-width storage-paths">
              <div>
                <dt>数据库</dt>
                <dd>{{ application.state.storage.databasePath }}</dd>
              </div>
              <div>
                <dt>插件</dt>
                <dd>{{ application.state.storage.pluginDirectory }}</dd>
              </div>
              <div>
                <dt>日志</dt>
                <dd>{{ application.state.storage.logDirectory }}</dd>
              </div>
              <div>
                <dt>WebView 数据与缓存</dt>
                <dd>{{ application.state.storage.webviewDirectory }}</dd>
              </div>
            </dl>
            <p class="subtle full-width">
              选择空的专用目录。修改后迁移应用数据并自动重启；成功启动后清理旧副本。系统凭据和已下载文件保留原位置。
            </p>
            <p v-if="application.state.storage.notice" class="subtle full-width">
              {{ application.state.storage.notice }}
            </p>
          </div>
        </fieldset>
        <ProductSettings
          v-model="draft.product"
          section="storage"
          :disabled="application.saving || busy"
        />
        <fieldset :disabled="application.saving || busy">
          <legend>传输与日志</legend>
          <div class="settings-fields">
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
              ><span class="settings-label">日志级别 <span class="subtle">重启后生效</span></span
              ><select v-model="draft.logLevel" aria-label="日志级别">
                <option value="error">ERROR</option>
                <option value="warn">WARN</option>
                <option value="info">INFO</option>
                <option value="debug">DEBUG</option>
              </select></label
            >
          </div>
        </fieldset>
      </div>
      <div class="form-footer">
        <p class="subtle">统一保存所有分类。配置不包含密码、私钥或私钥口令。</p>
        <div class="action-row">
          <button
            class="button"
            type="button"
            :disabled="application.saving || busy"
            @click="restoreDefaults"
          >
            恢复默认
          </button>
          <button class="button primary" type="submit" :disabled="application.saving || busy">
            {{ application.saving || busy ? '处理中…' : changed ? '保存、迁移并重启' : '保存设置' }}
          </button>
        </div>
      </div>
    </form>
    <p v-else class="subtle">连接本地后端后即可读取和修改设置。</p>
    <Modal v-if="preview" title="迁移数据并重启" :busy="busy" @close="preview = null">
      <p class="storage-path">当前目录：{{ application.state?.storage?.rootDirectory }}</p>
      <p class="storage-path">目标目录：{{ preview.targetDirectory }}</p>
      <p>
        预计迁移 {{ (preview.bytes / 1024 / 1024).toFixed(2) }} MiB，目标可用
        {{ (preview.availableBytes / 1024 / 1024 / 1024).toFixed(2) }} GiB。
      </p>
      <p>
        将保存所有分类设置，断开连接并安全结束后台任务（当前
        {{ preview.unfinishedTasks }}
        项未完成传输）。重启后迁移并校验，新目录启动成功后自动清理旧副本。
      </p>
      <label v-if="preview.dirtyDocuments" class="checkbox-label"
        ><input v-model="discardDocuments" type="checkbox" />明确放弃
        {{ preview.dirtyDocuments }} 份文档的未保存修改</label
      >
      <p v-if="preview.dirtyDocuments" class="subtle">也可以取消本次操作，保存文档后再迁移。</p>
      <div class="dialog-actions">
        <button type="button" class="button" :disabled="busy" @click="preview = null">取消</button>
        <button
          type="button"
          class="button danger"
          :disabled="busy || (!!preview.dirtyDocuments && !discardDocuments)"
          @click="migration.confirm"
        >
          确认迁移并重启
        </button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.storage-path {
  margin: 0 0 0.75rem;
  overflow-wrap: anywhere;
}
</style>
