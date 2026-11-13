<script setup lang="ts">
import { computed } from 'vue';
import {
  ArrowUpRight,
  Container,
  FileInput,
  FolderOpen,
  Plus,
  Server,
  Sparkles,
  SquareTerminal,
} from '@lucide/vue';
import { tr } from '../i18n/messages';
import { filterHosts, useHostsStore } from '../stores/hosts';
import { usePluginsStore } from '../stores/plugins';
import { hostDisplayName } from '../types/hosts';
import { primaryPluginPage } from '../services/plugin-pages';

defineProps<{ searchShortcut: string }>();
const emit = defineEmits<{
  localTerminal: [];
  createHost: [];
  importOpenssh: [];
  files: [hostId: string];
  plugin: [id: string, contribution: string, hostId: string];
  pluginSettings: [id: string];
  managePlugins: [];
}>();
const hosts = useHostsStore();
const plugins = usePluginsStore();
const targets = computed(() => filterHosts(hosts.catalog?.hosts ?? [], ''));
const target = computed(
  () => targets.value.find((host) => host.id === hosts.selectedId) ?? targets.value[0],
);
const targetId = computed({
  get: () => target.value?.id ?? '',
  set: (id: string) => {
    hosts.selectedId = id;
  },
});
const hostUnavailable = computed(() => hosts.busy || !!hosts.error);
const pluginUnavailable = computed(
  () => plugins.loading || plugins.busy || !plugins.loaded || !!plugins.error,
);
const tools = computed(() =>
  [
    {
      id: 'cn.hiboot.plugins.docker',
      name: 'Docker',
      description: tr('管理容器、镜像和 Compose 项目。'),
      action: tr('进入 Docker'),
      icon: Container,
    },
    {
      id: 'cn.hiboot.plugins.assistant',
      name: tr('AI 运维助手'),
      description: tr('结合主机上下文，协助分析与处理问题。'),
      action: tr('打开助手'),
      icon: Sparkles,
    },
  ].map((tool) => {
    const installed = plugins.installed.find((plugin) => plugin.manifest.id === tool.id);
    const contribution = installed ? primaryPluginPage(installed) : '';
    const ready = plugins.extensions.some(
      (entry) =>
        entry.pluginId === tool.id && entry.id === contribution && entry.kind !== 'settings',
    );
    const settings = installed?.manifest.contributions.some((entry) => entry.kind === 'settings');
    const status = !plugins.loaded
      ? tr('插件列表未加载')
      : !installed
        ? tr('尚未安装')
        : !installed.enabled
          ? tr('插件未启用')
          : ready
            ? tr('插件已启用')
            : tr('需要检查插件授权或配置');
    return { ...tool, installed, contribution, ready, settings, status };
  }),
);
function openTool(id: string): void {
  if (pluginUnavailable.value || hostUnavailable.value || !target.value) return;
  const tool = tools.value.find((entry) => entry.id === id);
  if (!tool) return;
  if (!tool.installed) emit('managePlugins');
  else if (!tool.ready) emit('pluginSettings', tool.id);
  else emit('plugin', tool.id, tool.contribution, target.value.id);
}
function openFiles(): void {
  if (target.value && !hostUnavailable.value) emit('files', target.value.id);
}
</script>

