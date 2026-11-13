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
import { setLocale } from '@serverdeck/plugin-sdk/i18n';
let app: App, root: HTMLDivElement, pinia: Pinia;
const model = (id: string, name: string): AiModel => ({
  id,
  name,
  revision: 'r1',
  createdAt: '2026-11-13T02:30:45.000Z',
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
  setLocale('zh-CN');
  app?.unmount();
  root?.remove();
  disposePinia(pinia);
});
it('reuses remote and local model snapshots after remount and refreshes the selected source explicitly', async () => {
  api.models.mockResolvedValue([model('cached', '缓存模型')]);
  await mount();
  expect(api.models).toHaveBeenCalledTimes(1);
  expect(api.localCodexStatus).toHaveBeenCalledTimes(1);
  expect(api.localClaudeCodeStatus).toHaveBeenCalledTimes(1);
  app.unmount();
  root.remove();
  await mount();
  expect(root.textContent).toContain('缓存模型');
  expect(root.textContent).not.toContain('正在读取模型列表…');
  expect(root.textContent).not.toContain('正在检测本地工具…');
  expect(api.models).toHaveBeenCalledTimes(1);
  expect(api.localCodexStatus).toHaveBeenCalledTimes(1);
  expect(api.localClaudeCodeStatus).toHaveBeenCalledTimes(1);
  button('刷新').click();
  await settle();
  expect(api.models).toHaveBeenCalledTimes(2);
  expect(api.localCodexStatus).toHaveBeenCalledTimes(1);
  root.querySelector<HTMLButtonElement>('#model-tab-local')!.click();
  await settle();
  button('刷新').click();
  await settle();
  expect(api.localCodexStatus).toHaveBeenCalledTimes(2);
  expect(api.localClaudeCodeStatus).toHaveBeenCalledTimes(2);
  expect(api.models).toHaveBeenCalledTimes(2);
});
it('opens remote models by default and scopes counts, actions and feedback to their tabs', async () => {
  api.models.mockResolvedValue([model('a', '模型 A'), model('b', '模型 B')]);
  await mount();
  const localTab = root.querySelector<HTMLButtonElement>('#model-tab-local')!;
  const remoteTab = root.querySelector<HTMLButtonElement>('#model-tab-remote')!;
  const localPanel = root.querySelector<HTMLElement>('#model-panel-local')!;
  const remotePanel = root.querySelector<HTMLElement>('#model-panel-remote')!;
  expect(localTab.textContent?.trim()).toBe('本地CLI');
  const toolbar = root.querySelector<HTMLElement>('.section-heading .model-toolbar')!;
  expect(remoteTab.getAttribute('aria-selected')).toBe('true');
  expect(remoteTab.querySelector('.asset-count')?.textContent).toBe('2');
  expect(localTab.querySelector('.asset-count')).toBeNull();
  expect(root.querySelector('h1')?.textContent).toBe('模型');
  expect(localPanel.style.display).toBe('none');
  expect(remotePanel.style.display).not.toBe('none');
  expect(remotePanel.textContent).toContain('模型 A');
  expect(toolbar.style.display).not.toBe('none');
  expect(toolbar.textContent).toContain('刷新');
  expect(toolbar.textContent).toContain('注册模型');
  expect(remotePanel.textContent).not.toContain('Key 保存于系统凭据库');
  expect(remotePanel.textContent).not.toContain('本地 Codex');
  useModelsStore().error = '远程模型读取失败';
  localTab.click();
  await settle();
  expect(localPanel.style.display).not.toBe('none');
  expect(remotePanel.style.display).toBe('none');
  expect(toolbar.style.display).not.toBe('none');
  expect(toolbar.textContent?.trim()).toBe('刷新');
  expect(localPanel.textContent).not.toContain('刷新');
  expect(localPanel.querySelector('h2')).toBeNull();
  expect(localPanel.textContent).toContain('无法读取登录凭据');
  expect(localPanel.textContent).not.toContain('远程模型读取失败');
  expect(localPanel.textContent).not.toContain('注册模型');
  expect(localPanel.textContent).not.toContain('Key 保存于系统凭据库');
  button('刷新').click();
  await settle();
  expect(api.models).toHaveBeenCalledOnce();
  expect(api.localCodexStatus).toHaveBeenCalledTimes(2);
  remoteTab.click();
  await settle();
  expect(remotePanel.style.display).not.toBe('none');
  expect(toolbar.style.display).not.toBe('none');
  expect(remotePanel.textContent).toContain('远程模型读取失败');
  button('刷新').click();
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
it('shows API model IDs, aliases, separate token limits and key status without duplicating names', async () => {
  const primary = model('internal-a', '生产诊断');
  primary.config = {
    ...primary.config,
    model: 'vendor/atlas',
    contextWindowTokens: 256000,
    maxOutputTokens: 8192,
  };
  const backup = model('internal-b', 'vendor/backup');
  backup.config = {
    ...backup.config,
    model: 'vendor/backup',
    baseUrl: 'http://backup.example/v1',
    allowInsecureHttp: true,
  };
  backup.hasKey = false;
  api.models.mockResolvedValue([primary, backup]);
  await mount();
  const rows = root.querySelectorAll('.model-list > li');
  expect(rows[0]!.querySelector('h2')?.textContent?.trim()).toBe('vendor/atlas');
  expect(rows[0]!.querySelector('.model-name')?.textContent).toBe('生产诊断');
  expect([...rows[0]!.querySelectorAll('.model-limit strong')].map((el) => el.textContent)).toEqual(
    ['256,000', '8,192'],
  );
  expect(rows[0]!.querySelector('.model-key-status .model-badge')?.getAttribute('title')).toBe(
    'Key 已存系统凭据库',
  );
  expect(rows[0]!.textContent).not.toContain('internal-a');
  expect(rows[0]!.textContent).not.toContain('OpenAI 兼容 API');
  expect(rows[1]!.querySelector('h2')?.textContent?.trim()).toBe('vendor/backup');
  expect(rows[1]!.querySelector('.model-name')).toBeNull();
  expect(rows[1]!.querySelector('.model-endpoint')?.textContent).toBe('http://backup.example/v1');
  expect(rows[1]!.querySelector('.model-key-status')?.textContent).toContain('未设置 Key');
  expect(rows[1]!.querySelector('.model-badges')?.textContent).toContain('HTTP 明文');
});
it('shows registration times in the local timezone, marks historical times unknown and updates the locale', async () => {
  const current = model('new', '新模型');
  const historical = { ...model('old', '历史模型'), createdAt: null };
  api.models.mockResolvedValue([current, historical]);
  await mount();
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  };
  for (const [language, label, unknown] of [
    ['zh-CN', '注册时间', '未知'],
    ['en-US', 'Registered at', 'Unknown'],
  ] as const) {
    setLocale(language);
    await settle();
    const rows = root.querySelectorAll('.model-list > li');
    const time = rows[0]!.querySelector('time')!;
    expect(root.querySelector('.model-list-heading')?.textContent).toContain(label);
    expect(time.dateTime).toBe(current.createdAt);
    expect(time.textContent).toBe(
      new Intl.DateTimeFormat(language, options)
        .format(new Date(current.createdAt!))
        .replaceAll('/', '-'),
    );
    expect(time.textContent).not.toContain('/');
    expect(time.textContent).toMatch(/\d{2}-\d{2}/);
    expect(rows[0]!.querySelector('.model-registration-time .model-field-label')?.textContent).toBe(
      label,
    );
    expect(rows[1]!.querySelector('.model-registration-time')?.textContent).toContain(unknown);
    expect(rows[1]!.querySelector('time')).toBeNull();
  }
});
it('lists newest registrations first, keeps unknown times last and preserves sorting during search and refresh', async () => {
  const historicalA = { ...model('legacy-a', '历史 A'), createdAt: null };
  const historicalB = { ...model('legacy-b', '历史 B'), createdAt: null };
  const older = { ...model('older', '模型 A'), createdAt: '2026-10-31T23:59:59.999Z' };
  const newer = { ...model('newer', '模型 B'), createdAt: '2026-11-13T02:30:45.000Z' };
  const sameTime = { ...model('same-time', '模型 C'), createdAt: newer.createdAt };
  const original = [historicalA, older, newer, sameTime, historicalB];
  api.models.mockResolvedValue(original);
  await mount();
  const names = () => [...root.querySelectorAll('.model-name')].map((el) => el.textContent);
  expect(names()).toEqual(['模型 B', '模型 C', '模型 A', '历史 A', '历史 B']);
  expect(useModelsStore().models.map((entry) => entry.id)).toEqual(
    original.map((entry) => entry.id),
  );
  const search = root.querySelector<HTMLInputElement>('[aria-label="搜索模型"]')!;
  search.value = '模型';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  expect(names()).toEqual(['模型 B', '模型 C', '模型 A']);
  api.models.mockResolvedValue([older, historicalA, newer, sameTime, historicalB]);
  button('刷新').click();
  await settle();
  expect(names()).toEqual(['模型 B', '模型 C', '模型 A']);
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  expect(names()).toEqual(['模型 B', '模型 C', '模型 A', '历史 A', '历史 B']);
});
it('puts newly registered models first and keeps edited models ordered by their original registration time', async () => {
  const older = { ...model('older', '已有模型'), createdAt: '2026-11-01T00:00:00.000Z' };
  const newer = { ...model('newer', '最新模型'), createdAt: '2026-11-13T00:00:00.000Z' };
  api.models.mockResolvedValue([older]);
  await mount();
  const store = useModelsStore();
  const names = () => [...root.querySelectorAll('.model-name')].map((el) => el.textContent);
  api.modelSave.mockResolvedValue({ value: newer, warnings: [] });
  expect(
    await store.save({
      id: null,
      expectedRevision: null,
      name: newer.name,
      config: newer.config,
      apiKey: null,
      clearKey: false,
      testId: 'passed-test',
    }),
  ).toBe(true);
  await settle();
  expect(names()).toEqual(['最新模型', '已有模型']);
  root.querySelector<HTMLButtonElement>('[aria-label="编辑模型 已有模型"]')!.click();
  await settle();
  await fill('模型名称', '改名后的模型');
  api.modelSave.mockResolvedValue({
    value: { ...older, name: '改名后的模型', revision: 'r2' },
    warnings: [],
  });
  await submit();
  expect(names()).toEqual(['最新模型', '改名后的模型']);
  expect(document.querySelector('dialog')).toBeNull();
});
it('filters locally by model ID, name and endpoint, preserves the query across tabs and refreshes, and clears no-match results', async () => {
  const primary = model('a', '生产诊断');
  primary.config = {
    ...primary.config,
    model: 'Vendor/Atlas-Primary',
    baseUrl: 'https://gateway.internal/v1',
  };
  const backup = model('b', '备用模型');
  backup.config = {
    ...backup.config,
    model: 'vendor/LLM-Beta',
    baseUrl: 'https://backup.example/v1',
  };
  api.models.mockResolvedValue([primary, backup]);
  await mount();
  const search = root.querySelector<HTMLInputElement>('[aria-label="搜索模型"]')!;
  const ids = () =>
    [...root.querySelectorAll('.model-list h2')].map((el) => el.textContent?.trim());
  async function query(value: string) {
    search.value = value;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
  }
  for (const [value, expected] of [
    ['  生产 ', ['Vendor/Atlas-Primary']],
    ['llm-BETA', ['vendor/LLM-Beta']],
    [' GATEWAY.INTERNAL ', ['Vendor/Atlas-Primary']],
    ['   ', ['Vendor/Atlas-Primary', 'vendor/LLM-Beta']],
  ] as const) {
    await query(value);
    expect(ids()).toEqual(expected);
    expect(root.querySelector('.model-filter-summary')?.textContent?.trim()).toBe(
      `显示 ${expected.length} / 2 个模型`,
    );
    expect(root.querySelector('#model-tab-remote .asset-count')?.textContent).toBe('2');
  }
  await query('no-match');
  expect(root.textContent).toContain('没有匹配的模型');
  expect(root.textContent).not.toContain('尚未注册模型');
  expect(root.querySelector('.model-catalog')).toBeNull();
  expect(useModelsStore().models).toHaveLength(2);
  button('清除搜索').click();
  await settle();
  expect(search.value).toBe('');
  expect(ids()).toHaveLength(2);
  expect(api.models).toHaveBeenCalledOnce();
  await query('llm-beta');
  root.querySelector<HTMLButtonElement>('[aria-label="编辑模型 备用模型"]')!.click();
  await settle();
  expect(document.querySelector<HTMLInputElement>('dialog input[maxlength="200"]')?.value).toBe(
    'vendor/LLM-Beta',
  );
  button('取消').click();
  await settle();
  expect(search.value).toBe('llm-beta');
  expect(api.modelSave).not.toHaveBeenCalled();
  await query('atlas');
  root.querySelector<HTMLButtonElement>('#model-tab-local')!.click();
  await settle();
  expect(root.querySelector<HTMLElement>('#model-panel-remote')?.style.display).toBe('none');
  root.querySelector<HTMLButtonElement>('#model-tab-remote')!.click();
  await settle();
  expect(search.value).toBe('atlas');
  expect(ids()).toEqual(['Vendor/Atlas-Primary']);
  api.models.mockResolvedValue([backup]);
  button('刷新').click();
  await settle();
  expect(search.value).toBe('atlas');
  expect(root.textContent).toContain('没有匹配的模型');
  expect(root.querySelector('.model-filter-summary')?.textContent?.trim()).toBe(
    '显示 0 / 1 个模型',
  );
  expect(api.models).toHaveBeenCalledTimes(2);
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
  expect(button('刷新').disabled).toBe(true);
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
  const actions = document.querySelector('.model-form-footer')!;
  expect(document.querySelector('.model-form-section')).toBeNull();
  expect(document.querySelector('.model-form details')).toBeNull();
  expect(document.querySelector('.model-test-panel')).toBeNull();
  expect(actions.querySelector('.model-form-status')?.textContent?.trim()).toBe('请先完成连接测试');
  expect([...actions.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
    '测试连接',
    '取消',
    '保存模型',
  ]);
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
  expect(root.querySelector('.model-key-status .model-badge')?.getAttribute('title')).toBe(
    'Key 已存系统凭据库',
  );
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
  button('刷新').click();
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
  const status = document.querySelector('.model-form-status')!;
  expect(status.querySelector('[role="alert"]')?.textContent).toBe('模型认证失败');
  expect(button('保存模型').disabled).toBe(true);
  expect(useModelsStore().models).toHaveLength(0);
  button('测试连接').click();
  await settle();
  expect(status.querySelector('[role="status"]')?.textContent).toContain('连接成功');
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
  const status = document.querySelector('.model-form-status')!;
  expect(status.getAttribute('aria-busy')).toBe('true');
  expect(status.querySelector('[role="status"]')?.textContent).toContain('正在验证地址');
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
  expect(status.querySelector('[role="status"]')?.textContent).toContain('测试结果已过期');
  expect(status.getAttribute('aria-busy')).toBe('false');
});
