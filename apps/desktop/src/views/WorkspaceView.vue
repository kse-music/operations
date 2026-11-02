<script setup lang="ts">
import { useApplicationStore } from '../stores/application';
import { RefreshCw, Settings2 } from '@lucide/vue';

const application = useApplicationStore();
defineEmits<{ settings: [] }>();
</script>

<template>
  <section class="workspace-view page-view" aria-labelledby="workspace-title">
    <div class="section-heading">
      <div>
        <h1 id="workspace-title">本地环境</h1>
      </div>
      <div class="action-row">
        <button
          class="button"
          :disabled="application.loading || application.saving"
          @click="application.initialize"
        >
          <RefreshCw :size="14" aria-hidden="true" />{{
            application.loading ? '检查中…' : '重新检查'
          }}
        </button>
        <button class="button" type="button" @click="$emit('settings')">
          <Settings2 :size="14" aria-hidden="true" />全局设置
        </button>
      </div>
    </div>
    <section class="work-section" aria-labelledby="system-title">
      <h2 id="system-title">运行状态</h2>
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
