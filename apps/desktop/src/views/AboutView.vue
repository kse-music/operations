<script setup lang="ts">
import { useApplicationStore } from '../stores/application';
import { RefreshCw } from '@lucide/vue';

const application = useApplicationStore();
</script>

<template>
  <section class="about-view page-view" aria-labelledby="about-title">
    <header class="section-heading">
      <h1 id="about-title">关于 ServerDeck</h1>
      <button
        class="button"
        :disabled="application.loading || application.saving"
        @click="application.initialize"
      >
        <RefreshCw :size="14" aria-hidden="true" />{{
          application.loading ? '检查中…' : '重新检查'
        }}
      </button>
    </header>
    <section class="work-section" aria-label="产品信息">
      <h2>ServerDeck</h2>
      <p>本地优先的服务器运维工作台，集成 SSH 终端、SFTP 文件管理和服务器监控。</p>
      <dl class="system-details">
        <div>
          <dt>应用版本</dt>
          <dd v-if="application.state">v{{ application.state.appVersion }}</dd>
          <dd v-else>{{ application.loading ? '读取中…' : '暂不可用（本地后端未就绪）' }}</dd>
        </div>
        <div>
          <dt>技术栈</dt>
          <dd>Rust · Tauri 2 · Vue 3</dd>
        </div>
      </dl>
    </section>
    <section class="work-section" aria-labelledby="system-title">
      <h2 id="system-title">本地环境</h2>
      <dl v-if="application.state" class="system-details" data-testid="backend-ready">
        <div>
          <dt>IPC / Rust</dt>
          <dd><span class="status-dot"></span> 已连接</dd>
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
