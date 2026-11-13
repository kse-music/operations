<script setup lang="ts">
import { tr } from '../i18n/messages';
import { displayLocalPath } from '@serverdeck/plugin-sdk/paths';

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import ProductSettings from './ProductSettings.vue';
import Modal from './Modal.vue';
import { useStorageMigration } from '../composables/storage-migration';
import { useSettingsAutosave } from '../composables/settings-autosave';
import {
  defaultProductPreferences,
  settingsCategories,
  type SettingsCategory,
} from '../types/product';
import { useApplicationStore } from '../stores/application';
import { useWorkspaceStore } from '../stores/workspace';
import {
  defaultInterfaceFontSize,
  defaultTerminalPreferences,
  interfaceFontSizes,
  shortcutKey,
  shortcutLabels,
} from '../types/preferences';

const application = useApplicationStore();
const workspace = useWorkspaceStore();
const migration = useStorageMigration();
const { target, preview, discardDocuments, busy, restarting, changed } = migration;
const displayedTarget = computed({
  get: () => displayLocalPath(target.value),
  set: (value: string) => {
    if (value !== displayedTarget.value) target.value = value;
  },
});
const props = withDefaults(defineProps<{ category?: SettingsCategory }>(), { category: 'general' });
const emit = defineEmits<{ category: [category: SettingsCategory] }>();
const categoryLabel = computed(
  () => settingsCategories.find((item) => item.id === props.category)!.label,
);
const form = ref<HTMLFormElement>();
const reviewing = ref(false);
function invalidField(includeDataRoot = false) {
  return form.value?.querySelector<HTMLInputElement | HTMLSelectElement>(
    includeDataRoot
      ? 'input:invalid, select:invalid'
      : 'input:invalid:not(#data-root-directory), select:invalid',
  );
}
const autosave = useSettingsAutosave(
  () => !!form.value && !invalidField(),
  () => reviewing.value || busy.value || !!preview.value,
);
const { draft, pending, failed } = autosave;

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
const unsaved = computed(() => changed.value || pending.value);
const closePrompt = ref(false);
watch(
  () => application.saving || busy.value,
  (value) => (workspace.settingsBusy = value),
  { immediate: true, flush: 'sync' },
);
watch(unsaved, (value) => (workspace.settingsDirty = value), { immediate: true, flush: 'sync' });
let closeDecision: Promise<boolean> | null = null;
let resolveClose: ((discard: boolean) => void) | undefined;
async function confirmClose(): Promise<boolean> {
  if (application.saving || busy.value) return false;
  await autosave.flush();
  if (!unsaved.value) return true;
  if (!closeDecision) {
    closePrompt.value = true;
    closeDecision = new Promise((resolve) => (resolveClose = resolve));
  }
  return closeDecision;
}
function finishClose(discard: boolean): void {
  closePrompt.value = false;
  resolveClose?.(discard);
  resolveClose = undefined;
  closeDecision = null;
}
workspace.settingsCloseGuard = confirmClose;
onBeforeUnmount(() => {
  workspace.settingsBusy = false;
  workspace.settingsDirty = false;
  application.interfaceFontSizePreview = undefined;
  if (workspace.settingsCloseGuard === confirmClose) workspace.settingsCloseGuard = undefined;
  finishClose(false);
});

