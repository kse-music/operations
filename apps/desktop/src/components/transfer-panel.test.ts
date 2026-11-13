import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, ref, type App } from 'vue';
import { createPinia, disposePinia, type Pinia } from 'pinia';
import TransferPanel from './TransferPanel.vue';
import { useFilesStore } from '../stores/files';
import type { TransferInfo } from '../types/files';
import { setLocale } from '@serverdeck/plugin-sdk/i18n';

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
  elapsedSeconds: 4,
  dragExport: false,
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
  setLocale('zh-CN');
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
it('removes per-task cancellation and keeps retry bound to its original transfer and host', async () => {
  const transfer = task('a-task', 'a', 'running');
  useFilesStore(pinia).tasks = [transfer];
  await nextTick();
  expect(root.querySelector('button')).toBeNull();
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
    const paths = root.querySelectorAll<HTMLElement>('.transfer-path');
    expect(paths[0]!.textContent?.trim()).toBe(sources);
    expect(paths[0]!.title).toBe(sources);
    expect(paths[1]!.textContent?.trim()).toBe(destination);
    expect(paths[1]!.title).toBe(destination);
    root.querySelector<HTMLButtonElement>('.transfer-row button')!.click();
    expect(retry).toHaveBeenCalledExactlyOnceWith(transfer);
    expect(transfer.sources).toEqual([direction === 'upload' ? local : remote]);
    expect(transfer.destination).toBe(direction === 'download' ? local : remote);
  },
);

const elapsed = () => root.querySelector('[data-time="elapsed"]')?.textContent?.trim();
const remainingTime = () => root.querySelector('[data-time="remaining"]')?.textContent?.trim();
it('updates elapsed time and estimates from task snapshots across host switches', async () => {
  const files = useFilesStore(pinia);
  files.tasks = [
    { ...task('a-task', 'a', 'running'), elapsedSeconds: 14, remainingBytes: 725 },
    { ...task('b-task', 'b', 'running'), elapsedSeconds: 3661 },
  ];
  await nextTick();
  expect(elapsed()).toBe('0:00:14');
  expect(remainingTime()).toBe('0:01:13');
  chosen.value = 'b';
  await nextTick();
  expect(elapsed()).toBe('1:01:01');
  files.tasks[0] = {
    ...files.tasks[0]!,
    elapsedSeconds: 75,
    remainingBytes: 600,
    bytesPerSecond: 20,
  };
  chosen.value = 'a';
  await nextTick();
  expect(elapsed()).toBe('0:01:15');
  expect(remainingTime()).toBe('0:00:30');
  setLocale('en-US');
  await nextTick();
  expect(root.querySelector('.transfer-details')?.textContent).toContain('Elapsed');
  expect(root.querySelector('.transfer-details')?.textContent).toContain('Estimated remaining');
  expect(elapsed()).toBe('0:01:15');
  expect(remainingTime()).toBe('0:00:30');
});

it.each([
  ['queued', 0, 60, '估算中'],
  ['scanning', 0, 60, '估算中'],
  ['running', 0, 60, '估算中'],
  ['running', 10, 0, '校验中'],
  ['verifying', 10, 60, '校验中'],
  ['cancelling', 10, 60, '—'],
  ['completed', 10, 0, '0:00:00'],
  ['failed', 10, 60, '—'],
  ['cancelled', 10, 60, '—'],
] as const)(
  'shows an honest remaining time for %s at %s B/s',
  async (state, speed, remaining, text) => {
    useFilesStore(pinia).tasks = [
      {
        ...task('a-task', 'a', state),
        bytesPerSecond: speed,
        remainingBytes: remaining,
        elapsedSeconds: 90061,
      },
    ];
    history.value = ['completed', 'failed', 'cancelled'].includes(state);
    await nextTick();
    const times = root.querySelector('.transfer-details');
    expect(elapsed()).toBe('25:01:01');
    expect(remainingTime()).toBe(text);
    expect(times?.querySelector('[title]')?.getAttribute('title')).toContain('不含校验和提交耗时');
  },
);
