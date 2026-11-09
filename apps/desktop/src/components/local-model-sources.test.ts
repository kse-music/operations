import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
const api = vi.hoisted(() => ({
  localCodexStatus: vi.fn(),
  localClaudeCodeStatus: vi.fn(),
  localCodexAuthorize: vi.fn(),
  localClaudeCodeAuthorize: vi.fn(),
  localToolInstall: vi.fn(),
  localToolInstallCancel: vi.fn(),
}));
vi.mock('../services/ai', () => ({ aiApi: api }));
import LocalModelSources from './LocalModelSources.vue';
import { usePluginsStore } from '../stores/plugins';
let app: App | undefined, root: HTMLElement, pinia: Pinia;
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};
beforeEach(() => {
  vi.resetAllMocks();
  pinia = createPinia();
  setActivePinia(pinia);
  for (const read of [api.localCodexStatus, api.localClaudeCodeStatus])
    read.mockResolvedValue({ installed: true, authorized: false, message: '已安装，尚未授权' });
});
afterEach(async () => {
  app?.unmount();
  app = undefined;
  await settle();
  root?.remove();
  disposePinia(pinia);
  vi.restoreAllMocks();
});
async function mount() {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(LocalModelSources).use(pinia);
  app.mount(root);
  await settle();
}
function click(text: string, index = 0) {
  [...root.querySelectorAll<HTMLButtonElement>('button')]
    .filter((button) => button.textContent?.trim() === text)
    [index]!.click();
}
it.each([0, 1])(
  'requires trusted approval before using source %s and revokes only that source',
  async (index) => {
    await mount();
    const reads = [api.localCodexStatus, api.localClaudeCodeStatus],
      authorizers = [api.localCodexAuthorize, api.localClaudeCodeAuthorize];
    const p = usePluginsStore();
    click('授权使用', index);
    await settle();
    expect(p.prompt?.message).toContain('登录状态');
    expect(authorizers[index]).not.toHaveBeenCalled();
    p.decide(false);
    await settle();
    expect(authorizers[index]).not.toHaveBeenCalled();
    reads[index]!.mockResolvedValue({ installed: true, authorized: true, message: '已授权' });
    click('授权使用', index);
    await settle();
    p.decide(true);
    await settle();
    expect(authorizers[index]).toHaveBeenCalledExactlyOnceWith(true);
    expect(authorizers[1 - index]).not.toHaveBeenCalled();
    click('撤销授权');
    await settle();
    expect(authorizers[index]).toHaveBeenLastCalledWith(false);
  },
);
it.each([0, 1])(
  'installs only the fixed platform source %s, reports failure and retries',
  async (index) => {
    [api.localCodexStatus, api.localClaudeCodeStatus][index]!.mockResolvedValue({
      installed: false,
      authorized: false,
      installSupported: true,
      message: '未安装',
    });
    api.localToolInstall.mockRejectedValueOnce({ message: '官方源网络不可用' });
    await mount();
    click('下载安装');
    await settle();
    expect(root.textContent).toContain('官方源网络不可用');
    expect(api.localToolInstall).toHaveBeenCalledWith(
      index === 0 ? 'local-codex' : 'local-claude-code',
      expect.any(String),
    );
    api.localToolInstall.mockResolvedValueOnce(undefined);
    click('下载安装');
    await settle();
    expect(root.textContent).toContain('下载完成');
    expect(api.localCodexAuthorize).not.toHaveBeenCalled();
    expect(api.localClaudeCodeAuthorize).not.toHaveBeenCalled();
  },
);
it('cancels only the active download on explicit cancel and dispose', async () => {
  api.localCodexStatus.mockResolvedValue({
    installed: false,
    installSupported: true,
    message: '未安装',
  });
  let finish!: (value: unknown) => void;
  api.localToolInstall.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  await mount();
  click('下载安装');
  await settle();
  const request = api.localToolInstall.mock.lastCall![1];
  click('取消下载');
  await settle();
  expect(api.localToolInstallCancel).toHaveBeenCalledWith(request);
  app!.unmount();
  app = undefined;
  await settle();
  expect(api.localToolInstallCancel).toHaveBeenLastCalledWith(request);
  finish(null);
  await settle();
  expect(api.localCodexAuthorize).not.toHaveBeenCalled();
});
it('does not authorize a disposed approval and preserves other owners prompts', async () => {
  await mount();
  click('授权使用');
  await settle();
  const p = usePluginsStore();
  expect(p.prompt?.owner).toBe('platform-model-sources');
  app!.unmount();
  app = undefined;
  await settle();
  expect(p.prompt).toBeNull();
  expect(api.localCodexAuthorize).not.toHaveBeenCalled();
  const answer = p.ask('Other page', 'Pending', undefined, 'other');
  await mount();
  app!.unmount();
  app = undefined;
  await settle();
  expect(p.prompt?.owner).toBe('other');
  p.decide(false);
  await answer;
});
