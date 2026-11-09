import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia } from 'pinia';
import AppView from './App.vue';
import { configLocation } from './config';
import { updateVisibility } from '@serverdeck/plugin-sdk/visibility';
import type { PlatformRequest } from '@serverdeck/plugin-sdk/types/platform';
const client = vi.hoisted(() => ({
  call: vi.fn(),
  invoke: vi.fn(),
  dirty: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@serverdeck/plugin-sdk', () => ({ invoke: client.invoke }));
vi.mock('@serverdeck/plugin-sdk/platform', () => ({ call: client.call }));
vi.mock('@serverdeck/plugin-sdk/drafts', () => ({ setDraftDirty: client.dirty }));
let app: App | undefined, root: HTMLDivElement;
const doc = {
  id: 'document-1',
  path: '/etc/nginx/nginx.conf',
  content: 'events {}',
  sha256: 'original',
  atomicSave: true,
};
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  updateVisibility(true);
  client.call.mockReset();
  client.invoke.mockReset();
  client.invoke.mockResolvedValue({
    success: true,
    records: [],
    detail: { output: 'test is successful' },
  });
  client.dirty.mockClear();
  client.call.mockImplementation(async (value: PlatformRequest) => {
    if (value.kind === 'read_file') return { ...doc };
    return null;
  });
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(AppView, { hostId: 'host-a' }).use(createPinia());
  app.mount(root);
});
afterEach(() => {
  app?.unmount();
  root.remove();
  updateVisibility(true);
  vi.restoreAllMocks();
});
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
};
function click(label: string) {
  [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === label)!
    .click();
}
async function edit(text: string) {
  const field = root.querySelector('textarea')!;
  field.value = text;
  field.dispatchEvent(new Event('input'));
  await settle();
}
it('maps the longest directory bind mount and protects read-only or single-file mounts', () => {
  expect(
    configLocation('/etc/nginx/nginx.conf', [
      { Type: 'bind', Source: '/srv/nginx', Destination: '/etc/nginx', RW: true },
    ]),
  ).toMatchObject({ path: '/srv/nginx/nginx.conf', writable: true });
  expect(
    configLocation('/etc/nginx/nginx.conf', [
      { Type: 'bind', Source: '/srv/file', Destination: '/etc/nginx/nginx.conf', RW: true },
    ]).writable,
  ).toBe(false);
  expect(
    configLocation('/etc/nginx/nginx.conf', [
      { Type: 'bind', Source: '/srv/nginx', Destination: '/etc/nginx', RW: false },
    ]).writable,
  ).toBe(false);
  expect(() =>
    configLocation('/etc/nginx-other/nginx.conf', [
      { Type: 'bind', Source: '/srv/nginx', Destination: '/etc/nginx', RW: true },
    ]),
  ).toThrow();
  expect(() => configLocation('/etc/../secret', [])).toThrow();
});
it('requires a separate reload and keeps the draft when saving fails', async () => {
  click('读取配置');
  await settle();
  await edit('events { worker_connections 512; }');
  expect(client.dirty).toHaveBeenCalledWith(true);
  client.call.mockImplementation(async (value: PlatformRequest) =>
    value.kind === 'save_file'
      ? { saved: false, message: '服务器文件已变化', recoveryPath: '/tmp/recovery' }
      : null,
  );
  click('保存配置');
  await settle();
  expect(root.querySelector('textarea')!.value).toContain('512');
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('服务器文件已变化');
  expect(client.invoke.mock.calls.some(([action]) => action === 'nginx')).toBe(false);
});
it('rechecks stale documents on every save attempt and never overwrites an external change', async () => {
  click('读取配置');
  await settle();
  await edit('my draft');
  updateVisibility(false);
  await settle();
  updateVisibility(true);
  await settle();
  client.call.mockImplementation(async (value: PlatformRequest) =>
    value.kind === 'read_file'
      ? { ...doc, id: 'reopened', sha256: 'changed', content: 'another administrator' }
      : null,
  );
  click('保存配置');
  await settle();
  click('保存配置');
  await settle();
  expect(client.call.mock.calls.filter(([value]) => value.kind === 'save_file')).toHaveLength(0);
  expect(client.call.mock.calls.filter(([value]) => value.kind === 'read_file')).toHaveLength(3);
  expect(root.querySelector('textarea')!.value).toBe('my draft');
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('草稿已保留');
});
it('keeps dirty configuration when changing deployment mode is cancelled', async () => {
  click('读取配置');
  await settle();
  await edit('my draft');
  const mode = root.querySelector<HTMLSelectElement>('select')!;
  mode.value = 'container';
  mode.dispatchEvent(new Event('change'));
  await settle();
  expect(document.body.textContent).toContain('继续操作会放弃当前配置草稿');
  click('继续编辑');
  await settle();
  expect(root.querySelector('textarea')!.value).toBe('my draft');
  expect(mode.value).toBe('host');
});
it('uses the selected full container ID and maps configuration to its persistent directory bind', async () => {
  const id = 'b'.repeat(64);
  client.call.mockImplementation(async (value: PlatformRequest) =>
    value.kind === 'read_file' ? { ...doc, path: value.path } : null,
  );
  client.invoke.mockImplementation(async (action: string) => {
    if (action === 'containers')
      return {
        success: true,
        records: [{ ID: id, Names: 'nginx-qa', State: 'running' }],
        detail: null,
      };
    if (action === 'mounts')
      return {
        success: true,
        records: [],
        detail: {
          mounts: [{ Type: 'bind', Source: '/srv/nginx-qa', Destination: '/etc/nginx', RW: true }],
        },
      };
    return { success: true, records: [], detail: { output: 'test is successful' } };
  });
  const mode = root.querySelector<HTMLSelectElement>('select')!;
  mode.value = 'container';
  mode.dispatchEvent(new Event('change'));
  await settle();
  const container = root.querySelectorAll<HTMLSelectElement>('select')[1]!;
  container.value = id;
  container.dispatchEvent(new Event('change'));
  await settle();
  click('读取配置');
  await settle();
  expect(client.call).toHaveBeenCalledWith({
    kind: 'read_file',
    hostId: 'host-a',
    path: '/srv/nginx-qa/nginx.conf',
  });
  click('校验配置');
  await settle();
  expect(client.invoke).toHaveBeenCalledWith('nginx', {
    hostId: 'host-a',
    target: { kind: 'container', id },
    configPath: '/etc/nginx/nginx.conf',
    action: 'test',
  });
});
