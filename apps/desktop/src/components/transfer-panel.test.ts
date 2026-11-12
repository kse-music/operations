import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, ref, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import TransferPanel from './TransferPanel.vue';
import { useFilesStore } from '../stores/files';
import { filesApi } from '../services/files';
import type { TransferInfo } from '../types/files';

let app: App, pinia: Pinia, root: HTMLDivElement;
const chosen = ref('a'),
  history = ref(false),
  retry = vi.fn();
const task = (id: string, hostId: string, state: string): TransferInfo => ({
  id,
  hostId,
  state,
  sessionId: `session-${hostId}`,
  direction: 'upload',
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
});
beforeEach(() => {
  pinia = createPinia();
  chosen.value = 'a';
  history.value = false;
  retry.mockClear();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp({
    components: { TransferPanel },
    setup: () => ({ chosen, history, retry }),
    template: '<TransferPanel :host-id="chosen" :history="history" @retry="retry" />',
  }).use(pinia);
  app.mount(root);
});
afterEach(() => {
  app.unmount();
  disposePinia(pinia);
  root.remove();
  vi.restoreAllMocks();
});
it('shows active transfers for the chosen host and keeps finished records in history', async () => {
  const files = useFilesStore(pinia);
  files.tasks = [task('a-ended', 'a', 'completed'), task('b-running', 'b', 'running')];
  await nextTick();
  expect(root.querySelector('.transfer-panel')).toBeNull();
  chosen.value = 'b';
  await nextTick();
  expect(root.textContent).toContain('1 个未完成');
  expect(root.querySelector('[data-task-id="b-running"]')?.textContent).toContain('/source');
  expect(root.querySelector('[data-task-id="a-ended"]')).toBeNull();
  chosen.value = 'a';
  history.value = true;
  await nextTick();
  expect(root.querySelector('[data-task-id="a-ended"]')).not.toBeNull();
  files.tasks = files.tasks.filter((t) => t.hostId !== 'a');
  await nextTick();
  expect(root.querySelector('.transfer-panel')).toBeNull();
});
it('keeps cancellation and retry bound to their original transfer and host', async () => {
  const cancel = vi.spyOn(filesApi, 'cancel').mockResolvedValue();
  const poll = vi.spyOn(useFilesStore(pinia), 'poll').mockResolvedValue();
  const transfer = task('a-task', 'a', 'running');
  useFilesStore(pinia).tasks = [transfer];
  await nextTick();
  root.querySelector<HTMLButtonElement>('button')!.click();
  await Promise.resolve();
  await nextTick();
  expect(cancel).toHaveBeenCalledExactlyOnceWith('a-task');
  expect(poll).toHaveBeenCalledOnce();
  useFilesStore(pinia).tasks = [{ ...transfer, state: 'failed' }];
  await nextTick();
  expect(root.querySelector('.transfer-panel')).toBeNull();
  history.value = true;
  await nextTick();
  root.querySelector<HTMLButtonElement>('button')!.click();
  expect(retry).toHaveBeenCalledWith(expect.objectContaining({ id: 'a-task', hostId: 'a' }));
});

it.each(['upload', 'download'] as const)(
  'formats local %s paths in the transfer record and tooltip without changing the retry data',
  async (direction) => {
    const local = '\\\\?\\UNC\\server\\share\\资料';
    const remote = '/srv/\\\\?\\C:\\archive';
    const transfer = {
      ...task('copy', 'a', 'failed'),
      direction,
      sources: [direction === 'upload' ? local : remote],
      destination: direction === 'download' ? local : remote,
    };
    useFilesStore(pinia).tasks = [transfer];
    history.value = true;
    await nextTick();
    const sources = direction === 'upload' ? '\\\\server\\share\\资料' : remote;
    const destination = direction === 'download' ? '\\\\server\\share\\资料' : remote;
    const path = root.querySelector<HTMLElement>('.transfer-path')!;
    expect(path.textContent?.trim()).toBe(`${sources} → ${destination}`);
    expect(path.title).toBe(`${sources}\n→ ${destination}`);
    root.querySelector<HTMLButtonElement>('.transfer-row button')!.click();
    expect(retry).toHaveBeenCalledExactlyOnceWith(transfer);
    expect(transfer.sources).toEqual([direction === 'upload' ? local : remote]);
    expect(transfer.destination).toBe(direction === 'download' ? local : remote);
  },
);
