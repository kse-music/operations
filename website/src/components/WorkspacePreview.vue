<script setup lang="ts">
import { computed } from 'vue';
import {
  House,
  Terminal,
  FolderOpen,
  Container,
  Sparkles,
  Settings2,
  Server,
  Search,
  Plus,
  Check,
  ShieldCheck,
  X,
  Columns2,
} from '@lucide/vue';
import { tools } from '../content';
import type { Tool } from '../content';

const props = withDefaults(defineProps<{ id: string; modelValue?: Tool; compact?: boolean }>(), {
  modelValue: 'terminal',
  compact: false,
});
const emit = defineEmits<{ 'update:modelValue': [tool: Tool] }>();
const symbols = { terminal: Terminal, files: FolderOpen, docker: Container, assistant: Sparkles };
const activeName = computed(() => tools.find((tool) => tool.id === props.modelValue)?.name);
const files = [
  ['app', '文件夹'],
  ['backups', '文件夹'],
  ['scripts', '文件夹'],
  ['compose.yaml', '文本文件'],
  ['README.md', '文本文件'],
];
function moveTab(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tools.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tools.length) % tools.length;
  emit('update:modelValue', tools[next].id);
  const group = (event.currentTarget as HTMLElement).parentElement;
  (group?.children[next] as HTMLButtonElement | undefined)?.focus();
}
</script>

