import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
const api = vi.hoisted(() => ({
  models: vi.fn(),
  modelSave: vi.fn(),
  modelDelete: vi.fn(),
  modelTest: vi.fn(),
  localCodexStatus: vi.fn(),
  localClaudeCodeStatus: vi.fn(),
  localCodexAuthorize: vi.fn(),
  localClaudeCodeAuthorize: vi.fn(),
  localToolInstall: vi.fn(),
  localToolInstallCancel: vi.fn(),
}));
vi.mock('../services/ai', () => ({ aiApi: api }));
import ModelsView from './ModelsView.vue';
import { useModelsStore } from '../stores/models';
import { defaultAiConfig, type AiModel, type AiModelInput } from '../types/ai';
let app: App, root: HTMLDivElement, pinia: Pinia;
const model = (id: string, name: string): AiModel => ({
  id,
  name,
  revision: 'r1',
  config: { ...defaultAiConfig(), model: `remote-${id}` },
  hasKey: true,
});
async function settle() {
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
}
function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )!;
}
async function fill(label: string, value: string) {
  const input = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find((l) => l.textContent?.trim().startsWith(label))!
    .querySelector<HTMLInputElement>('input')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  return input;
}
async function mount() {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(ModelsView);
  app.use(pinia);
  app.mount(root);
  await settle();
}
async function submit() {
  document
    .querySelector('dialog form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}
beforeEach(() => {
  vi.resetAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  api.models.mockResolvedValue([]);
  api.modelTest.mockResolvedValue({ id: 'passed-test', elapsedMs: 42, expiresInSeconds: 300 });
  api.modelDelete.mockResolvedValue({ value: null, warnings: [] });
  api.localCodexStatus.mockResolvedValue({ installed: false, message: '尚未安装本地 Codex' });
  api.localClaudeCodeStatus.mockResolvedValue({
    installed: true,
    authorized: true,
    message: '已连接本地 Claude Code',
  });
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
it('opens remote models by default and scopes counts, actions and feedback to their tabs', async () => {
  api.models.mockResolvedValue([model('a', '模型 A'), model('b', '模型 B')]);
  await mount();
  const localTab = root.querySelector<HTMLButtonElement>('#model-tab-local')!;
  const remoteTab = root.querySelector<HTMLButtonElement>('#model-tab-remote')!;
  const localPanel = root.querySelector<HTMLElement>('#model-panel-local')!;
  const remotePanel = root.querySelector<HTMLElement>('#model-panel-remote')!;
  expect(remoteTab.getAttribute('aria-selected')).toBe('true');
  expect(remoteTab.querySelector('.asset-count')?.textContent).toBe('2');
  expect(localTab.querySelector('.asset-count')).toBeNull();
  expect(root.querySelector('h1')?.textContent).toBe('模型');
  expect(localPanel.style.display).toBe('none');
  expect(remotePanel.style.display).not.toBe('none');
  expect(remotePanel.textContent).toContain('模型 A');
  expect(remotePanel.textContent).toContain('注册模型');
  expect(remotePanel.textContent).toContain('Key 保存于系统凭据库');
  expect(remotePanel.textContent).not.toContain('本地 Codex');
  useModelsStore().error = '远程模型读取失败';
  localTab.click();
  await settle();
  expect(localPanel.style.display).not.toBe('none');
  expect(remotePanel.style.display).toBe('none');
  expect(localPanel.textContent).toContain('刷新状态');
  expect(localPanel.textContent).toContain('无法读取登录凭据');
  expect(localPanel.textContent).not.toContain('远程模型读取失败');
  expect(localPanel.textContent).not.toContain('注册模型');
  expect(localPanel.textContent).not.toContain('Key 保存于系统凭据库');
  button('刷新状态').click();
  await settle();
  expect(api.models).toHaveBeenCalledOnce();
  expect(api.localCodexStatus).toHaveBeenCalledTimes(2);
  remoteTab.click();
  await settle();
  expect(remotePanel.style.display).not.toBe('none');
  expect(remotePanel.textContent).toContain('远程模型读取失败');
  button('刷新模型').click();
  await settle();
  expect(api.models).toHaveBeenCalledTimes(2);
  expect(api.localCodexStatus).toHaveBeenCalledTimes(2);
});
it('supports arrow, Home and End keys with one tab stop and linked panels', async () => {
  await mount();
  const localTab = root.querySelector<HTMLButtonElement>('#model-tab-local')!;
  const remoteTab = root.querySelector<HTMLButtonElement>('#model-tab-remote')!;
  remoteTab.focus();
  for (const [key, target] of [
    ['ArrowLeft', localTab],
    ['ArrowLeft', remoteTab],
    ['Home', localTab],
    ['End', remoteTab],
    ['ArrowRight', localTab],
    ['ArrowRight', remoteTab],
  ] as const) {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await settle();
    expect(document.activeElement).toBe(target);
    expect(target.getAttribute('aria-selected')).toBe('true');
    expect(root.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
    const panel = root.querySelector<HTMLElement>(`#${target.getAttribute('aria-controls')}`)!;
    expect(panel.getAttribute('aria-labelledby')).toBe(target.id);
    expect(panel.style.display).not.toBe('none');
  }
});
it('keeps a local download alive when switching tabs and shows its completion on return', async () => {
  let finish!: () => void;
  api.localToolInstall.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
  await mount();
  const localTab = root.querySelector<HTMLButtonElement>('#model-tab-local')!;
  localTab.click();
  await settle();
  button('下载安装').click();
  await settle();
  expect(api.localToolInstall).toHaveBeenCalledExactlyOnceWith('local-codex', expect.any(String));
  root.querySelector<HTMLButtonElement>('#model-tab-remote')!.click();
  await settle();
  expect(api.localToolInstallCancel).not.toHaveBeenCalled();
  expect(api.localCodexStatus).toHaveBeenCalledOnce();
  api.localCodexStatus.mockResolvedValue({ installed: true, message: '已安装，尚未授权' });
  finish();
  await settle();
  localTab.click();
  await settle();
  expect(root.querySelector('#model-panel-local')?.textContent).toContain('下载完成');
  expect(button('授权使用').disabled).toBe(false);
  expect(api.localCodexAuthorize).not.toHaveBeenCalled();
  expect(api.localToolInstallCancel).not.toHaveBeenCalled();
});
it('registers and lists real returned models, sends the key only in the transient save input', async () => {
  await mount();
  expect(root.textContent).toContain('尚未注册模型');
  button('注册模型').click();
  await settle();
  await fill('模型名称', '诊断模型');
  await fill('模型 ID', 'remote-model');
  await fill('API Key', 'fixture-key');
  expect(button('保存模型').disabled).toBe(true);
  await submit();
  expect(api.modelSave).not.toHaveBeenCalled();
  button('测试连接').click();
  await settle();
  expect(button('保存模型').disabled).toBe(false);
  let submitted: AiModelInput | null = null;
  api.modelSave.mockImplementation(async (input: AiModelInput) => {
    submitted = structuredClone(input);
    return {
      value: { ...model('created', input.name), config: { ...input.config } },
      warnings: [],
    };
  });
  await submit();
  expect(submitted).toMatchObject({
    id: null,
    expectedRevision: null,
    name: '诊断模型',
    apiKey: 'fixture-key',
    clearKey: false,
    testId: 'passed-test',
    config: { model: 'remote-model' },
  });
  expect(root.textContent).toContain('诊断模型');
  expect(root.textContent).toContain('Key 已存系统凭据库');
  expect(root.textContent).toContain('模型已保存');
  expect(document.querySelector('dialog')).toBeNull();
  expect(JSON.stringify(useModelsStore().models)).not.toContain('fixture-key');
  expect(JSON.stringify(useModelsStore().models)).not.toContain('apiKey');
});
it('edits one model with its saved revision and preserves its key when left blank', async () => {
  api.models.mockResolvedValue([model('a', '模型 A'), model('b', '模型 B')]);
  await mount();
  root.querySelector<HTMLButtonElement>('[aria-label="编辑模型 模型 A"]')!.click();
  await settle();
  expect(document.querySelector<HTMLInputElement>('dialog input[type=password]')!.value).toBe('');
  await fill('模型名称', '改名后的 A');
  let submitted: AiModelInput | null = null;
  api.modelSave.mockImplementation(async (input: AiModelInput) => {
    submitted = structuredClone(input);
    return {
      value: { ...model('a', input.name), revision: 'r2', config: { ...input.config } },
      warnings: [],
    };
  });
  await submit();
  expect(submitted).toMatchObject({
    id: 'a',
    expectedRevision: 'r1',
    apiKey: null,
    clearKey: false,
    name: '改名后的 A',
  });
  expect(root.textContent).toContain('改名后的 A');
  expect(root.textContent).toContain('模型 B');
  expect(useModelsStore().models).toHaveLength(2);
});
it('clears a transient key after failed save without adding a fake model', async () => {
  await mount();
  button('注册模型').click();
  await settle();
  await fill('模型名称', '失败模型');
  await fill('模型 ID', 'remote-model');
  const input = await fill('API Key', 'must-not-retain');
  button('测试连接').click();
  await settle();
  api.modelSave.mockRejectedValue({ message: '系统凭据库不可用' });
  await submit();
  expect(api.modelSave).toHaveBeenCalledOnce();
  expect(input.value).toBe('');
  expect(document.body.textContent).toContain('系统凭据库不可用');
  expect(useModelsStore().models).toHaveLength(0);
  expect(document.querySelector('dialog')).not.toBeNull();
});
it('requires a separate deletion confirmation, keeps a failed target and never selects another model implicitly', async () => {
  const a = model('a', '模型 A'),
    b = model('b', '模型 B');
  api.models.mockResolvedValue([a, b]);
  await mount();
  const store = useModelsStore();
  store.selectedId = 'a';
  root.querySelector<HTMLButtonElement>('[aria-label="删除模型 模型 A"]')!.click();
  await settle();
  expect(api.modelDelete).not.toHaveBeenCalled();
  button('取消').click();
  await settle();
  expect(store.models).toHaveLength(2);
  root.querySelector<HTMLButtonElement>('[aria-label="删除模型 模型 A"]')!.click();
  await settle();
  api.modelDelete.mockRejectedValueOnce({ message: '版本已变化，请刷新' });
  button('确认删除模型').click();
  await settle();
  expect(store.models).toHaveLength(2);
  expect(document.body.textContent).toContain('版本已变化');
  button('确认删除模型').click();
  await settle();
  expect(api.modelDelete).toHaveBeenLastCalledWith('a', 'r1', true);
  expect(store.models.map((m) => m.id)).toEqual(['b']);
  expect(store.selectedId).toBe('');
  expect(document.querySelector('dialog')).toBeNull();
});
it('shows loading and retryable list errors without pretending to load an empty catalog', async () => {
  api.models.mockImplementationOnce(() => {
    throw { message: '模型列表读取失败' };
  });
  await mount();
  expect(root.textContent).toContain('模型列表读取失败');
  expect(button('注册模型').disabled).toBe(true);
  expect(root.textContent).not.toContain('尚未注册模型');
  button('刷新模型').click();
  await settle();
  expect(root.textContent).toContain('尚未注册模型');
  expect(button('注册模型').disabled).toBe(false);
});

it('blocks failed tests and invalidates success when configuration or key changes', async () => {
  await mount();
  button('注册模型').click();
  await settle();
  await fill('模型名称', '测试模型');
  await fill('模型 ID', 'test-model');
  await fill('API Key', 'test-key');
  api.modelTest.mockRejectedValueOnce({ message: '模型认证失败' });
  button('测试连接').click();
  await settle();
  expect(document.body.textContent).toContain('模型认证失败');
  expect(button('保存模型').disabled).toBe(true);
  expect(useModelsStore().models).toHaveLength(0);
  button('测试连接').click();
  await settle();
  expect(document.body.textContent).toContain('连接成功');
  expect(button('保存模型').disabled).toBe(false);
  await fill('模型 ID', 'another-model');
  expect(button('保存模型').disabled).toBe(true);
  button('测试连接').click();
  await settle();
  await fill('API Key', 'another-key');
  expect(button('保存模型').disabled).toBe(true);
  expect(api.modelSave).not.toHaveBeenCalled();
});
it('ignores late tests after changes and expires test results', async () => {
  await mount();
  button('注册模型').click();
  await settle();
  await fill('模型名称', '测试模型');
  await fill('模型 ID', 'test-model');
  await fill('API Key', 'test-key');
  let resolve!: (value: unknown) => void;
  api.modelTest.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  button('测试连接').click();
  await settle();
  expect(button('保存模型').disabled).toBe(true);
  await fill('模型 ID', 'changed-during-request');
  resolve({ id: 'late', elapsedMs: 12, expiresInSeconds: 300 });
  await settle();
  expect(button('保存模型').disabled).toBe(true);
  api.modelTest.mockResolvedValueOnce({ id: 'expiring', elapsedMs: 12, expiresInSeconds: 0 });
  button('测试连接').click();
  await settle();
  await settle();
  expect(button('保存模型').disabled).toBe(true);
  expect(document.body.textContent).toContain('测试结果已过期');
});
