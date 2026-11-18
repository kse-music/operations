<script setup lang="ts">
import { ArrowLeft, ArrowRight, ExternalLink } from '@lucide/vue';
import { links } from '../content';
defineProps<{ kind: 'privacy' | 'security' }>();
</script>

<template>
  <main id="main-content" class="legal-page wrap">
    <a class="back-link" href="/"><ArrowLeft :size="16" /> 返回产品首页</a>
    <p class="eyebrow">{{ kind === 'privacy' ? 'PRIVACY & DATA' : 'SECURITY BY DESIGN' }}</p>
    <h1>{{ kind === 'privacy' ? '隐私与数据' : '安全设计与使用边界' }}</h1>
    <p class="legal-lead">
      {{
        kind === 'privacy'
          ? '配置存在哪里，哪些数据会离开设备，讲清楚。'
          : '让连接、传输与 AI 协作，都有清楚的边界。'
      }}
    </p>
    <template v-if="kind === 'privacy'">
      <section>
        <h2>浏览这个网站</h2>
        <p>
          官网展示产品信息，并提供官方安装包、文档及源码入口。页面不设置账户、联系表单、广告追踪、分析埋点或
          Cookie，也不读取你的主机、终端或模型数据。工作台演示仅使用随页面打包的示例数据。
        </p>
        <p>
          使用文档与开发者中心在本站阅读；搜索在浏览器内完成，不向第三方搜索服务发送查询。官网和文档会在浏览器本地保存外观偏好，可通过清除此站点数据移除。
        </p>
        <p>
          托管平台会为页面分发、访问控制与服务安全处理正常网络请求信息，例如 IP
          地址、请求路径及浏览器信息；相关处理由实际托管服务及其政策管理。
        </p>
      </section>
      <section>
        <h2>桌面应用的本地数据</h2>
        <p>
          主机目录、普通偏好和插件配置保存在本机。密码、导入私钥及模型 Key
          交给操作系统凭据库；应用数据库保存对应引用。应用不默认将这些本地数据上传到 ServerDeck
          的云端账户服务。
        </p>
        <p>
          日志采用有界轮转，不记录明文密码、私钥、模型
          Key，以及终端、文件和模型正文。任务与连接结束不等于删除服务器上的文件；应用的数据目录迁移和恢复有独立确认及数据保护流程。
        </p>
      </section>
      <section>
        <h2>AI 模型与上下文</h2>
        <p>
          使用远程模型时，助手会在你的授权范围内采集相关主机证据，并将必要上下文发送到你配置的模型服务。发送前进行脱敏与预算缩减，但不能保证识别全部业务秘密。请按实际数据要求选择服务，并查阅对应提供方的数据政策。
        </p>
        <p>
          本地 Codex / Claude Code 仅表示推理通过本机 CLI
          来源调用，不代表模型一定在本机离线运行；CLI 可能连接其提供方服务。相关登录和配置由对应 CLI
          管理。
        </p>
      </section>
      <section>
        <h2>下载、更新与外部链接</h2>
        <p>
          安装包、软件更新和项目源码通过 GitHub
          提供。点击下载、访问源码或问题反馈时，浏览器会请求对应外部服务；桌面应用的更新检查也会访问固定的
          GitHub HTTPS 分发源。这些外部服务适用各自的隐私与访问政策。
        </p>
      </section>
      <section>
        <h2>管理和提问</h2>
        <p>
          你可以在应用设置中管理数据目录、模型来源、插件权限与自动更新偏好。需要咨询产品行为时，可在项目问题区反馈。请勿在公开问题中附带密码、私钥、模型
          Key、未经脱敏的日志或业务数据。
        </p>
        <a class="legal-link" :href="links.issues" target="_blank" rel="noopener noreferrer"
          >前往 GitHub Issues <ExternalLink :size="14"
        /></a>
      </section>
    </template>
    <template v-else>
      <section>
        <h2>先确认你连接的是谁</h2>
        <p>
          SSH 连接验证主机密钥。首次连接须通过可信渠道核对 SHA-256
          指纹后再信任；密钥变化会拒绝连接。跳板路径的每一跳都需要身份验证，TCP 可达不等于认证成功。
        </p>
      </section>
      <section>
        <h2>秘密与普通配置分开保存</h2>
        <p>
          密码、私钥和模型 Key
          保存在系统凭据库，不回退为普通明文配置。系统凭据库不可用时，相应操作失败。插件、网页和普通前端不能任意读取秘密或运行本机
          Shell。
        </p>
      </section>
      <section>
        <h2>传输完成不只是字节发完</h2>
        <p>
          SFTP 传输使用目标暂存、SHA-256
          读回校验与提交检查；覆盖和冲突需要按实际策略处理。文件页上传中断或退出后可重新选择同一文件和目标目录，匹配断点时自动核对已有内容并续传，完成校验后再提交。
        </p>
        <p>
          远程文本保存检查原文及基础元数据；仍受 SFTP
          协议和服务端能力限制，无法消除所有外部并发修改竞态。
        </p>
      </section>
      <section>
        <h2>AI 有能力，也需要授权</h2>
        <p>
          助手默认请求批准。计划绑定实际目标、参数和修订，执行后复查。审批模式不能跳过首次 SSH
          指纹、基础权限和目标复验，也不会自动提权。远端内容及模型输出不能代替可信用户指令。
        </p>
        <p>
          即使启用更宽的审批模式，也只能在你已经授予的能力和目录范围内工作。执行失败或结果未确认时保留真实状态；回答结束不代表运维目标已经完成。
        </p>
      </section>
      <section>
        <h2>插件包需要可信来源</h2>
        <p>
          上传插件默认禁用且未授权，权限和资源绑定安装修订。当前插件包不提供密码学签名验证；作者名称和摘要不能证明开发者身份。请仅安装经过核对的来源，并按需要授予权限。
        </p>
      </section>
      <section>
        <h2>从官方分发源更新</h2>
        <p>
          Windows x64
          正式安装版可检查更高正式版本，并验证内置公钥签名及签名中的版本后安装。更新签名与 Windows
          Authenticode 发布者签名是不同机制。更新不会自动降级或覆盖恢复数据库。
        </p>
        <p>
          macOS、Linux、其他架构及安装升级链路须分别验收；本网站的存在不代表所有平台已经完成产品验收。
        </p>
        <a class="legal-link" :href="links.security">阅读完整安全说明 <ArrowRight :size="14" /></a>
      </section>
    </template>
  </main>
</template>
