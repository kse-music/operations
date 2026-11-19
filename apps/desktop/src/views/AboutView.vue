<script setup lang="ts">
import { ArrowUpRight, FolderOpen, Puzzle, Server, SquareTerminal } from '@lucide/vue';
import { locale } from '@serverdeck/plugin-sdk/i18n';
import { displayLocalPath } from '@serverdeck/plugin-sdk/paths';
import { computed } from 'vue';
import brandIcon from '../assets/serverdeck.svg';
import UpdateDownloadProgress from '../components/UpdateDownloadProgress.vue';
import UpdateReleaseNotes from '../components/UpdateReleaseNotes.vue';
import { tr } from '../i18n/messages';
import { errorMessage } from '../services/ipc';
import { terminalApi } from '../services/terminal';
import { useApplicationStore } from '../stores/application';
import { useNotificationsStore } from '../stores/notifications';
import { useUpdatesStore } from '../stores/updates';

const capabilities = [
  { icon: Server, name: '主机管理', description: '用目录、收藏和环境标签整理主机。' },
  {
    icon: SquareTerminal,
    name: '本地与 SSH 终端',
    description: '支持多会话、分屏和本地端口转发。',
  },
  { icon: FolderOpen, name: 'SFTP 文件', description: '双栏浏览、后台传输和编辑远程文件。' },
  {
    icon: Puzzle,
    name: '插件扩展',
    description: '内置 Docker 和 AI 运维助手，支持从本地安装插件。',
  },
];
const resources = [
  { name: '使用文档', url: 'https://ops.hiboot.cn/docs/' },
  { name: '发布记录', url: 'https://github.com/kse-music/operations/releases' },
  { name: '问题反馈', url: 'https://github.com/kse-music/operations/issues' },
];

const notifications = useNotificationsStore();
async function openResource(url: string) {
  try {
    await terminalApi.openLink(url);
  } catch (cause) {
    notifications.push(tr('无法打开链接：{0}', errorMessage(cause)), true);
  }
}

const updates = useUpdatesStore();
const checkedTime = computed(() => {
  const at = updates.state?.preferences.lastCheckedAt;
  return at
    ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(at * 1000),
      )
    : tr('尚未检查');
});

const application = useApplicationStore();
const buildTimestamp = import.meta.env.APP_BUILD_TIME;
const buildTime = computed(() =>
  new Intl.DateTimeFormat(locale.value, {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'medium',
    timeStyle: 'medium',
    hourCycle: 'h23',
  }).format(new Date(buildTimestamp)),
);
</script>

<template>
  <section class="about-view page-view" aria-labelledby="about-title">
    <header class="section-heading">
      <h1 id="about-title">{{ tr('关于') }}</h1>
    </header>
    <section class="work-section about-product" :aria-label="tr('产品信息')">
      <header class="about-product-intro">
        <img :src="brandIcon" width="48" height="48" alt="" draggable="false" />
        <div>
          <h2>ServerDeck</h2>
          <p>
            {{
              tr(
                '通过 SSH 管理服务器的桌面工作台。主机配置和应用偏好保存在本机，已保存的密码和私钥由系统凭据库保管。',
              )
            }}
          </p>
        </div>
      </header>
      <dl class="about-product-details">
        <div>
          <dt>{{ tr('应用版本') }}</dt>
          <dd v-if="application.state">v{{ application.state.appVersion }}</dd>
          <dd v-else>
            {{ application.loading ? tr('读取中…') : tr('暂不可用（本地后端未就绪）') }}
          </dd>
        </div>
        <div>
          <dt>{{ tr('构建时间') }}</dt>
          <dd>
            <time :datetime="buildTimestamp">{{ buildTime }}</time>
            <span>{{ tr('（北京时间）') }}</span>
          </dd>
        </div>
      </dl>
      <ul class="about-product-capabilities" role="list" :aria-label="tr('主要功能')">
        <li v-for="capability in capabilities" :key="capability.name">
          <span class="about-capability-icon">
            <component :is="capability.icon" :size="17" aria-hidden="true" />
          </span>
          <div>
            <strong>{{ tr(capability.name) }}</strong>
            <p>{{ tr(capability.description) }}</p>
          </div>
        </li>
      </ul>
      <div class="action-row about-product-links">
        <a
          v-for="resource in resources"
          :key="resource.url"
          class="button"
          :href="resource.url"
          @click.prevent="openResource(resource.url)"
        >
          {{ tr(resource.name) }}<ArrowUpRight :size="14" aria-hidden="true" />
        </a>
      </div>
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
          <p class="subtle">{{ tr('每次启动时后台检查，安装前由你确认。') }}</p>
          <div v-if="updates.state.release" class="update-release">
            <strong>{{ tr('发现新版本 v{0}', updates.state.release.version) }}</strong>
            <UpdateReleaseNotes
              :content="updates.state.release.notes || tr('此版本未提供更新说明。')"
            />
          </div>
          <p v-else-if="updates.state.phase === 'upToDate' && !updates.error" role="status">
            {{ tr('当前已是最新版本。') }}
          </p>
          <UpdateDownloadProgress v-if="updates.downloading" />
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
      <p v-else-if="application.loading" class="subtle" role="status">
        {{ tr('正在通过 IPC 读取本地后端状态…') }}
      </p>
      <template v-else-if="application.environmentError !== null">
        <p class="error-text" role="alert">{{ application.environmentError }}</p>
        <button class="button" @click="application.initialize">{{ tr('重试') }}</button>
      </template>
      <p v-else class="subtle">{{ tr('后端尚未就绪，暂无运行状态。') }}</p>
    </section>
  </section>
</template>