<template>
  <div
    class="workspace"
    :class="{ 'workspace-compact': compact }"
    :aria-label="`${activeName}交互演示，使用示例数据`"
  >
    <div class="app-titlebar">
      <span class="app-title-brand"
        ><img src="/assets/serverdeck.svg" width="15" height="15" alt="" />ServerDeck</span
      ><span class="preview-label">交互演示 · 示例数据</span
      ><span class="app-window-controls" aria-hidden="true">− &nbsp; □ &nbsp; ×</span>
    </div>
    <div class="app-body">
      <div class="app-rail" aria-hidden="true">
        <House class="rail-active" /><Terminal /><span class="rail-bottom"><Settings2 /></span>
      </div>
      <aside class="app-sidebar" aria-label="示例主机目录">
        <div class="sidebar-heading">主机目录 <Plus :size="12" /></div>
        <div class="sidebar-search"><Search :size="10" />搜索主机</div>
        <p class="host-folder">⌄ &nbsp; 工作环境</p>
        <div class="host-row selected">
          <Server /><span>demo-web<small>dev@web.example.com</small></span
          ><i />
        </div>
        <div class="host-row">
          <Server /><span>demo-data<small>dev@data.example.com</small></span>
        </div>
        <p class="host-folder">› &nbsp; 开发环境</p>
        <div class="sidebar-bottom">连接，由你掌控。</div>
      </aside>
      <div class="app-main">
        <div class="app-host-tab"><Server />demo-web <X :size="10" /></div>
        <div class="app-tool-tabs" role="tablist" :aria-label="`${id} 功能演示`">
          <button
            v-for="(tool, index) in tools"
            :id="`${id}-tab-${tool.id}`"
            :key="tool.id"
            type="button"
            role="tab"
            :aria-selected="modelValue === tool.id"
            :tabindex="modelValue === tool.id ? 0 : -1"
            :aria-controls="`${id}-panel`"
            @click="emit('update:modelValue', tool.id)"
            @keydown="moveTab($event, index)"
          >
            <component :is="symbols[tool.id]" />{{ tool.name }}
          </button>
        </div>
        <div
          :id="`${id}-panel`"
          class="app-content"
          role="tabpanel"
          :aria-labelledby="`${id}-tab-${modelValue}`"
        >
          <div v-if="modelValue === 'terminal'" class="terminal-columns">
            <div class="terminal-pane">
              <div class="pane-label"><span>SSH / demo-web</span><Columns2 :size="11" /></div>
              <div class="terminal-lines">
                <p class="muted-code"># 在熟悉的工作现场继续</p>
                <p>
                  <span class="prompt">dev@demo-web</span>:<span class="blue-code">~/app</span>$
                  docker compose ps
                </p>
                <p class="muted-code">
                  NAME&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; SERVICE&nbsp;&nbsp; STATUS
                </p>
                <p>
                  app-web&nbsp;&nbsp;&nbsp; web&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
                  <span class="green-code">Up (healthy)</span>
                </p>
                <p>
                  app-cache&nbsp; redis&nbsp;&nbsp;&nbsp;&nbsp; <span class="green-code">Up</span>
                </p>
                <p class="code-gap">
                  <span class="prompt">dev@demo-web</span>:<span class="blue-code">~/app</span>$
                  <span class="cursor">▏</span>
                </p>
              </div>
            </div>
            <div class="terminal-pane pane-secondary">
              <div class="pane-label">SSH / demo-web <span>bash</span></div>
              <div class="terminal-lines">
                <p>
                  <span class="prompt">dev@demo-web</span>:<span class="blue-code">~</span>$ ls -la
                </p>
                <p class="muted-code">drwxr-xr-x&nbsp; app/</p>
                <p class="muted-code">drwxr-xr-x&nbsp; backups/</p>
                <p class="muted-code">drwxr-xr-x&nbsp; scripts/</p>
                <p class="code-gap">
                  <span class="prompt">dev@demo-web</span>:<span class="blue-code">~</span>$
                  <span class="cursor">▏</span>
                </p>
              </div>
            </div>
          </div>
          <div v-else-if="modelValue === 'files'" class="files-demo">
            <div class="file-columns">
              <div v-for="label in ['本地文件 · ~/projects', '远程文件 · /home/dev']" :key="label">
                <div class="pane-label">{{ label }}</div>
                <div class="file-table">
                  <div class="file-head"><span>名称</span><span>类型</span></div>
                  <div v-for="[name, kind] in files" :key="name" class="file-row">
                    <FolderOpen :size="13" /><span>{{ name }}</span
                    ><small>{{ kind }}</small>
                  </div>
                </div>
              </div>
            </div>
            <div class="transfer-note">
              <ShieldCheck :size="12" />暂存传输 → SHA-256 校验 → 提交文件
            </div>
          </div>
          <div v-else-if="modelValue === 'docker'" class="docker-demo">
            <div class="docker-heading">
              <div>
                <h4>容器</h4>
                <p>demo-web / Docker</p>
              </div>
              <span class="demo-tag">示例列表</span>
            </div>
            <div class="docker-table">
              <div class="docker-row docker-table-head">
                <span>容器名称</span><span>镜像</span><span>状态</span>
              </div>
              <div
                v-for="[name, image, state] in [
                  ['app-web', 'nginx:alpine', '运行中'],
                  ['app-cache', 'redis:alpine', '运行中'],
                  ['app-worker', 'app:latest', '已停止'],
                ]"
                :key="name"
                class="docker-row"
              >
                <span><Container :size="13" />{{ name }}</span
                ><span>{{ image }}</span
                ><span :class="state === '运行中' ? 'green-code' : 'muted-code'"
                  >● {{ state }}</span
                >
              </div>
            </div>
            <div class="docker-bottom">容器 · 镜像 · Compose 项目</div>
          </div>
          <div v-else class="assistant-demo">
            <div class="assistant-user">帮我检查 demo-web 上的容器状态。</div>
            <div class="assistant-reply">
              <Sparkles :size="18" />
              <div>
                <strong>先看证据，再决定下一步。</strong>
                <p>在授权范围内读取容器状态与相关日志，并说明缺失的信息。</p>
                <div class="evidence-chip">
                  <Check :size="12" />采集证据 <span>→</span> 预览计划 <span>→</span> 审批与复查
                </div>
                <p class="assistant-small">需配置模型与权限；此处未读取或操作主机。</p>
              </div>
            </div>
          </div>
        </div>
        <div class="app-status">
          <span><i />示例主机 / SSH</span><span>UTF-8 · 界面演示，未建立连接</span>
        </div>
      </div>
    </div>
  </div>
</template>
