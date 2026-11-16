<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Download,
  FileText,
  FolderOpen,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Container,
  BookOpen,
} from '@lucide/vue';
import { faqs, links, tools } from './content';
import type { Tool } from './content';
import type { Page } from './pages';
import WorkspacePreview from './components/WorkspacePreview.vue';
import InfoPage from './components/InfoPage.vue';
import SiteHeader from './components/SiteHeader.vue';

const props = defineProps<{ page: Page }>();
const isHome = computed(() => props.page === 'home');
const heroTool = ref<Tool>('terminal');
const selectedTool = ref<Tool>('terminal');
const symbol = { terminal: Terminal, files: FolderOpen, docker: Container, assistant: Sparkles };
</script>

<template>
  <div class="site concept-workbench">
    <a class="skip-link" href="#main-content">跳至主要内容</a>
    <SiteHeader />
    <main v-if="isHome" id="main-content">
      <section class="hero-a wrap" aria-labelledby="hero-title">
        <div class="hero-a-copy">
          <p class="eyebrow hero-eyebrow">YOUR SERVERS. YOUR WORKSPACE.</p>
          <h1 id="hero-title">每一台服务器，<br />尽在你的<span>工作台。</span></h1>
          <p class="hero-description">
            从第一条 SSH 命令，到文件、容器与 AI 协作。<br
              class="desktop-break"
            />把日常运维，收进一个本地桌面。
          </p>
          <div id="download" class="hero-actions">
            <a class="button button-primary" :href="links.latest"
              ><Download :size="18" />下载客户端</a
            ><a class="button button-secondary" href="#workspace"
              >探索工作台 <ArrowRight :size="17"
            /></a>
          </div>
        </div>
        <div class="hero-a-visual">
          <div class="visual-topline">
            <span>ONE WORKSPACE / ALL IN CONTEXT</span><span>01 — 04</span>
          </div>
          <WorkspacePreview id="hero" v-model="heroTool" compact />
          <div class="visual-caption">
            <span class="caption-line" />点击工具标签，看看你的工作现场。
          </div>
        </div>
      </section>
      <div class="capability-strip">
        <div class="wrap">
          <span>你熟悉的工具，在一起。</span><b>SSH</b><b>SFTP</b><b>Docker</b><b>Compose</b
          ><b>AI ASSISTANT</b>
        </div>
      </div>
      <section id="workspace" class="section-a wrap" aria-labelledby="workspace-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">01 / THE WORKSPACE</p>
            <h2 id="workspace-title">少一些切换。<br />多一些<span>专注。</span></h2>
          </div>
          <p>选中一台主机，接着做手上的事。<br />终端、文件和扩展工具共享清晰的主机上下文。</p>
        </div>
        <div class="feature-explorer">
          <div class="feature-list">
            <button
              v-for="(tool, index) in tools"
              :key="tool.id"
              type="button"
              class="feature-choice"
              :class="{ active: selectedTool === tool.id }"
              :aria-pressed="selectedTool === tool.id"
              aria-controls="explorer-panel"
              @click="selectedTool = tool.id"
            >
              <span>0{{ index + 1 }}</span>
              <div>
                <h3>{{ tool.title }}</h3>
                <p>{{ tool.description }}</p>
              </div>
              <ArrowRight :size="17" />
            </button>
          </div>
          <div class="explorer-preview">
            <WorkspacePreview id="explorer" v-model="selectedTool" />
            <p class="preview-disclosure">交互演示使用示例数据，不会连接服务器或执行命令。</p>
          </div>
        </div>
      </section>
      <section id="capabilities" class="capabilities-a wrap" aria-labelledby="capabilities-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">02 / BUILT FOR THE EVERYDAY</p>
            <h2 id="capabilities-title">你的日常，<span>都在手边。</span></h2>
          </div>
          <p>个人开发者、DevOps 与小型团队，<br />从本机连接到每一个工作环境。</p>
        </div>
        <div class="capability-grid">
          <article>
            <Terminal />
            <h3>连接与终端</h3>
            <p>主机目录、SSH 配置导入、跳板与代理。多会话、分屏和快捷键，让工作保持连续。</p>
            <span class="capability-detail">本地 Shell / SSH / 拖放上传</span>
          </article>
          <article>
            <FolderOpen />
            <h3>传输与编辑</h3>
            <p>双栏 SFTP、后台传输与独立文本编辑。冲突处理、校验和取消，都有清楚的结果。</p>
            <span class="capability-detail">双栏浏览 / SHA-256 / 文本编辑</span>
          </article>
          <article>
            <Container />
            <h3>容器与扩展</h3>
            <p>查看容器、镜像、Compose 项目和日志。通过本地插件包扩展，按需要管理权限。</p>
            <span class="capability-detail">Docker / Compose / 插件 SDK</span>
          </article>
        </div>
      </section>
      <section class="assistant-section wrap" aria-labelledby="assistant-title">
        <div class="assistant-story">
          <p class="eyebrow">03 / CONTEXT MEETS INTELLIGENCE</p>
          <h2 id="assistant-title">让 AI 理解现场。<br />让行动<span>有据可依。</span></h2>
          <p>
            结合相关主机的证据分析问题，呈现目标与计划。<br />按审批模式执行之后，再复查真实结果。
          </p>
          <a class="text-link" :href="links.assistant">了解 AI 运维助手 <ArrowRight :size="16" /></a
          ><small>需配置可用模型；远程服务可能按其政策计费。</small>
        </div>
        <div class="assistant-process">
          <div class="ai-sample-question"><Sparkles :size="17" />这个容器为什么退出了？</div>
          <ol>
            <li>
              <span>01</span>
              <div>
                <strong>采集证据</strong>
                <p>关联主机，读取状态与相关日志。</p>
              </div>
              <Check :size="15" />
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>预览计划</strong>
                <p>明确实际目标、动作与待确认事项。</p>
              </div>
              <FileText :size="15" />
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>审批与执行</strong>
                <p>默认请求批准，在既有权限内执行。</p>
              </div>
              <ShieldCheck :size="15" />
            </li>
            <li>
              <span>04</span>
              <div>
                <strong>复查结果</strong>
                <p>区分成功、失败与未确认状态。</p>
              </div>
              <Check :size="15" />
            </li>
          </ol>
          <span class="process-caption">工作流程示意 · 不代表真实执行结果</span>
        </div>
      </section>
      <section id="security" class="security-a" aria-labelledby="security-title">
        <div class="wrap security-inner">
          <div class="security-seal"><ShieldCheck :size="35" /></div>
          <div>
            <p class="eyebrow">LOCAL BY DESIGN</p>
            <h2 id="security-title">工作在本地。<br />控制权，也在你。</h2>
            <p>
              主机配置留在本机，凭据交给系统凭据库。<br />SSH 连接验证身份，高风险操作明确确认。
            </p>
            <small>使用远程 AI 模型时，相关上下文会经授权发送至你配置的服务。</small
            ><a class="text-link" href="/security.html">了解安全设计 <ArrowRight :size="15" /></a>
          </div>
          <div class="security-list">
            <span><Check />无需云账号</span><span><Check />SSH 主机指纹验证</span
            ><span><Check />系统凭据库</span><span><Check />插件权限与任务审批</span>
          </div>
        </div>
      </section>
      <section id="start" class="start-section wrap" aria-labelledby="start-title">
        <div class="section-heading">
          <div>
            <p class="eyebrow">04 / YOUR FIRST CONNECTION</p>
            <h2 id="start-title">下一台主机，<span>这样开始。</span></h2>
          </div>
          <a class="text-link" :href="links.guide">完整使用指南 <ArrowRight :size="16" /></a>
        </div>
        <ol class="start-steps">
          <li>
            <span>01</span><Download />
            <h3>安装工作台</h3>
            <p>从官方 Releases 获取 Windows x64 安装包，完成安装后打开 ServerDeck。</p>
          </li>
          <li>
            <span>02</span><Server />
            <h3>添加你的主机</h3>
            <p>填写连接信息或导入 SSH 配置。核对主机指纹，测试连接后保存。</p>
          </li>
          <li>
            <span>03</span><component :is="symbol.terminal" />
            <h3>开始手上的工作</h3>
            <p>双击主机，在终端、文件和插件工具间切换。使用 AI 前先配置模型。</p>
          </li>
        </ol>
      </section>
      <section id="docs" class="docs-section wrap" aria-labelledby="docs-title">
        <div>
          <p class="eyebrow">KEEP EXPLORING</p>
          <h2 id="docs-title">工具之外，<br /><span>还有清楚的指南。</span></h2>
        </div>
        <div class="doc-links">
          <a
            v-for="entry in [
              { name: '安装与日常使用', sub: '从连接到文件传输', url: links.guide },
              { name: 'Docker 与 Compose', sub: '容器、镜像和项目管理', url: links.docker },
              { name: 'AI 助手与模型', sub: '配置、审批和执行边界', url: links.assistant },
              { name: '开发你的插件', sub: '独立开发包与公开 SDK', url: links.plugins },
            ]"
            :key="entry.name"
            :href="entry.url"
            ><BookOpen :size="18" />
            <div>
              <strong>{{ entry.name }}</strong
              ><span>{{ entry.sub }}</span>
            </div>
            <ArrowRight :size="16"
          /></a>
        </div>
      </section>
      <section id="faq" class="faq-section wrap" aria-labelledby="faq-title">
        <div>
          <p class="eyebrow">GOOD TO KNOW</p>
          <h2 id="faq-title">开始之前，<br /><span>你可能想知道。</span></h2>
          <a class="text-link" :href="links.issues" target="_blank" rel="noopener noreferrer"
            >遇到问题？反馈给我们 <ArrowUpRight :size="15"
          /></a>
        </div>
        <div class="faq-list">
          <details v-for="item in faqs" :key="item.question">
            <summary>{{ item.question }}</summary>
            <p>{{ item.answer }}</p>
          </details>
        </div>
      </section>
    </main>
    <InfoPage v-else-if="page === 'privacy' || page === 'security'" :kind="page" />
    <main v-else id="main-content" class="not-found wrap">
      <p class="eyebrow">404 / PAGE NOT FOUND</p>
      <h1>这条路径，暂时没有目的地。</h1>
      <p>可以返回首页，或在文档中继续寻找。</p>
      <a class="button button-primary" href="/">返回首页 <ArrowRight :size="17" /></a>
    </main>
    <footer class="site-footer wrap">
      <div>
        <a class="brand" href="/"
          ><img src="/assets/serverdeck.svg" width="29" height="29" alt="" /><span
            >ServerDeck</span
          ></a
        >
        <p>让每一次连接，都更从容。</p>
      </div>
      <div class="footer-links">
        <a :href="links.guide">使用文档</a><a :href="links.plugins">开发者中心</a
        ><a href="/security.html">安全设计</a><a href="/privacy.html">隐私与数据</a
        ><a :href="links.repository" target="_blank" rel="noopener noreferrer"
          >GitHub <ArrowUpRight :size="12"
        /></a>
      </div>
      <div class="footer-bottom">
        <small>© 2026 ServerDeck contributors · MIT License</small
        ><a v-if="isHome" href="#main-content">回到顶部 ↑</a><a v-else href="/">返回首页 ↑</a>
      </div>
    </footer>
  </div>
</template>
