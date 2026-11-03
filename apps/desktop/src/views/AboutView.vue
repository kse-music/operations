<script setup lang="ts">
import { useApplicationStore } from '../stores/application';

const application = useApplicationStore();
</script>

<template>
  <section class="about-view page-view" aria-labelledby="about-title">
    <header class="section-heading"><h1 id="about-title">关于 ServerDeck</h1></header>
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
  </section>
</template>