<template>
  <section class="welcome-page" :aria-label="tr('欢迎页面')">
    <header class="welcome-heading">
      <span class="welcome-eyebrow">YOUR TOOLKIT</span>
      <h1>{{ tr('你的服务器工具箱。') }}</h1>
      <p>{{ tr('从终端开始，把连接、文件和扩展工具放在手边。') }}</p>
    </header>

    <div class="welcome-launch">
      <article class="welcome-card welcome-terminal">
        <SquareTerminal class="welcome-card-icon" :size="27" aria-hidden="true" />
        <h2>{{ tr('从本机，开始工作。') }}</h2>
        <p>{{ tr('打开终端、切换会话，进入熟悉的开发环境。') }}</p>
        <div class="welcome-shell-hint">
          <span aria-hidden="true">&gt;_</span><span>{{ tr('本地 Shell') }}</span>
          <span>{{ tr('按需启动') }}</span>
        </div>
        <button type="button" class="button primary" @click="emit('localTerminal')">
          {{ tr('打开本地终端') }}<ArrowUpRight :size="14" aria-hidden="true" />
        </button>
      </article>
      <div class="welcome-entries">
        <button
          type="button"
          class="welcome-entry"
          :aria-label="tr('新建主机')"
          @click="emit('createHost')"
        >
          <Server :size="22" aria-hidden="true" />
          <span
            ><strong>{{ tr('添加一台服务器') }}</strong
            ><small>{{ tr('配置 SSH 地址与认证方式') }}</small></span
          >
          <ArrowUpRight :size="14" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="welcome-entry"
          :aria-label="tr('导入 SSH 配置')"
          @click="emit('importOpenssh')"
        >
          <FileInput :size="22" aria-hidden="true" />
          <span
            ><strong>{{ tr('导入已有主机') }}</strong
            ><small>{{ tr('从 OpenSSH Config 开始') }}</small></span
          >
          <ArrowUpRight :size="14" aria-hidden="true" />
        </button>
      </div>
    </div>

    <section class="welcome-tools" :aria-label="tr('主机工具')">
      <header class="welcome-section-heading">
        <h2>{{ tr('主机工具') }}</h2>
        <label v-if="targets.length > 1" class="welcome-target">
          <span>{{ tr('目标主机') }}</span>
          <select v-model="targetId" :disabled="hostUnavailable" :aria-label="tr('目标主机')">
            <option v-for="host in targets" :key="host.id" :value="host.id">
              {{ hostDisplayName(host) }}
            </option>
          </select>
        </label>
        <span v-else-if="target" class="welcome-target-name">
          {{ tr('目标主机') }}<strong>{{ hostDisplayName(target) }}</strong>
        </span>
      </header>
      <p v-if="hosts.error" class="welcome-state" role="status">
        {{ tr('主机列表读取失败。') }}
        <button class="text-button" :disabled="hosts.busy" @click="hosts.load">
          {{ tr('重试') }}
        </button>
      </p>
      <p v-else-if="!hosts.catalog" class="welcome-state" role="status">
        {{ hosts.busy ? tr('正在读取主机…') : tr('主机列表未加载') }}
        <button v-if="!hosts.busy" class="text-button" @click="hosts.load">{{ tr('重试') }}</button>
      </p>
      <div v-if="hosts.catalog && !targets.length" class="welcome-host-empty">
        <div class="welcome-empty-icon"><Server :size="24" aria-hidden="true" /></div>
        <h3>{{ tr('添加第一台主机') }}</h3>
        <p>{{ tr('添加主机后，即可使用远程文件、Docker 和 AI 运维助手。') }}</p>
        <div class="action-row">
          <button type="button" class="button primary" @click="emit('createHost')">
            <Plus :size="14" aria-hidden="true" />{{ tr('新建主机') }}
          </button>
          <button type="button" class="button" @click="emit('importOpenssh')">
            <FileInput :size="14" aria-hidden="true" />{{ tr('导入 SSH 配置') }}
          </button>
        </div>
        <div class="welcome-capabilities">
          <span><FolderOpen :size="14" aria-hidden="true" />{{ tr('SFTP 文件') }}</span>
          <span><Container :size="14" aria-hidden="true" />Docker</span>
          <span><Sparkles :size="14" aria-hidden="true" />{{ tr('AI 助手') }}</span>
        </div>
      </div>
      <template v-else-if="target">
        <p v-if="plugins.loading" class="welcome-state" role="status">{{ tr('正在读取插件…') }}</p>
        <p v-else-if="plugins.error || !plugins.loaded" class="welcome-state" role="status">
          {{ plugins.error ? tr('插件列表读取失败。') : tr('插件列表未加载') }}
          <button class="text-button" :disabled="plugins.busy" @click="plugins.refresh()">
            {{ tr('重试') }}
          </button>
        </p>
        <div class="welcome-tool-grid">
          <article class="welcome-tool-card" data-home-tool="files">
            <FolderOpen :size="22" aria-hidden="true" />
            <h3>{{ tr('SFTP 文件') }}</h3>
            <p>{{ tr('浏览远程目录，上传下载，编辑文本文件。') }}</p>
            <span class="welcome-tool-status ready">{{ tr('内置功能') }}</span>
            <button type="button" class="button" :disabled="hostUnavailable" @click="openFiles">
              {{ tr('打开文件') }}
            </button>
          </article>
          <article
            v-for="tool in tools"
            :key="tool.id"
            class="welcome-tool-card"
            :data-home-tool="tool.id"
          >
            <component :is="tool.icon" :size="22" aria-hidden="true" />
            <h3>{{ tool.name }}</h3>
            <p>{{ tool.description }}</p>
            <span
              class="welcome-tool-status"
              :class="{ ready: tool.ready && !pluginUnavailable }"
              >{{ tool.status }}</span
            >
            <div class="action-row">
              <button
                type="button"
                class="button"
                :disabled="hostUnavailable || pluginUnavailable"
                @click="openTool(tool.id)"
              >
                {{
                  !tool.installed ? tr('插件管理') : !tool.ready ? tr('启用并设置') : tool.action
                }}
              </button>
              <button
                v-if="tool.ready && tool.settings"
                type="button"
                class="text-button"
                :disabled="pluginUnavailable"
                @click="emit('pluginSettings', tool.id)"
              >
                {{ tr('模型绑定') }}
              </button>
            </div>
          </article>
        </div>
      </template>
    </section>

    <section class="welcome-help" :aria-label="tr('快速上手')">
      <div class="welcome-guide">
        <span class="welcome-guide-index" aria-hidden="true">1</span>
        <h2>{{ tr('组织你的主机') }}</h2>
        <p>{{ tr('通过文件夹整理环境，右键新建主机或子文件夹。') }}</p>
      </div>
      <div class="welcome-guide" :aria-label="tr('键盘操作')">
        <span class="welcome-guide-index" aria-hidden="true">2</span>
        <h2>{{ tr('更快找到目标') }}</h2>
        <dl class="welcome-shortcuts">
          <div>
            <dt>{{ tr('搜索主机与命令') }}</dt>
            <dd>
              <kbd>{{ searchShortcut || tr('未设置快捷键') }}</kbd>
            </dd>
          </div>
          <div>
            <dt>{{ tr('连接选中的主机') }}</dt>
            <dd><kbd>Enter</kbd></dd>
          </div>
        </dl>
      </div>
      <div class="welcome-guide">
        <span class="welcome-guide-index" aria-hidden="true">3</span>
        <h2>{{ tr('扩展工作方式') }}</h2>
        <p>{{ tr('在插件设置中管理 Docker、AI 助手与其他插件。') }}</p>
        <button type="button" class="text-button" @click="emit('managePlugins')">
          {{ tr('插件管理') }}
        </button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.welcome-page {
  width: 100%;
  max-width: 960px;
  margin: 4px auto 0;
  padding: 0 0 24px;
  display: grid;
  gap: 24px;
}
.welcome-heading {
  display: grid;
  gap: 8px;
}
.welcome-eyebrow {
  color: var(--accent);
  font-size: var(--font-size-caption);
  letter-spacing: 1.5px;
}
.welcome-heading h1 {
  margin: 0;
  font-size: var(--font-size-page-title);
  font-weight: 600;
}
.welcome-page p {
  margin: 0;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.welcome-page h2,
.welcome-page h3 {
  margin: 0;
  font-size: var(--font-size-section);
  font-weight: 600;
}
.welcome-launch {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 14px;
}
.welcome-card,
.welcome-tool-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
  min-width: 0;
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}
.welcome-card-icon,
.welcome-tool-card > svg {
  color: var(--accent);
}
.welcome-terminal h2 {
  font-size: var(--font-size-title);
}
.welcome-terminal .button {
  margin-top: auto;
}
.welcome-shell-hint {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border-radius: 5px;
  background: var(--bg);
  font-size: var(--font-size-caption);
  color: var(--muted);
}
.welcome-shell-hint > span:first-child {
  color: var(--accent);
  font-family: Consolas, monospace;
}
.welcome-shell-hint > span:last-child {
  margin-left: auto;
}
.welcome-entries {
  display: grid;
  gap: 12px;
}
.welcome-entry {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  text-align: left;
}
.welcome-entry:hover {
  background: var(--panel-soft);
  border-color: var(--border-strong);
}
.welcome-entry > svg {
  flex-shrink: 0;
  color: var(--accent);
}
.welcome-entry > svg:last-child {
  margin-left: auto;
  color: var(--muted);
}
.welcome-entry > span {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.welcome-entry strong {
  font-size: var(--font-size-body);
  font-weight: 600;
}
.welcome-entry small {
  font-size: var(--font-size-caption);
  color: var(--muted);
}
.welcome-section-heading {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 16px;
  margin-bottom: 14px;
}
.welcome-target,
.welcome-target-name {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  min-width: 0;
  max-width: 100%;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.welcome-target select {
  width: 220px;
  max-width: 100%;
  min-width: 0;
}
.welcome-target-name strong {
  color: var(--text);
  font-weight: 500;
  overflow-wrap: anywhere;
}
.welcome-state {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px 0;
}
.welcome-host-empty {
  display: grid;
  justify-items: center;
  gap: 14px;
  min-width: 0;
  padding: 28px 24px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  text-align: center;
}
.welcome-empty-icon {
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: var(--accent-bg);
  color: var(--accent);
}
.welcome-host-empty h3 {
  font-size: var(--font-size-title);
  font-weight: 500;
}
.welcome-host-empty .action-row {
  justify-content: center;
}
.welcome-capabilities {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px 20px;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.welcome-capabilities > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.welcome-tool-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
.welcome-tool-card {
  gap: 12px;
  padding: 20px;
}
.welcome-tool-card p {
  flex: 1;
}
.welcome-tool-status {
  font-size: var(--font-size-caption);
  color: var(--muted);
}
.welcome-tool-status.ready {
  color: var(--accent);
}
.welcome-tool-card .action-row {
  gap: 8px;
  margin: 0;
}
.welcome-page .button {
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
}
.welcome-page .button svg {
  flex-shrink: 0;
}
.welcome-help {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 22px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
}
.welcome-guide {
  display: grid;
  align-content: start;
  justify-items: start;
  gap: 8px;
  min-width: 0;
}
.welcome-guide-index {
  width: 23px;
  height: 23px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font-size: var(--font-size-caption);
  color: var(--accent);
  background: var(--accent-bg);
}
.welcome-guide h2 {
  font-size: var(--font-size-body);
}
.welcome-shortcuts {
  display: grid;
  gap: 7px;
  margin: 0;
  width: 100%;
  font-size: var(--font-size-caption);
}
.welcome-shortcuts > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.welcome-shortcuts dt {
  color: var(--muted);
}
.welcome-shortcuts dd {
  margin: 0;
}
.welcome-shortcuts kbd {
  margin: 0;
  color: var(--text);
  overflow-wrap: anywhere;
  white-space: normal;
}
@container workspace (max-width: 740px) {
  .welcome-card,
  .welcome-entry {
    padding: 20px;
  }
  .welcome-tool-card {
    padding: 16px;
  }
  .welcome-help {
    gap: 16px;
  }
}
@container workspace (max-width: 580px) {
  .welcome-launch,
  .welcome-tool-grid,
  .welcome-help {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
