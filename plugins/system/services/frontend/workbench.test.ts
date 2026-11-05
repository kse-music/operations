import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import Workbench from './App.vue';
import { useOpsStore } from '@serverdeck/plugin-sdk/stores/ops';
import { hostInput } from '@serverdeck/plugin-sdk/types/hosts';
const api = vi.hoisted(() => ({
  open: vi.fn(async () => ({ id: 'monitor' })),
  snapshot: vi.fn(async () => null),
  visible: vi.fn(async () => {}),
  stop: vi.fn(),
  query: vi.fn(async (_id: string, request: { kind: string }) => ({
    success: true,
    code: null,
    message: null,
    detail: { systemd: true },
    records: request.kind === 'services' ? [{ unit: 'owned.service' }] : [],
  })),
  feedback: vi.fn(async () => []),
}));
vi.mock('@serverdeck/plugin-sdk/services/monitor', () => ({ monitorApi: api }));
vi.mock('@serverdeck/plugin-sdk/services/ops', () => ({ opsApi: api }));
let app: App | undefined, root: HTMLDivElement, pinia: Pinia;
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await nextTick();
};
afterEach(() => {
  app?.unmount();
  disposePinia(pinia);
  root?.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});
it('keeps panel drafts while stopping hidden monitoring, and resumes only the selected panel', async () => {
  vi.useFakeTimers();
  pinia = createPinia();
  setActivePinia(pinia);
  useOpsStore().connections.host = {
    host: { ...hostInput(), id: 'host', createdAt: '', updatedAt: '' },
    state: 'connected',
    error: null,
    trust: null,
    session: { id: 'lease', hostId: 'host', transportId: 'transport', routeHostIds: ['host'] },
  };
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(Workbench, { hostId: 'host' }).use(pinia);
  app.mount(root);
  await settle();
  expect(api.open).toHaveBeenCalledTimes(1);
  expect(api.query).not.toHaveBeenCalled();
  const select = async (name: string) => {
    root.querySelector<HTMLButtonElement>(`[role=tab][aria-label="${name}"]`)!.click();
    await settle();
  };
  await select('systemd 服务');
  expect(api.visible).toHaveBeenCalledWith('host', false);
  const filter = root.querySelector<HTMLInputElement>('[aria-label="运维项目搜索"]')!;
  filter.value = 'retained.service';
  filter.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  await select('进程与端口');
  await select('systemd 服务');
  expect(root.querySelector<HTMLInputElement>('[aria-label="运维项目搜索"]')!.value).toBe(
    'retained.service',
  );
  expect(root.querySelector('[aria-label="网络诊断"]')).toBeNull();
  expect(root.querySelector('[aria-label="日志查看"]')).toBeNull();
  expect(root.querySelectorAll('[role="tab"]')).toHaveLength(3);
  await select('资源监控');
  expect(api.open).toHaveBeenCalledTimes(2);
  const tabs = root.querySelector('[aria-label="系统服务功能"]')!;
  tabs.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await settle();
  expect(root.querySelector('[aria-label="进程与端口"]')?.getAttribute('aria-selected')).toBe(
    'true',
  );
  expect(api.query).toHaveBeenCalledWith('lease', { kind: 'processes' });
});
