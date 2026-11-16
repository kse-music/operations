const repository = 'https://github.com/kse-music/operations';
const docsOrigin = import.meta.env.DEV ? 'http://127.0.0.1:4181' : '';
export const links = {
  repository,
  releases: `${repository}/releases`,
  latest: `${repository}/releases/latest`,
  guide: `${docsOrigin}/docs/`,
  installation: `${docsOrigin}/docs/installation.html`,
  docker: `${docsOrigin}/docs/docker.html`,
  assistant: `${docsOrigin}/docs/assistant.html`,
  plugins: `${docsOrigin}/developers/`,
  security: `${docsOrigin}/docs/security.html`,
  issues: `${repository}/issues`,
  license: `${docsOrigin}/docs/license.html`,
};
export type Tool = 'terminal' | 'files' | 'docker' | 'assistant';
export const tools: { id: Tool; name: string; title: string; description: string }[] = [
  {
    id: 'terminal',
    name: 'SSH 终端',
    title: '熟悉的终端，更顺手。',
    description: '本地与 SSH、多会话和分屏。把文件拖进当前 Shell，在真正的工作目录中继续。',
  },
  {
    id: 'files',
    name: 'SFTP 文件',
    title: '文件往来，有据可查。',
    description: '本地与远程双栏浏览。后台传输、冲突确认和 SHA-256 校验，进度之后还有结果。',
  },
  {
    id: 'docker',
    name: 'Docker',
    title: '容器里的事，看得清。',
    description: '查看容器、镜像与 Compose 项目。检查日志、打开 Shell，在实际对象上确认操作。',
  },
  {
    id: 'assistant',
    name: 'AI 助手',
    title: '带着上下文，和 AI 协作。',
    description: '结合主机证据分析问题，预览计划，按模式审批，并在执行后复查。',
  },
];
export const faqs = [
  {
    question: '需要注册账号，或在服务器上安装 Agent 吗？',
    answer:
      '不需要云账号或远端 Agent。ServerDeck 从本机通过 SSH / SFTP 连接你的服务器。Docker、Compose、sudo 切换用户等功能仍需要远端的实际权限及相应工具。',
  },
  {
    question: '目前可以在哪些平台上使用？',
    answer:
      '当前提供 Windows x64 安装包。macOS、Linux 与其他架构需要分别完成原生验收后再提供正式下载。界面支持简体中文和 English。',
  },
  {
    question: '可以导入已有的 SSH 配置吗？',
    answer:
      '可以从文件或粘贴文本导入 OpenSSH Config，先预览再选择保存。支持明确别名与受限 ProxyJump；不执行 ProxyCommand，无法安全判断的配置会明确拒绝。',
  },
  {
    question: 'AI 助手使用什么模型？需要额外配置吗？',
    answer:
      '需要先配置可用模型，再在助手插件设置中绑定。可接入远程 OpenAI 兼容服务，或单独授权本地 Codex / Claude Code 来源。远程模型可能产生对应服务的使用费用，ServerDeck 不提供内置模型额度。',
  },
  {
    question: 'AI 助手会直接修改服务器吗？',
    answer:
      '默认采用“请求批准”模式。助手可以采集证据、生成计划，再按审批模式执行并复查。首次主机指纹验证、基础权限和实际目标复验始终保留；不会自动提权。',
  },
  {
    question: '数据与密码存放在哪里？',
    answer:
      '主机、偏好与插件配置保存在本机；密码、私钥与模型 Key 由系统凭据库管理。使用远程模型时，相关上下文会在授权后发送至你配置的服务，脱敏不能保证覆盖全部业务秘密。',
  },
];