async function validate(includeDataRoot = false): Promise<boolean> {
  const invalid = invalidField(includeDataRoot);
  if (invalid) {
    const panel = invalid.closest('.settings-category');
    const category = settingsCategories.find((item) => panel?.id === `settings-panel-${item.id}`);
    if (category) emit('category', category.id);
    await nextTick();
    invalid.focus();
    invalid.reportValidity();
    return false;
  }
  return true;
}
async function submit(): Promise<void> {
  if (await validate()) await autosave.flush();
}
async function reviewMigration(): Promise<void> {
  if (!changed.value || application.saving || busy.value || reviewing.value) return;
  if (!(await validate(true)) || !draft.value) return;
  reviewing.value = true;
  try {
    await migration.review(draft.value);
  } finally {
    reviewing.value = false;
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
      config.product.language = product.language;
      break;
    case 'terminal':
      config.terminalFontSize = 16;
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
        <p class="section-description">
          {{
            category === 'storage'
              ? tr('设置修改后自动保存；更改数据根目录需确认迁移并重启。')
              : tr('设置修改后自动保存，连接参数在新建连接时生效。')
          }}
        </p>
      </div>
      <span class="subtle">{{ tr('仅保存在此设备') }}</span>
    </div>
    <form v-if="draft" ref="form" class="settings-form" novalidate @submit.prevent="submit">
      <div v-show="category === 'general'" id="settings-panel-general" class="settings-category">
        <ProductSettings v-model="draft.product" section="general" :disabled="reviewing || busy">
          <label
            >{{ tr('外观主题 ')
            }}<select v-model="draft.theme" data-testid="theme-select">
              <option value="dark">{{ tr('深色') }}</option>
              <option value="light">{{ tr('浅色') }}</option>
              <option value="system">{{ tr('跟随系统') }}</option>
            </select>
          </label>
          <div class="settings-field interface-font-size">
            <label for="interface-font-size">{{ tr('界面字号') }}</label>
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
            />
          </div>
          <label
            ><span class="settings-label"
              >{{ tr('侧边栏宽度 ') }}<span class="subtle">{{ draft.sidebarWidth }} px</span></span
            >
            <input
              v-model.number="draft.sidebarWidth"
              :aria-label="tr('侧边栏宽度')"
              type="range"
              min="200"
              max="400"
            />
          </label>
        </ProductSettings>
      </div>
      <div v-show="category === 'terminal'" id="settings-panel-terminal" class="settings-category">
        <fieldset :disabled="reviewing || busy">
          <legend>{{ tr('终端显示') }}</legend>
          <div class="settings-fields">
            <label
              >{{ tr('终端字号')
              }}<input
                v-model.number="draft.terminalFontSize"
                type="number"
                min="10"
                max="32"
                required
            /></label>
            <label
              >{{ tr('终端字体')
              }}<input
                v-model="draft.terminal.fontFamily"
                maxlength="128"
                required
                :aria-label="tr('终端字体')"
            /></label>
            <label
              >{{ tr('终端行高（%）')
              }}<input
                v-model.number="draft.terminal.lineHeight"
                type="number"
                min="100"
                max="200"
                required
                :aria-label="tr('终端行高')"
            /></label>
            <label
              >{{ tr('滚动历史行数')
              }}<input
                v-model.number="draft.terminal.scrollback"
                type="number"
                min="0"
                max="20000"
                required
                :aria-label="tr('滚动历史行数')"
            /></label>
            <label
              >{{ tr('终端主题')
              }}<select v-model="draft.terminal.theme" :aria-label="tr('终端主题')">
                <option value="deck">{{ tr('ServerDeck 深色') }}</option>
                <option value="light">{{ tr('浅色') }}</option>
                <option value="nord">Nord</option>
                <option value="solarized">Solarized Dark</option>
              </select></label
            >
            <label
              >{{ tr('光标样式')
              }}<select v-model="draft.terminal.cursorStyle" :aria-label="tr('光标样式')">
                <option value="block">{{ tr('方块') }}</option>
                <option value="bar">{{ tr('竖线') }}</option>
                <option value="underline">{{ tr('下划线') }}</option>
              </select></label
            >
            <label class="checkbox-label"
              ><input v-model="draft.terminal.cursorBlink" type="checkbox" />{{
                tr('光标闪烁')
              }}</label
            >
          </div>
        </fieldset>
        <fieldset :disabled="reviewing || busy">
          <legend>{{ tr('输入与粘贴') }}</legend>
          <div class="settings-fields">
            <label
              >{{ tr('大文本粘贴确认阈值（字符）')
              }}<input
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
                />{{ tr('选中即复制，右键即粘贴') }}</label
              >
              <p id="quick-copy-paste-help" class="subtle settings-help">
                {{ tr(' 默认关闭，仅在终端内容区生效；大文本粘贴仍需确认。 ') }}
              </p>
            </div>
          </div>
        </fieldset>
        <ProductSettings v-model="draft.product" section="connection" :disabled="reviewing || busy">
          <label
            >{{ tr('SSH 连接超时（秒） ')
            }}<input
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
        <fieldset :disabled="reviewing || busy">
          <legend>{{ tr('终端快捷键') }}</legend>
          <div class="settings-fields">
            <p class="subtle full-width">
              {{
                tr(
                  '先点击本地或 SSH 终端输入区再使用。分屏、新建及切换会话仅适用于主终端，插件终端弹窗不支持。',
                )
              }}
            </p>
            <p class="subtle full-width">
              {{
                tr(
                  ' 选中后按新组合键。使用 Ctrl+Shift、Meta+Shift 或 Ctrl+Alt，避免拦截远端 Ctrl+C / Z 等常用按键。 ',
                )
              }}
            </p>
            <label v-for="(label, action) in shortcutLabels" :key="action"
              >{{ label
              }}<input
                :value="draft.terminal.shortcuts[action]"
                readonly
                :aria-label="tr('{0}快捷键', label)"
                @keydown="capture(action, $event)"
            /></label>
          </div>
        </fieldset>
        <ProductSettings
          v-model="draft.product"
          section="shortcuts"
          :disabled="reviewing || busy"
        />
      </div>
      <div v-show="category === 'storage'" id="settings-panel-storage" class="settings-category">
        <fieldset v-if="application.state?.storage" :disabled="reviewing || busy">
          <legend>{{ tr('应用数据位置') }}</legend>
          <div class="settings-fields">
            <div class="full-width settings-field">
              <label for="data-root-directory">{{ tr('数据根目录') }}</label>
              <div class="input-action">
                <input
                  id="data-root-directory"
                  v-model="displayedTarget"
                  :aria-label="tr('数据根目录')"
                  required
                />
                <button type="button" class="button" @click="migration.browse">
                  {{ tr('选择数据目录') }}
                </button>
              </div>
            </div>
            <dl class="full-width storage-paths">
              <div>
                <dt>{{ tr('数据库') }}</dt>
                <dd>{{ displayLocalPath(application.state.storage.databasePath) }}</dd>
              </div>
              <div>
                <dt>{{ tr('插件') }}</dt>
                <dd>{{ displayLocalPath(application.state.storage.pluginDirectory) }}</dd>
              </div>
              <div>
                <dt>{{ tr('日志') }}</dt>
                <dd>{{ displayLocalPath(application.state.storage.logDirectory) }}</dd>
              </div>
              <div>
                <dt>{{ tr('WebView 数据与缓存') }}</dt>
                <dd>{{ displayLocalPath(application.state.storage.webviewDirectory) }}</dd>
              </div>
            </dl>
            <p class="subtle full-width">
              {{
                tr(
                  ' 选择空的专用目录。确认后将关闭窗口，在重启期间迁移并校验数据；新目录启动成功后清理旧副本。系统凭据和已下载文件保留原位置。 ',
                )
              }}
            </p>
            <p
              v-if="application.state.storage.notice && !changed && !busy"
              class="subtle full-width"
            >
              {{ application.state.storage.notice }}
            </p>
          </div>
        </fieldset>
        <ProductSettings v-model="draft.product" section="storage" :disabled="reviewing || busy" />
        <fieldset :disabled="reviewing || busy">
          <legend>{{ tr('传输与日志') }}</legend>
          <div class="settings-fields">
            <label
              >{{ tr('每主机并发传输数')
              }}<input
                v-model.number="draft.transferConcurrency"
                :aria-label="tr('每主机并发传输数')"
                type="number"
                min="1"
                max="6"
                required
            /></label>
            <label
              ><span class="settings-label"
                >{{ tr('日志级别 ') }}<span class="subtle">{{ tr('重启后生效') }}</span></span
              ><select v-model="draft.logLevel" :aria-label="tr('日志级别')">
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
        <p class="subtle" role="status" aria-live="polite">
          {{
            application.saving
              ? tr('正在自动保存…')
              : failed && pending
                ? tr('自动保存失败，修改已保留，请重试。')
                : pending
                  ? tr('等待自动保存，请确保填写完整且数值有效。')
                  : tr('更改会自动保存到此设备。')
          }}
        </p>
        <div class="action-row">
          <button
            class="button"
            type="button"
            :disabled="reviewing || busy"
            @click="restoreDefaults"
          >
            {{ tr(' 恢复默认 ') }}
          </button>
          <button
            v-if="category === 'storage' && changed"
            class="button primary"
            type="button"
            :disabled="application.saving || busy"
            @click="reviewMigration"
          >
            {{ busy ? tr('处理中…') : tr('迁移并重启') }}
          </button>
          <button
            v-if="failed && pending"
            class="button"
            type="button"
            :disabled="application.saving || busy"
            @click="autosave.flush"
          >
            {{ tr('重试') }}
          </button>
        </div>
      </div>
    </form>
    <p v-else class="subtle">{{ tr('连接本地后端后即可读取和修改设置。') }}</p>
    <Modal v-if="closePrompt" :title="tr('设置尚未保存')" @close="finishClose(false)">
      <p>{{ tr('通用、终端、快捷键或数据与存储中有未保存的更改。关闭后将放弃这些更改。') }}</p>
      <div class="dialog-actions">
        <button type="button" class="button" @click="finishClose(false)">
          {{ tr('继续编辑') }}
        </button>
        <button type="button" class="button danger" @click="finishClose(true)">
          {{ tr(' 放弃更改并关闭 ') }}
        </button>
      </div>
    </Modal>
    <Modal v-if="preview" :title="tr('迁移数据并重启')" :busy="busy" @close="preview = null">
      <p class="storage-path">
        {{ tr('当前目录：')
        }}{{ displayLocalPath(application.state?.storage?.rootDirectory ?? '') }}
      </p>
      <p class="storage-path">
        {{ tr('目标目录：') }}{{ displayLocalPath(preview.targetDirectory) }}
      </p>
      <p>
        {{ tr(' 预计迁移 ') }}{{ (preview.bytes / 1024 / 1024).toFixed(2)
        }}{{ tr(' MiB，目标可用 ')
        }}{{ (preview.availableBytes / 1024 / 1024 / 1024).toFixed(2) }} GiB。
      </p>
      <p>
        {{ tr(' 将保存所有分类设置，断开连接并安全结束后台任务（当前 ')
        }}{{ preview.unfinishedTasks
        }}{{
          tr(
            ' 项未完成传输）。随后关闭窗口，在重启期间复制并校验数据；窗口关闭不代表迁移完成。新目录启动成功后自动清理旧副本。 ',
          )
        }}
      </p>
      <p v-if="busy" role="status">
        {{
          restarting
            ? tr('正在安全结束任务并重启，数据将在重启期间复制和校验。请等待应用自动重新打开。')
            : tr('正在保存设置并安排迁移，请稍候…')
        }}
      </p>
      <label v-if="preview.dirtyDocuments" class="checkbox-label"
        ><input v-model="discardDocuments" type="checkbox" :disabled="busy" />{{ tr('明确放弃 ')
        }}{{ preview.dirtyDocuments }}{{ tr(' 份文档的未保存修改') }}</label
      >
      <p v-if="preview.dirtyDocuments" class="subtle">
        {{ tr('也可以取消本次操作，保存文档后再迁移。') }}
      </p>
      <div class="dialog-actions">
        <button type="button" class="button" :disabled="busy" @click="preview = null">
          {{ tr('取消') }}
        </button>
        <button
          type="button"
          class="button danger"
          :disabled="busy || (!!preview.dirtyDocuments && !discardDocuments)"
          @click="migration.confirm"
        >
          {{ busy ? (restarting ? tr('正在重启…') : tr('正在准备…')) : tr('确认迁移并重启') }}
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
