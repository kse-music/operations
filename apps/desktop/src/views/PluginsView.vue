<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { Puzzle, PackagePlus, RefreshCw, Trash2, Upload } from '@lucide/vue';
import PluginIcon from '../components/PluginIcon.vue';
import Modal from '../components/Modal.vue';
import { usePluginsStore } from '../stores/plugins';
import { pluginsApi } from '../services/plugins';
import { errorMessage } from '../services/ipc';
import type { InstalledPlugin, PluginPackagePreview } from '../types/plugins';
const emit = defineEmits<{ settings: [id: string] }>();
const plugins = usePluginsStore();
const path = ref(''),
  preview = ref<PluginPackagePreview | null>(null),
  ack = ref(false),
  inspecting = ref(false),
  over = ref(false),
  dropzone = ref<HTMLElement>();
const deleting = ref<InstalledPlugin | null>(null),
  clearData = ref(false);
const existing = computed(() =>
  plugins.installed.find((p) => p.manifest.id === preview.value?.manifest.id),
);
const filename = computed(() => path.value.split(/[\\/]/).pop() ?? '');
const enabled = computed(() => plugins.installed.filter((p) => p.enabled).length);
let selection = 0,
  disposed = false,
  unlisten: UnlistenFn | undefined;
function cancelPreview() {
  selection++;
  preview.value = null;
  path.value = '';
  ack.value = false;
  inspecting.value = false;
}
async function inspect(paths: string[]) {
  if (plugins.busy) return;
  if (paths.length !== 1 || !paths[0]?.toLowerCase().endsWith('.sdplugin')) {
    plugins.error = '请选择一个 .sdplugin 插件包。';
    return;
  }
  const current = ++selection;
  path.value = paths[0];
  preview.value = null;
  ack.value = false;
  inspecting.value = true;
  try {
    const value = await pluginsApi.previewInfo(path.value);
    if (!disposed && current === selection) preview.value = value;
  } catch (cause) {
    if (!disposed && current === selection) plugins.error = errorMessage(cause);
  } finally {
    if (current === selection) inspecting.value = false;
  }
}
async function pick() {
  try {
    const chosen = await pluginsApi.pick();
    if (chosen) await inspect([chosen]);
  } catch (cause) {
    plugins.error = errorMessage(cause);
  }
}
async function install() {
  const selected = preview.value,
    selectedPath = path.value;
  if (!selected || !ack.value) return;
  const old = existing.value;
  if (
    old &&
    !(await plugins.ask(
      '升级插件？',
      '将停止插件资源并放弃未保存编辑。升级失败时保留原版本和授权。',
    ))
  )
    return;
  if (
    await plugins.mutate(async () => {
      if (old) {
        await plugins.bind(old.manifest.id, null);
        plugins.clearPlugin(old.manifest.id);
      }
      return pluginsApi.install(
        selectedPath,
        true,
        old?.manifest.version ?? null,
        selected.packageDigest,
      );
    })
  )
    cancelPreview();
}
async function uninstall() {
  const plugin = deleting.value;
  if (!plugin) return;
  if (await plugins.mutate(() => pluginsApi.uninstall(plugin.manifest.id, clearData.value, true))) {
    plugins.clearPlugin(plugin.manifest.id);
    deleting.value = null;
  }
}
onMounted(async () => {
  void plugins.refresh();
  if (!isTauri()) return;
  try {
    const listener = await getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === 'leave') {
        over.value = false;
        return;
      }
      const box = dropzone.value?.getBoundingClientRect();
      if (!box) return;
      const x = payload.position.x / window.devicePixelRatio,
        y = payload.position.y / window.devicePixelRatio;
      const inside = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
      over.value = inside && payload.type !== 'drop' && !plugins.busy;
      if (payload.type === 'drop' && inside) void inspect(payload.paths);
    });
    if (disposed) listener();
    else unlisten = listener;
  } catch (cause) {
    plugins.error = `拖拽安装不可用：${errorMessage(cause)}`;
  }
});
onBeforeUnmount(() => {
  disposed = true;
  selection++;
  unlisten?.();
});
</script>
<template>
  <section class="plugin-manager" aria-label="插件管理">
    <header class="plugin-heading">
      <div>
        <p class="eyebrow">扩展与集成</p>
        <h1>插件管理</h1>
        <p class="subtle">安装和配置插件。插件功能从当前主机工作区顶部的工具按钮使用。</p>
      </div>
      <button class="button" :disabled="plugins.loading || plugins.busy" @click="plugins.refresh()">
        <RefreshCw :size="15" aria-hidden="true" />刷新
      </button>
    </header>
    <section
      ref="dropzone"
      :class="['plugin-dropzone', { over, busy: inspecting || plugins.busy }]"
      aria-label="插件上传区域"
      @dragover.prevent="over = !plugins.busy"
      @dragleave="over = false"
      @drop.prevent="over = false"
    >
      <span class="plugin-upload-icon"><Upload :size="25" aria-hidden="true" /></span>
      <div>
        <h2>
          {{
            inspecting ? '正在检查插件包…' : over ? '松开即可检查插件包' : '拖入插件包，添加新工具'
          }}
        </h2>
        <p>支持 .sdplugin 文件，安装前会显示插件信息和所需权限。</p>
      </div>
      <button class="button primary" :disabled="plugins.busy || inspecting" @click="pick">
        <PackagePlus :size="16" aria-hidden="true" />选择插件包
      </button>
    </section>
    <section class="plugin-installed" aria-label="已安装插件">
      <header class="plugin-section-heading">
        <div>
          <h2>
            已安装插件 <span class="plugin-count">{{ plugins.installed.length }}</span>
          </h2>
          <p class="subtle">
            {{ enabled }} 个已启用 · {{ plugins.installed.length - enabled }} 个已禁用
          </p>
        </div>
      </header>
      <p v-if="plugins.loading && !plugins.loaded" class="host-empty" role="status">
        正在读取插件…
      </p>
      <div v-else-if="!plugins.installed.length" class="plugin-empty">
        <Puzzle :size="32" aria-hidden="true" />
        <h3>还没有安装插件</h3>
        <p>将插件包拖到上方，或点击“选择插件包”开始安装。</p>
      </div>
      <div v-else class="plugin-installed-list">
        <article
          v-for="plugin in plugins.installed"
          :key="plugin.manifest.id"
          class="plugin-installed-row"
          :data-plugin-id="plugin.manifest.id"
        >
          <span class="plugin-row-icon">
            <PluginIcon :manifest="plugin.manifest" :source="plugin.source" :size="21" />
          </span>
          <div class="plugin-row-main">
            <div class="plugin-row-title">
              <button class="plugin-name-button" @click="emit('settings', plugin.manifest.id)">
                {{ plugin.manifest.name }}</button
              ><span class="plugin-version">v{{ plugin.manifest.version }}</span>
            </div>
            <p>{{ plugin.manifest.description || '点击插件名称查看详情和设置' }}</p>
          </div>
          <span :class="['plugin-status', { enabled: plugin.enabled }]">{{
            plugin.enabled ? '已启用' : '已禁用'
          }}</span>
          <div class="plugin-row-actions">
            <button
              class="plugin-remove-button"
              :disabled="plugins.busy"
              :aria-label="`卸载 ${plugin.manifest.name}`"
              title="卸载插件"
              @click="
                deleting = plugin;
                clearData = false;
              "
            >
              <Trash2 :size="16" aria-hidden="true" />
            </button>
          </div>
        </article>
      </div>
    </section>
    <Modal v-if="preview" title="安装插件" wide :busy="plugins.busy" @close="cancelPreview">
      <div class="plugin-preview" aria-label="插件安装预览">
        <header class="plugin-preview-heading">
          <span class="plugin-row-icon"
            ><PluginIcon :manifest="preview.manifest" :size="25"
          /></span>
          <div>
            <h2>{{ preview.manifest.name }}</h2>
            <p>{{ preview.manifest.author }} · v{{ preview.manifest.version }}</p>
            <small>{{ filename }}</small>
          </div>
        </header>
        <p>{{ preview.manifest.description }}</p>
        <p v-if="existing" class="plugin-setup-note">
          已安装 v{{ existing.manifest.version }}，将升级至 v{{
            preview.manifest.version
          }}，升级后需要重新授权。
        </p>
        <div>
          <h3>所需权限</h3>
          <div class="plugin-permission-tags">
            <span v-for="permission in preview.manifest.permissions" :key="permission">{{
              permission
            }}</span
            ><span v-if="!preview.manifest.permissions.length">无需额外权限</span>
          </div>
        </div>
        <details class="plugin-preview-details">
          <summary>包信息</summary>
          <dl class="plugin-details">
            <dt>插件 ID</dt>
            <dd>{{ preview.manifest.id }}</dd>
            <dt>API</dt>
            <dd>{{ preview.manifest.apiVersion }}</dd>
            <dt>SHA256</dt>
            <dd class="plugin-digest">{{ preview.packageDigest }}</dd>
          </dl>
        </details>
        <label class="plugin-install-ack"
          ><input v-model="ack" type="checkbox" /><span
            >我了解此插件包尚未通过签名验证，确认安装。安装后默认禁用，权限需单独授予。</span
          ></label
        >
      </div>
      <footer class="dialog-actions">
        <button class="button" :disabled="plugins.busy" @click="cancelPreview">取消</button
        ><button class="button primary" :disabled="!ack || plugins.busy" @click="install">
          {{ existing ? '升级插件' : '安装插件' }}
        </button>
      </footer>
    </Modal>
    <Modal v-if="deleting" title="卸载插件？" :busy="plugins.busy" @close="deleting = null"
      ><p>
        卸载
        {{ deleting.manifest.name }}
        将停止插件调用并放弃未保存的编辑。服务器文件和已有终端不受影响。
      </p>
      <label class="checkbox-label"
        ><input v-model="clearData" type="checkbox" />同时清除这个插件的本地配置和数据</label
      >
      <footer class="dialog-actions">
        <button class="button" :disabled="plugins.busy" @click="deleting = null">取消</button
        ><button class="button danger" :disabled="plugins.busy" @click="uninstall">确认卸载</button>
      </footer></Modal
    >
  </section>
</template>
