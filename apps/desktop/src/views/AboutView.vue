<script setup lang="ts">
import { tr } from '../i18n/messages';
import { displayLocalPath } from '@serverdeck/plugin-sdk/paths';

import { useApplicationStore } from '../stores/application';
import { RefreshCw } from '@lucide/vue';
import { computed } from 'vue';
import { locale } from '@serverdeck/plugin-sdk/i18n';
import { useUpdatesStore } from '../stores/updates';
const updates = useUpdatesStore();
const checkedTime = computed(() => {
  const at = updates.state?.preferences.lastCheckedAt;
  return at
    ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(at * 1000),
      )
    : tr('尚未检查');
});
const downloadPercent = computed(() => {
  const total = updates.state?.totalBytes;
  return total
    ? Math.min(100, Math.floor((updates.state!.downloadedBytes / total) * 100))
    : undefined;
});

const application = useApplicationStore();
const releaseTimestamp = import.meta.env.APP_RELEASE_TIME;
const releaseTime = computed(() =>
  new Intl.DateTimeFormat(locale.value, {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'medium',
    timeStyle: 'medium',
    hourCycle: 'h23',
  }).format(new Date(releaseTimestamp)),
);
</script>

<template>
  <section class="about-view page-view" aria-labelledby="about-title">
    <header class="section-heading">
      <h1 id="about-title">{{ tr('关于 ServerDeck') }}</h1>
      <button
        class="button"
        :disabled="application.loading || application.saving"
        @click="application.initialize"
      >
        <RefreshCw :size="14" aria-hidden="true" />{{
          application.loading ? tr('读取中…') : tr('刷新本地环境')
        }}
      </button>
    </header>
    <section class="work-section" :aria-label="tr('产品信息')">
      <h2>ServerDeck</h2>
      <p>{{ tr('本地优先的服务器运维工作台，集成 SSH 终端、SFTP 文件管理和服务器监控。') }}</p>
      <dl class="system-details">
        <div>
          <dt>{{ tr('应用版本') }}</dt>
          <dd v-if="application.state">v{{ application.state.appVersion }}</dd>
          <dd v-else>
            {{ application.loading ? tr('读取中…') : tr('暂不可用（本地后端未就绪）') }}
          </dd>
        </div>
        <div>
          <dt>{{ tr('发布时间') }}</dt>
          <dd>
            <time :datetime="releaseTimestamp">{{ releaseTime }}</time
            >{{ tr('（北京时间） ') }}
          </dd>
        </div>
      </dl>
    </section>
    <section class="work-section software-update" aria-labelledby="update-title">
      <h2 id="update-title">{{ tr('软件更新') }}</h2>
      <p v-if="!application.ready">{{ tr('连接本地后端后即可检查软件更新。') }}</p>
      <p v-else-if="updates.loading">{{ tr('正在读取更新设置…') }}</p>
      <template v-else-if="updates.state">
        <p v-if="!updates.state.supported">{{ tr('当前仅 Windows x64 安装版支持应用内更新。') }}</p>
        <template v-else>
          <p>{{ tr('上次成功检查：{0}', checkedTime) }}</p>
          <label class="checkbox-label">
            <input
              type="checkbox"
              :checked="updates.state.preferences.autoCheck"
              :disabled="updates.busy || updates.saving"
              @change="updates.setAutoCheck(($event.target as HTMLInputElement).checked)"
            />
            {{ tr('自动检查更新') }}
          </label>
          <p class="subtle">{{ tr('启动后后台检查，每天最多一次；安装前由你确认。') }}</p>
          <div v-if="updates.state.release" class="update-release">
            <strong>{{ tr('发现新版本 v{0}', updates.state.release.version) }}</strong>
            <p class="update-notes">
              {{ updates.state.release.notes || tr('此版本未提供更新说明。') }}
            </p>
          </div>
          <p v-else-if="updates.state.phase === 'upToDate' && !updates.error" role="status">
            {{ tr('当前已是最新版本。') }}
          </p>
          <div v-if="updates.downloading" class="update-progress" role="status">
            <progress :value="downloadPercent" max="100" :aria-label="tr('更新下载进度')" />
            <span>{{
              downloadPercent === undefined
                ? tr('正在下载更新…')
                : tr('已下载 {0}%', downloadPercent)
            }}</span>
            <span v-if="downloadPercent === 100">{{ tr('正在验证更新包签名…') }}</span>
          </div>
          <p v-if="updates.state.phase === 'ready'" role="status">
            {{ tr('更新包已验证，可安装并重启；当前连接和任务将结束。') }}
          </p>
          <div class="action-row">
            <button
              class="button"
              :disabled="updates.busy || updates.saving || updates.state.phase === 'ready'"
              @click="updates.check()"
            >
              {{ updates.checking ? tr('检查中…') : tr('检查更新') }}
            </button>
            <button
              v-if="
                updates.state.release && updates.state.phase !== 'ready' && !updates.downloading
              "
              class="button primary"
              :disabled="updates.busy"
              @click="updates.download"
            >
              {{ tr('下载更新') }}
            </button>
            <button
              v-if="updates.downloading || updates.checking"
              class="button"
              @click="updates.cancel"
            >
              {{ tr('取消') }}
            </button>
            <button
              v-if="updates.state.phase === 'ready'"
              class="button primary"
              :disabled="updates.busy"
              @click="updates.requestInstall"
            >
              {{ tr('安装并重启') }}
            </button>
          </div>
        </template>
      </template>
      <button v-else-if="application.ready" class="button" @click="updates.initialize">
        {{ tr('重新读取更新设置') }}
      </button>
      <p v-if="updates.error" class="error-text" role="alert">{{ updates.error }}</p>
    </section>
    <section class="work-section" aria-labelledby="system-title">
      <h2 id="system-title">{{ tr('本地环境') }}</h2>
      <dl v-if="application.state" class="system-details" data-testid="backend-ready">
        <div>
          <dt>IPC / Rust</dt>
          <dd><span class="status-dot"></span>{{ tr(' 已连接') }}</dd>
        </div>
        <div>
          <dt>SQLite</dt>
          <dd>{{ tr('已初始化 · schema v') }}{{ application.state.databaseVersion }}</dd>
        </div>
        <div>
          <dt>{{ tr('数据目录') }}</dt>
          <dd class="path">{{ displayLocalPath(application.state.dataDirectory) }}</dd>
        </div>
        <div>
          <dt>{{ tr('日志目录') }}</dt>
          <dd class="path">{{ displayLocalPath(application.state.logDirectory) }}</dd>
        </div>
      </dl>
      <p v-else class="subtle">
        {{
          application.loading
            ? tr('正在通过 IPC 读取本地后端状态…')
            : tr('后端尚未就绪，暂无运行状态。')
        }}
      </p>
    </section>
  </section>
</template>
