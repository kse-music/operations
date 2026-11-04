import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import TaskCenterView from './TaskCenterView.vue';
import { useBackgroundStore } from '../stores/background';
import { useAutomationStore } from '../stores/automation';
import { useFilesStore } from '../stores/files';
import { useHostsStore } from '../stores/hosts';
import { useNotificationsStore } from '../stores/notifications';
import { tasksApi } from '../services/tasks';
import { filesApi } from '../services/files';
import { automationApi } from '../services/automation';
import { hostInput } from '../types/hosts';
import type { TransferInfo } from '../types/files';

let app: App | undefined, pinia: Pinia, root: HTMLDivElement;
const navigate = vi.fn();
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const flush = async () => {
  await Promise.resolve();
  await nextTick();
};
function button(label: string, scope: ParentNode = root): HTMLButtonElement {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(result).toBeDefined();
  return result!;
}
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  navigate.mockClear();
  vi.spyOn(automationApi, 'catalog').mockResolvedValue({
    entries: [],
    groups: [],
    templates: [],
    schedules: [],
  });
  vi.spyOn(automationApi, 'history').mockResolvedValue([]);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  useHostsStore().catalog = {
    hosts: ['a', 'b'].map((id) => ({
      ...hostInput(),
      id,
      name: `Host ${id}`,
      hostname: `${id}.example`,
      createdAt: '',
      updatedAt: '',
    })),
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(TaskCenterView, { onNavigate: navigate }).use(pinia);
  app.mount(root);
});
afterEach(() => {
  app?.unmount();
  disposePinia(pinia);
  root.remove();
  vi.restoreAllMocks();
  if (originalShowModal)
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});

it('keeps shared automation stop controls available without an installed plugin and confirms each exact target', async () => {
  const catalog = vi.mocked(automationApi.catalog);
  catalog.mockResolvedValue({
    entries: [],
    groups: [],
    templates: [],
    schedules: [{ id: 'schedule', name: '每日检查', enabled: true } as never],
  });
  vi.mocked(automationApi.history).mockResolvedValue([
    { id: 'run', entryName: '检查任务', state: 'Running', targets: 2 } as never,
  ]);
  const disable = vi.spyOn(automationApi, 'scheduleDisable').mockResolvedValue();
  const cancel = vi
    .spyOn(automationApi, 'cancel')
    .mockRejectedValueOnce({ message: 'stop rejected' })
    .mockResolvedValue();
  vi.spyOn(useAutomationStore(), 'poll').mockResolvedValue();
  await flush();
  button('刷新任务与计划').click();
  await flush();
  await flush();
  button('暂停计划').click();
  await flush();
  expect(disable).not.toHaveBeenCalled();
  const scheduleDialog = document.querySelector('dialog[aria-label="确认暂停自动化计划"]')!;
  expect(scheduleDialog.textContent).toContain('每日检查');
  expect(scheduleDialog.textContent).toContain('已经提交的任务需要单独停止');
  button('确认暂停计划', scheduleDialog).click();
  await flush();
  await flush();
  expect(disable).toHaveBeenCalledExactlyOnceWith('schedule');
  await vi.waitFor(() => expect(root.textContent).toContain('请求停止自动化任务'));
  button('请求停止自动化任务').click();
  await flush();
  const runDialog = document.querySelector('dialog[aria-label="确认停止自动化任务"]')!;
  button('确认停止任务', runDialog).click();
  await flush();
  expect(runDialog.isConnected).toBe(true);
  expect(useNotificationsStore().items.some((item) => item.text === 'stop rejected')).toBe(true);
  button('确认停止任务', runDialog).click();
  await flush();
  await flush();
  expect(cancel.mock.calls).toEqual([
    ['run', true],
    ['run', true],
  ]);
  expect(document.querySelector('dialog[aria-label="确认停止自动化任务"]')).toBeNull();
  expect(navigate).not.toHaveBeenCalled();
});

