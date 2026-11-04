import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
const api = vi.hoisted(() => ({
  prepare: vi.fn(),
  start: vi.fn(),
  approve: vi.fn(),
  scheduleSave: vi.fn(),
  catalog: vi.fn(),
  history: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('@serverdeck/plugin-sdk/services/automation', () => ({ automationApi: api }));
import { useHostsStore } from '@serverdeck/plugin-sdk/stores/hosts';
import AutomationRunDialog from './AutomationRunDialog.vue';
import AutomationScheduleDialog from './AutomationScheduleDialog.vue';
import AutomationView from './AutomationView.vue';
import type { Entry, Run, Target } from '@serverdeck/plugin-sdk/types/automation';
import { entryInput } from '@serverdeck/plugin-sdk/types/automation';
import { defaultSshOptions } from '@serverdeck/plugin-sdk/types/connection';
const entry: Entry = {
  ...entryInput(),
  id: 'entry-id',
  revision: 3,
  updatedAt: 1,
  name: 'Literal task',
  kind: 'script',
  body: 'printf "%s" "$1"; printf "%s" "$2"',
  parameters: [
    { name: 'value', label: 'Text', kind: 'text', secret: false, required: true, default: null },
    { name: 'token', label: 'Token', kind: 'text', secret: true, required: true, default: null },
  ],
};
const target: Target = {
  hostId: 'host-a',
  name: 'Host A',
  hostname: 'original.example',
  port: 22,
  username: 'user',
  routeSignature: 'frozen-route',
};
const run = (id: string, state: Run['state'] = 'Success'): Run => ({
  id,
  spec: {
    entry,
    targets: [target],
    parameters: { value: 'literal' },
    hasSecrets: false,
    concurrency: 1,
    timeoutSecs: 3,
  },
  scheduleId: null,
  scheduledFor: null,
  trigger: 'manual',
  state,
  approvalRequired: false,
  message: null,
  createdAt: 1,
  finishedAt: state === 'Running' ? null : 2,
  revision: 1,
  rows: [
    {
      hostId: target.hostId,
      state,
      stdout: id,
      stderr: '',
      droppedBytes: 0,
      exitCode: state === 'Success' ? 0 : null,
      message: null,
      startedAt: 1,
      finishedAt: null,
    },
  ],
});
let app: App | undefined, root: HTMLDivElement;
async function flush() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}
beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.append(root);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function () {
      this.open = true;
    },
  });
  api.prepare.mockResolvedValue([entry, [target]]);
  api.history.mockResolvedValue([]);
  api.catalog.mockResolvedValue({ entries: [], groups: [], schedules: [], templates: [] });
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  root.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.resetAllMocks();
});
function mount(
  component: typeof AutomationRunDialog | typeof AutomationScheduleDialog | typeof AutomationView,
  props: Record<string, unknown> = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const hosts = useHostsStore();
  hosts.catalog = {
    hosts: [
      {
        ...target,
        id: target.hostId,
        name: target.name,
        hostname: target.hostname,
        port: 22,
        username: 'user',
        authType: 'agent',
        credentialId: null,
        groupId: null,
        tags: [],
        description: '',
        favorite: false,
        connectTimeoutSecs: 3,
        ssh: defaultSshOptions(),
        createdAt: '',
        updatedAt: '',
      },
    ],
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  app = createApp(component, props);
  app.use(pinia);
  app.mount(root);
  return hosts;
}
async function set(label: string, value: string) {
  const el = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  expect(el).toBeTruthy();
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}
function button(name: string) {
  const b = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  expect(b).toBeTruthy();
  return b!;
}
it('script preview freezes targets and positional inputs, masks and clears secret values', async () => {
  const hosts = mount(AutomationRunDialog, { entry, initialHostId: target.hostId });
  const literal = '中文 ; $(touch /data/never) \' "';
  await set('任务参数 value', literal);
  await set('任务参数 token', 'sensitive-test-value');
  document
    .querySelector('dialog form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  expect(document.body.textContent).not.toContain('sensitive-test-value');
  expect(document.body.textContent).toContain(entry.body);
  expect(document.body.textContent).toContain('user@original.example:22');
  hosts.catalog!.hosts[0]!.hostname = 'changed.example';
  await set('自动化执行确认文字', '执行 1 台');
  let received: unknown;
  api.start.mockImplementation(async (input) => {
    received = structuredClone(input);
    return run('started');
  });
  button('确认执行自动化').click();
  await flush();
  expect(received).toEqual(
    expect.objectContaining({
      expectedRevision: 3,
      hostIds: [target.hostId],
      expectedProfiles: { [target.hostId]: 'frozen-route' },
      parameters: { value: literal, token: 'sensitive-test-value' },
      confirmed: true,
    }),
  );
  expect((document.querySelector('[aria-label="任务参数 token"]') as HTMLInputElement).value).toBe(
    '',
  );
});
it('secret-parameter entries cannot silently create a persisted schedule', async () => {
  mount(AutomationScheduleDialog, { entry, initialHostId: target.hostId });
  await flush();
  expect(button('预览计划授权').disabled).toBe(true);
  expect(document.body.textContent).toContain('计划不保存秘密');
  expect(document.querySelector('[aria-label="计划参数 token"]')).toBeNull();
  expect(api.scheduleSave).not.toHaveBeenCalled();
});
it('dangerous schedule requires explicit authorization and explains per-occurrence approval', async () => {
  const safe = { ...entry, risk: 'dangerous' as const, parameters: [] };
  api.prepare.mockResolvedValue([safe, [target]]);
  mount(AutomationScheduleDialog, { entry: safe, initialHostId: target.hostId });
  const enabled = document.querySelector('[aria-label="启用本地计划"]') as HTMLInputElement;
  enabled.checked = true;
  enabled.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  document
    .querySelector('dialog form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  expect(document.body.textContent).toContain('每次必须人工预览后执行');
  expect(button('保存本地计划').disabled).toBe(true);
  const ack = document.querySelector('[aria-label="授权计划执行规则"]') as HTMLInputElement;
  ack.checked = true;
  ack.dispatchEvent(new Event('change', { bubbles: true }));
  api.scheduleSave.mockResolvedValue({});
  await flush();
  button('保存本地计划').click();
  await flush();
  expect(api.scheduleSave).toHaveBeenCalledWith(
    null,
    null,
    expect.objectContaining({
      enabled: true,
      authorized: true,
      expectedProfiles: { [target.hostId]: 'frozen-route' },
    }),
  );
});
it('templates start collapsed and each drawer can be opened and closed independently', async () => {
  api.catalog.mockResolvedValue({
    entries: [],
    groups: [],
    schedules: [],
    templates: [
      { ...entryInput(), name: '查看系统信息', body: 'hostname; uptime' },
      { ...entryInput(), name: '查看磁盘使用率', body: 'df -h -P' },
    ],
  });
  mount(AutomationView);
  await flush();
  const drawers = [...root.querySelectorAll<HTMLDetailsElement>('.automation-template-drawer')];
  expect(drawers).toHaveLength(2);
  expect(drawers.every((drawer) => !drawer.open)).toBe(true);
  expect(drawers.map((drawer) => drawer.querySelector('summary')?.textContent?.trim())).toEqual([
    '查看系统信息',
    '查看磁盘使用率',
  ]);
  drawers[0]!.querySelector('summary')!.click();
  expect(drawers.map((drawer) => drawer.open)).toEqual([true, false]);
  drawers[1]!.querySelector('summary')!.click();
  expect(drawers.map((drawer) => drawer.open)).toEqual([true, true]);
  drawers[0]!.querySelector('summary')!.click();
  expect(drawers.map((drawer) => drawer.open)).toEqual([false, true]);
  expect(document.querySelector('dialog')).toBeNull();
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.start).not.toHaveBeenCalled();
  expect(api.approve).not.toHaveBeenCalled();
});
it('expanded template selection preserves the full script for review without starting execution', async () => {
  const template = {
    ...entryInput(entry),
    name: '查看日志',
    body: `tail -n "$2" -- "$1"\n# ${'long script content '.repeat(100)}`,
  };
  api.catalog.mockResolvedValue({ entries: [], groups: [], schedules: [], templates: [template] });
  mount(AutomationView);
  await flush();
  const drawer = root.querySelector<HTMLDetailsElement>('.automation-template-drawer')!;
  expect(drawer.open).toBe(false);
  drawer.querySelector('summary')!.click();
  expect(drawer.open).toBe(true);
  expect(document.querySelector('pre')?.textContent).toBe(template.body);
  const useTemplate = document.querySelector<HTMLButtonElement>(
    '[aria-label="使用“查看日志”模板"]',
  );
  expect(useTemplate).toBeTruthy();
  useTemplate!.click();
  await flush();
  expect(drawer.open).toBe(true);
  expect(document.querySelector<HTMLInputElement>('[aria-label="自动化条目名称"]')?.value).toBe(
    template.name,
  );
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="自动化条目正文"]')?.value).toBe(
    template.body,
  );
  expect(document.querySelector<HTMLSelectElement>('[aria-label="自动化条目类型"]')?.value).toBe(
    'script',
  );
  expect(document.querySelectorAll('.automation-param')).toHaveLength(template.parameters.length);
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.start).not.toHaveBeenCalled();
  expect(api.approve).not.toHaveBeenCalled();
});
it('late history polling cannot replace the selected run with another host result', async () => {
  api.history.mockResolvedValue(
    ['A', 'B'].map((id) => ({
      id,
      entryName: `Task ${id}`,
      state: 'Running',
      approvalRequired: false,
      trigger: 'manual',
      scheduleId: null,
      createdAt: id === 'A' ? 1 : 2,
      finishedAt: null,
      targets: 1,
      message: null,
    })),
  );
  mount(AutomationView);
  await flush();
  button('执行历史').click();
  await flush();
  api.run.mockResolvedValueOnce(run('A', 'Running'));
  document.querySelector<HTMLButtonElement>('[data-run-id="A"]')!.click();
  await flush();
  let resolve: (r: Run) => void = () => {};
  api.run.mockImplementationOnce(
    () =>
      new Promise<Run>((r) => {
        resolve = r;
      }),
  );
  await vi.advanceTimersByTimeAsync(1500);
  api.run.mockResolvedValueOnce(run('B'));
  document.querySelector<HTMLButtonElement>('[data-run-id="B"]')!.click();
  await flush();
  resolve(run('A'));
  await flush();
  expect(document.querySelector('[aria-label="自动化执行详情"]')?.textContent).toContain('RunId=B');
  expect(document.querySelector('[aria-label="自动化执行详情"]')?.textContent).not.toContain(
    'RunId=A',
  );
  app!.unmount();
  app = undefined;
  expect(api.cancel).not.toHaveBeenCalled();
});
