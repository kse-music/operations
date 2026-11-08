<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Download, Puzzle, PackagePlus, RefreshCw, Search, Settings2, Trash2 } from '@lucide/vue';
import PluginIcon from '../components/PluginIcon.vue';
import Modal from '../components/Modal.vue';
import { usePluginsStore } from '../stores/plugins';
import { useNotificationsStore } from '../stores/notifications';
import { pluginsApi } from '../services/plugins';
import { errorMessage } from '../services/ipc';
import type { InstalledPlugin, PluginPackagePreview } from '../types/plugins';
const emit = defineEmits<{ settings: [id: string] }>();
const plugins = usePluginsStore();
const notifications = useNotificationsStore();
const savingDevelopmentKit = ref(false);
const path = ref(''),
  preview = ref<PluginPackagePreview | null>(null),
  ack = ref(false),
  inspecting = ref(false);
const deleting = ref<InstalledPlugin | null>(null),
  clearData = ref(false);
const existing = computed(() =>
  plugins.installed.find((p) => p.manifest.id === preview.value?.manifest.id),
);
const filename = computed(() => path.value.split(/[\\/]/).pop() ?? '');
const enabled = computed(() => plugins.installed.filter((p) => p.enabled).length);
const search = ref('');
const source = ref<'all' | 'system' | 'user'>('all');
const status = ref<'all' | 'enabled' | 'disabled'>('all');
const filtered = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return plugins.installed.filter((plugin) => {
    const manifest = plugin.manifest;
    return (
      (source.value === 'all' || (plugin.source ?? 'user') === source.value) &&
      (status.value === 'all' || plugin.enabled === (status.value === 'enabled')) &&
      (!query ||
        [manifest.name, manifest.id, manifest.description, manifest.author].some((value) =>
          value.toLocaleLowerCase().includes(query),
        ))
    );
  });
});
function resetFilters() {
  search.value = '';
  source.value = 'all';
  status.value = 'all';
}
let selection = 0,
  disposed = false;
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
async function saveDevelopmentKit() {
  savingDevelopmentKit.value = true;
  try {
    const destination = await pluginsApi.saveDevelopmentKit();
    if (destination) notifications.push(`插件开发包已保存到 ${destination}`);
  } catch (cause) {
    notifications.push(`插件开发包保存失败：${errorMessage(cause)}`, true);
  } finally {
    savingDevelopmentKit.value = false;
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
onMounted(() => {
  void plugins.refresh();
});
onBeforeUnmount(() => {
  disposed = true;
  selection++;
});
</script>
<template>
  <section class="plugin-manager" aria-label="插件管理">
    <header class="plugin-heading">
      <div>
        <div class="plugin-manager-title">
          <h1>插件</h1>
          <span class="plugin-count" aria-label="已安装插件数量">{{
            plugins.installed.length
          }}</span>
        </div>
        <p class="subtle">点击插件名称或齿轮，打开插件配置与权限。</p>
      </div>
      <div class="plugin-heading-actions">
        <button
          class="button"
          :disabled="plugins.loading || plugins.busy"
          @click="plugins.refresh()"
        >
          <RefreshCw :size="15" aria-hidden="true" />刷新
        </button>
        <button class="button primary" :disabled="plugins.busy || inspecting" @click="pick">
          <PackagePlus :size="16" aria-hidden="true" />安装插件
        </button>
      </div>
    </header>
    <section class="plugin-installed" aria-label="已安装插件">
      <div class="plugin-filterbar" role="search" aria-label="筛选已安装插件">
        <select v-model="source" aria-label="插件来源">
          <option value="all">所有来源</option>
          <option value="system">系统内置</option>
          <option value="user">用户上传</option>
        </select>
        <select v-model="status" aria-label="插件状态">
          <option value="all">所有状态</option>
          <option value="enabled">已启用</option>
          <option value="disabled">已禁用</option>
        </select>
        <div class="plugin-search">
          <Search :size="16" aria-hidden="true" />
          <input
            v-model="search"
            type="search"
            aria-label="搜索插件"
            placeholder="搜索名称、描述或插件 ID"
          />
        </div>
        <p class="subtle plugin-filter-summary" role="status">
          显示 {{ filtered.length }} / {{ plugins.installed.length }} 个 · {{ enabled }} 个已启用
        </p>
      </div>
      <p v-if="plugins.loading && !plugins.loaded" class="host-empty" role="status">
        正在读取插件…
      </p>
      <div v-else-if="plugins.error && !plugins.loaded" class="plugin-empty" role="alert">
        <h3>插件列表加载失败</h3>
        <p>{{ plugins.error }}</p>
        <button
          class="button"
          :disabled="plugins.loading || plugins.busy"
          @click="plugins.refresh()"
        >
          重试
        </button>
      </div>
      <div v-else-if="!plugins.installed.length" class="plugin-empty">
        <Puzzle :size="32" aria-hidden="true" />
        <h3>还没有安装插件</h3>
        <p>点击右上角“安装插件”，或将插件包拖到上方开始安装。</p>
      </div>
      <div v-else-if="!filtered.length" class="plugin-empty" role="status">
        <Search :size="28" aria-hidden="true" />
        <h3>没有匹配的插件</h3>
        <p>试试其他关键词，或清除来源与状态筛选。</p>
        <button class="button" @click="resetFilters">清除筛选</button>
      </div>
      <div v-else class="plugin-installed-list">
        <article
          v-for="plugin in filtered"
          :key="plugin.manifest.id"
          class="plugin-installed-row"
          :data-plugin-id="plugin.manifest.id"
        >
          <div class="plugin-card-content">
            <span class="plugin-row-icon">
              <PluginIcon :manifest="plugin.manifest" :source="plugin.source" :size="21" />
            </span>
            <div class="plugin-row-main">
              <div class="plugin-row-title">
                <button class="plugin-name-button" @click="emit('settings', plugin.manifest.id)">
                  {{ plugin.manifest.name }}</button
                ><span class="plugin-version">v{{ plugin.manifest.version }}</span>
              </div>
              <p>{{ plugin.manifest.description || '点击插件名称打开设置' }}</p>
            </div>
            <div class="plugin-row-actions">
              <button
                class="tool-button"
                :aria-label="`配置 ${plugin.manifest.name}`"
                title="插件配置"
                @click="emit('settings', plugin.manifest.id)"
              >
                <Settings2 :size="16" aria-hidden="true" />
              </button>
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
          </div>
          <footer class="plugin-card-footer">
            <span class="plugin-identifier" :title="plugin.manifest.id">{{
              plugin.manifest.id
            }}</span>
            <div class="plugin-card-badges">
              <span class="plugin-source">{{
                plugin.source === 'system' ? '系统内置' : '用户上传'
              }}</span>
              <span :class="['plugin-status', { enabled: plugin.enabled }]">{{
                plugin.enabled ? '已启用' : '已禁用'
              }}</span>
            </div>
          </footer>
        </article>
      </div>
    </section>
    <footer class="plugin-manager-footer">
      <button
        class="button"
        type="button"
        :disabled="savingDevelopmentKit"
        @click="saveDevelopmentKit"
      >
        <Download :size="16" aria-hidden="true" />下载插件开发包
      </button>
    </footer>
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