it('shows loading, unavailable and empty task states without presenting an unread status as zero', async () => {
  expect(root.textContent).toContain('正在读取后台任务');
  expect(root.textContent).toContain('正在读取自动化状态');
  useBackgroundStore().error = 'load failed';
  useAutomationStore().error = 'status failed';
  await flush();
  expect(root.textContent).toContain('后台任务暂不可用');
  expect(root.textContent).toContain('自动化状态暂不可用');
  useBackgroundStore().error = '';
  useBackgroundStore().connections = [];
  await flush();
  expect(root.textContent).toContain('没有网络或批量任务');
  expect(root.textContent).toContain('没有传输任务');
});

it.each(['diagnostic', 'batch'] as const)(
  'confirms stopping only the selected %s and retains confirmation on failure',
  async (kind) => {
    const stop = vi.spyOn(tasksApi, 'stop').mockResolvedValue();
    const cancel = vi.spyOn(tasksApi, 'cancel').mockResolvedValue();
    const request = kind === 'diagnostic' ? stop : cancel;
    request.mockRejectedValueOnce({ message: 'stop failed' });
    useBackgroundStore().connections = [];
    useBackgroundStore().tasks = [
      {
        id: 'selected',
        kind,
        hostIds: ['a', 'b'],
        state: 'running',
        label: '目标任务',
        active: true,
      },
      { id: 'other', kind, hostIds: [], state: 'running', label: '其他任务', active: true },
    ];
    await flush();
    const target = [...root.querySelectorAll('article')].find((item) =>
      item.textContent?.includes('目标任务'),
    )!;
    button('请求停止此任务', target).click();
    await flush();
    const dialog = document.querySelector('dialog[aria-label="确认停止后台任务"]')!;
    expect(dialog.textContent).toContain('a.example');
    expect(dialog.textContent).toContain('b.example');
    expect(stop).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    button('确认请求停止', dialog).click();
    await flush();
    expect(document.querySelector('dialog[aria-label="确认停止后台任务"]')).not.toBeNull();
    expect(useNotificationsStore().items.some((item) => item.text === 'stop failed')).toBe(true);
    button('确认请求停止', dialog).click();
    await flush();
    expect(document.querySelector('dialog[aria-label="确认停止后台任务"]')).toBeNull();
    if (kind === 'diagnostic') {
      expect(stop.mock.calls).toEqual([['selected'], ['selected']]);
      expect(cancel).not.toHaveBeenCalled();
    } else {
      expect(cancel.mock.calls).toEqual([
        ['selected', true],
        ['selected', true],
      ]);
      expect(stop).not.toHaveBeenCalled();
    }
  },
);

it('preserves transfer cancellation and retry targets and routes task results to their original tools', async () => {
  const cancel = vi.spyOn(filesApi, 'cancel').mockResolvedValue();
  const poll = vi.spyOn(useFilesStore(), 'poll').mockResolvedValue();
  const transfer: TransferInfo = {
    id: 'upload',
    hostId: 'b',
    sessionId: 'file-session',
    direction: 'upload',
    state: 'running',
    sources: ['/source'],
    destination: '/destination',
    totalBytes: 100,
    transferredBytes: 40,
    remainingBytes: 60,
    bytesPerSecond: 10,
    filesTotal: 1,
    filesDone: 0,
    skipped: 0,
    message: null,
    recoveryPaths: [],
  };
  useFilesStore().tasks = [transfer];
  useBackgroundStore().tasks = [
    {
      id: 'diag',
      kind: 'diagnostic',
      hostIds: ['a'],
      state: 'completed',
      label: '诊断结果',
      active: false,
    },
  ];
  await flush();
  button('取消传输').click();
  await flush();
  expect(cancel).toHaveBeenCalledExactlyOnceWith('upload');
  expect(poll).toHaveBeenCalledOnce();
  useFilesStore().tasks = [{ ...transfer, state: 'failed' }];
  await flush();
  button('重试传输').click();
  expect(navigate).toHaveBeenLastCalledWith('files', 'b');
  button('查看任务结果').click();
  expect(navigate).toHaveBeenLastCalledWith('network', 'a');
  button('查看自动化历史与全部目标').click();
  expect(navigate).toHaveBeenLastCalledWith('automation', '');
  app!.unmount();
  app = undefined;
  expect(cancel).toHaveBeenCalledTimes(1);
});
