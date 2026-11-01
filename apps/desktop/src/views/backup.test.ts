import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
const mock = vi.hoisted(() => ({ preview: vi.fn(), restore: vi.fn(), export: vi.fn() }));
vi.mock('../services/product', () => ({ productApi: mock }));
import BackupView from './BackupView.vue';
import { useHostsStore } from '../stores/hosts';
let app: App, pinia: Pinia, root: HTMLDivElement;
const flush = async () => {
  for (let n = 0; n < 10; n++) await Promise.resolve();
  await nextTick();
};
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(BackupView).use(pinia);
  app.mount(root);
  vi.spyOn(useHostsStore(), 'load').mockResolvedValue();
});
afterEach(() => {
  app.unmount();
  disposePinia(pinia);
  root.remove();
  vi.resetAllMocks();
});
async function input(selector: string, value: string) {
  const e = root.querySelector<HTMLTextAreaElement>(selector)!;
  e.value = value;
  e.dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}
async function click(name: string) {
  const button = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
  expect(button, name).toBeDefined();
  button.click();
  await flush();
}
it('validates before restoring, excludes duplicate/blocked defaults, and invalidates approval when source changes', async () => {
  mock.preview.mockResolvedValue({
    version: 1,
    warnings: [],
    items: [
      {
        id: 'a',
        kind: 'host',
        name: 'new',
        detail: 'test@localhost',
        duplicate: false,
        blocked: false,
        warnings: [],
      },
      {
        id: 'b',
        kind: 'host',
        name: 'old',
        detail: 'test@localhost',
        duplicate: true,
        blocked: false,
        warnings: [],
      },
      {
        id: 'c',
        kind: 'host',
        name: 'proxy',
        detail: 'test@localhost',
        duplicate: false,
        blocked: true,
        warnings: ['needs credentials'],
      },
    ],
  });
  await input('[aria-label="待恢复备份 JSON"]', '{"version":1}');
  await click('校验并预览备份');
  expect(mock.restore).not.toHaveBeenCalled();
  expect(root.querySelector<HTMLInputElement>('[aria-label="恢复 new"]')!.checked).toBe(true);
  expect(root.querySelector<HTMLInputElement>('[aria-label="恢复 old"]')!.checked).toBe(false);
  expect(root.querySelector<HTMLInputElement>('[aria-label="恢复 proxy"]')!.disabled).toBe(true);
  const confirmation = root.querySelector<HTMLInputElement>('[aria-label="确认备份恢复"]')!;
  confirmation.checked = true;
  confirmation.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  await input('[aria-label="待恢复备份 JSON"]', '{"version":2}');
  expect(root.querySelector('[aria-label="备份恢复预览"]')).toBeNull();
  expect(mock.restore).not.toHaveBeenCalled();
});
it('uses the exact selected preview source, explicit conflict policy and confirmation, then reloads real catalog', async () => {
  mock.preview.mockResolvedValue({
    version: 1,
    warnings: [],
    items: [
      {
        id: 'a',
        kind: 'entry',
        name: 'script',
        detail: 'script',
        duplicate: false,
        blocked: false,
        warnings: [],
      },
    ],
  });
  mock.restore.mockResolvedValue({
    hosts: 0,
    entries: 1,
    skipped: 0,
    preferencesRestored: false,
    warnings: ['no execution'],
  });
  await input('[aria-label="待恢复备份 JSON"]', 'source-v1');
  await click('校验并预览备份');
  const confirmation = root.querySelector<HTMLInputElement>('[aria-label="确认备份恢复"]')!;
  confirmation.checked = true;
  confirmation.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
  await click('确认恢复所选配置');
  expect(mock.restore).toHaveBeenCalledWith({
    text: 'source-v1',
    selected: ['a'],
    conflict: 'skip',
    restorePreferences: false,
    confirmed: true,
  });
  expect(useHostsStore().load).toHaveBeenCalledOnce();
  expect(root.textContent).toContain('恢复完成');
});
