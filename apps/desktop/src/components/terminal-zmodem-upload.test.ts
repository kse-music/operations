import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { setLocale } from '@serverdeck/plugin-sdk/i18n';
import type { UploadProgress } from '../services/zmodem';
import TerminalZmodemUpload from './TerminalZmodemUpload.vue';

let app: App, root: HTMLDivElement, progress: UploadProgress;
const cancel = vi.fn();
const showModal = HTMLDialogElement.prototype.showModal;
beforeEach(() => {
  cancel.mockClear();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  progress = reactive({
    phase: 'uploading',
    files: ['中文 空格.bin', 'empty.txt'],
    name: '中文 空格.bin',
    sent: 65536,
    size: 131072,
    elapsedSeconds: 2,
    bytesPerSecond: 32768,
  });
  root = document.createElement('div');
  document.body.append(root);
});
function mount(): void {
  app = createApp({
    setup: () => () =>
      h(TerminalZmodemUpload, { target: 'Test remote', progress, onCancel: cancel }),
  });
  app.mount(root);
}
afterEach(() => {
  app.unmount();
  root.remove();
  HTMLDialogElement.prototype.showModal = showModal;
  setLocale('zh-CN');
});

it('shows the target, selected files and current file statistics in a modal', async () => {
  mount();
  const dialog = document.querySelector('dialog[open]')!;
  expect(dialog.getAttribute('aria-label')).toBe('终端文件上传');
  expect(dialog.textContent).toContain('上传到 Test remote 的当前 Shell 目录');
  expect([...dialog.querySelectorAll('li')].map((item) => item.textContent)).toEqual(
    progress.files,
  );
  expect(root.querySelector('progress')).toBeNull();
  expect(dialog.querySelector('progress')?.value).toBe(65536);
  expect(dialog.querySelector('progress')?.max).toBe(131072);
  expect(dialog.querySelector('.terminal-drop-statistics')?.textContent).toContain(
    '64.0 KiB / 128.0 KiB',
  );
  expect(dialog.querySelector('[aria-label="平均上传速度"]')?.textContent).toBe('32.0 KiB/s');
  expect(dialog.textContent).toContain('剩余 64.0 KiB');
  expect(dialog.querySelector('[data-time="elapsed"]')?.textContent).toContain('已用时间：0:00:02');
  expect(dialog.querySelector('[data-time="remaining"]')?.textContent).toContain(
    '预计剩余时间：0:00:02',
  );
  setLocale('en-US');
  await nextTick();
  expect(dialog.getAttribute('aria-label')).toBe('Terminal file upload');
  expect(dialog.textContent).toContain('Elapsed: 0:00:02');
  expect(dialog.textContent).toContain('Estimated remaining: 0:00:02');
});

it('hides choosing and empty selection cleanup, then shows selected files with accurate estimates', async () => {
  const openModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
  Object.assign(progress, { phase: 'choosing', files: [], name: '', sent: 0, size: 0 });
  mount();
  await nextTick();
  expect(document.querySelector('dialog')).toBeNull();
  expect(openModal).not.toHaveBeenCalled();
  progress.phase = 'finishing';
  await nextTick();
  expect(document.querySelector('dialog')).toBeNull();
  expect(openModal).not.toHaveBeenCalled();
  Object.assign(progress, {
    phase: 'uploading',
    files: ['empty.txt'],
    name: 'empty.txt',
    bytesPerSecond: 0,
  });
  await nextTick();
  const dialog = document.querySelector('dialog')!;
  expect(openModal).toHaveBeenCalledOnce();
  expect(dialog.textContent).toContain('0 B / 0 B');
  expect(dialog.textContent).toContain('预计剩余时间：0:00:00');
  Object.assign(progress, { size: 100 });
  await nextTick();
  expect(dialog.textContent).toContain('预计剩余时间：估算中');
  Object.assign(progress, { phase: 'finishing', sent: 100 });
  await nextTick();
  expect(dialog.textContent).toContain('等待远端确认完成');
  expect(dialog.querySelector('[aria-label="平均上传速度"]')).toBeNull();
  expect(dialog.textContent).toContain('预计剩余时间：—');
  expect(dialog.querySelector('progress')?.hasAttribute('value')).toBe(false);
});

it.each(['button', 'close', 'escape'])(
  'cancels once via %s and waits for upload cleanup',
  async (action) => {
    mount();
    const dialog = document.querySelector('dialog')!;
    if (action === 'escape') dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    else if (action === 'close') dialog.querySelector<HTMLButtonElement>('.icon-button')!.click();
    else dialog.querySelector<HTMLButtonElement>('footer button')!.click();
    await nextTick();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(document.querySelector('dialog')).toBe(dialog);
    expect(dialog.textContent).toContain('正在结束上传');
    expect(dialog.querySelector('[aria-label="平均上传速度"]')).toBeNull();
    expect(dialog.textContent).toContain('预计剩余时间：—');
    expect([...dialog.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);
