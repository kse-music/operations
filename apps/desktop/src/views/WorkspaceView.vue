<script setup lang="ts">
import { useApplicationStore } from '../stores/application';

const application = useApplicationStore();
defineEmits<{ settings: [] }>();
</script>

<template>
  <section class="workspace-view" aria-labelledby="workspace-title">
    <div class="section-heading">
      <div>
        <p class="eyebrow">YOUR LOCAL WORKSPACE</p>
        <h1 id="workspace-title">运维，从一个工作区开始。</h1>
      </div>
      <span class="stage-label">阶段 02 / 主机与凭据</span>
    </div>
    <p class="section-description">
      ServerDeck 围绕主机组织运维操作。<br />主机、安全凭据与 SSH
      终端已开放，文件与监控将在后续阶段接入。
    </p>
    <div class="workspace-empty">
      <div class="terminal-mark" aria-hidden="true">&gt;_</div>
      <h2>本地运行环境</h2>
      <p>在左侧管理主机，双击主机打开 SSH 终端。SFTP 和资源监控尚未实现。</p>
      <button class="button primary" type="button" @click="$emit('settings')">
        配置我的工作台 <span aria-hidden="true">↗</span>
      </button>
    </div>
    <div class="module-grid">
      <article>
        <span class="module-icon" aria-hidden="true">01</span>
        <h3>Terminal</h3>
        <p>独立 PTY 与多会话终端</p>
        <span class="planned">阶段三 · 未实现</span>
      </article>
      <article>
        <span class="module-icon" aria-hidden="true">02</span>
        <h3>Files</h3>
        <p>基于 SFTP 的文件与传输</p>
        <span class="planned">阶段四 · 未实现</span>
      </article>
      <article>
        <span class="module-icon" aria-hidden="true">03</span>
        <h3>Monitor</h3>
        <p>无需 Agent 的 Linux 资源采集</p>
        <span class="planned">阶段五 · 未实现</span>
      </article>
    </div>
    <section class="system-panel" aria-labelledby="system-title">
      <div class="system-heading">
        <h2 id="system-title">本地运行环境</h2>
        <button
          class="text-button"
          :disabled="application.loading || application.saving"
          @click="application.initialize"
        >
          {{ application.loading ? '检查中…' : '重新检查' }}
        </button>
      </div>
      <dl v-if="application.state" class="system-details" data-testid="backend-ready">
        <div>
          <dt>IPC / Rust</dt>
          <dd><span class="status-dot"></span> 已连接 · v{{ application.state.appVersion }}</dd>
        </div>
        <div>
          <dt>SQLite</dt>
          <dd>已初始化 · schema v{{ application.state.databaseVersion }}</dd>
        </div>
        <div>
          <dt>数据目录</dt>
          <dd class="path">{{ application.state.dataDirectory }}</dd>
        </div>
        <div>
          <dt>日志目录</dt>
          <dd class="path">{{ application.state.logDirectory }}</dd>
        </div>
      </dl>
      <p v-else class="subtle">
        {{
          application.loading ? '正在通过 IPC 读取本地后端状态…' : '后端尚未就绪，暂无运行状态。'
        }}
      </p>
    </section>
  </section>
</template>
