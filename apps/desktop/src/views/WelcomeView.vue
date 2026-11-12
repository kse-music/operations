<script setup lang="ts">
import {
  ArrowUpRight,
  FileInput,
  Folder,
  MousePointer2,
  Puzzle,
  Server,
  SquareTerminal,
} from '@lucide/vue';
import { tr } from '../i18n/messages';

defineProps<{ searchShortcut: string }>();
const emit = defineEmits<{
  localTerminal: [];
  createHost: [];
  importOpenssh: [];
}>();
</script>

<template>
  <section class="welcome-page" :aria-label="tr('欢迎页面')">
    <header class="welcome-heading">
      <h1>{{ tr('欢迎使用 ServerDeck') }}</h1>
      <p>{{ tr('从本地终端开始，或连接你的服务器。') }}</p>
    </header>

    <div class="welcome-actions">
      <article class="welcome-card">
        <SquareTerminal class="welcome-card-icon" :size="23" aria-hidden="true" />
        <h2>{{ tr('本地终端') }}</h2>
        <p>{{ tr('在本机打开新的终端会话。') }}</p>
        <button type="button" class="button primary" @click="emit('localTerminal')">
          {{ tr('打开本地终端') }}<ArrowUpRight :size="14" aria-hidden="true" />
        </button>
      </article>
      <article class="welcome-card">
        <Server class="welcome-card-icon" :size="23" aria-hidden="true" />
        <h2>{{ tr('新建主机') }}</h2>
        <p>{{ tr('添加 SSH 地址与登录配置。') }}</p>
        <button type="button" class="button" @click="emit('createHost')">
          {{ tr('新建主机') }}<ArrowUpRight :size="14" aria-hidden="true" />
        </button>
      </article>
      <article class="welcome-card">
        <FileInput class="welcome-card-icon" :size="23" aria-hidden="true" />
        <h2>{{ tr('导入 SSH 配置') }}</h2>
        <p>{{ tr('从 OpenSSH Config 导入主机。') }}</p>
        <button type="button" class="button" @click="emit('importOpenssh')">
          {{ tr('导入配置') }}<ArrowUpRight :size="14" aria-hidden="true" />
        </button>
      </article>
    </div>

    <div class="welcome-help">
      <section class="welcome-section" :aria-label="tr('快速上手')">
        <h2>{{ tr('快速上手') }}</h2>
        <ul class="welcome-tips">
          <li>
            <MousePointer2 :size="16" aria-hidden="true" />
            <span>{{ tr('双击左侧主机，打开 SSH 终端。') }}</span>
          </li>
          <li>
            <Folder :size="16" aria-hidden="true" />
            <span>{{ tr('右键文件夹，新建主机或子文件夹。') }}</span>
          </li>
          <li>
            <Puzzle :size="16" aria-hidden="true" />
            <span>{{ tr('在设置中启用 Docker、AI 助手插件。') }}</span>
          </li>
        </ul>
      </section>
      <section class="welcome-section" :aria-label="tr('键盘操作')">
        <h2>{{ tr('键盘操作') }}</h2>
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
      </section>
    </div>
  </section>
</template>

<style scoped>
.welcome-page {
  width: 100%;
  max-width: 960px;
  margin: 12px auto 0;
  padding: 8px 0 24px;
  display: grid;
  gap: 32px;
}
.welcome-heading {
  display: grid;
  gap: 8px;
}
.welcome-heading h1 {
  margin: 0;
  font-size: var(--font-size-page-title);
  font-weight: 600;
}
.welcome-page p {
  margin: 0;
  color: var(--muted);
}
.welcome-page h2 {
  margin: 0;
  font-size: var(--font-size-section);
  font-weight: 600;
}
.welcome-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
.welcome-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--panel);
}
.welcome-card-icon {
  color: var(--accent);
}
.welcome-card p {
  flex: 1;
  font-size: var(--font-size-caption);
}
.welcome-card .button {
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
}
.welcome-card .button svg {
  flex-shrink: 0;
}
.welcome-help {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 32px;
}
.welcome-section {
  display: grid;
  align-content: start;
  gap: 16px;
  min-width: 0;
}
.welcome-tips {
  display: grid;
  gap: 14px;
  padding: 0;
  margin: 0;
  list-style: none;
  color: var(--muted);
  font-size: var(--font-size-caption);
}
.welcome-tips li {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.welcome-tips svg {
  flex-shrink: 0;
  margin-top: 2px;
}
.welcome-shortcuts {
  display: grid;
  gap: 12px;
  margin: 0;
  font-size: var(--font-size-caption);
}
.welcome-shortcuts > div {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
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
}
@container workspace (max-width: 640px) {
  .welcome-actions,
  .welcome-help {
    grid-template-columns: 1fr;
  }
}
</style>
