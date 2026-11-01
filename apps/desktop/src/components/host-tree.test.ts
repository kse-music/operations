import { it, expect, afterEach } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia, setActivePinia, disposePinia, type Pinia } from 'pinia';
import HostSidebar from './HostSidebar.vue';
import { useHostsStore } from '../stores/hosts';
import { hostInput } from '../types/hosts';
let app: App, pinia: Pinia, root: HTMLDivElement;
afterEach(() => {
  app?.unmount();
  if (pinia) disposePinia(pinia);
  root?.remove();
});
it('bounds initial host DOM, exposes further rows, and supports arrow/Home/End keyboard focus', async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  const hosts = useHostsStore();
  hosts.catalog = {
    hosts: Array.from({ length: 450 }, (_, n) => ({
      ...hostInput(),
      id: `host-${n}`,
      name: `Host ${String(n).padStart(3, '0')}`,
      hostname: `host-${n}.example`,
      createdAt: '',
      updatedAt: '',
    })),
    groups: [],
    credentials: [],
    pendingSecretDeletions: 0,
  };
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(HostSidebar).use(pinia);
  app.mount(root);
  await nextTick();
  let rows = root.querySelectorAll<HTMLButtonElement>('.tree-host');
  expect(rows).toHaveLength(200);
  rows[0]!.focus();
  rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement).toBe(rows[1]);
  rows[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  expect(document.activeElement).toBe(rows[199]);
  rows[199]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  expect(document.activeElement).toBe(rows[0]);
  const more = [...root.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('显示更多主机'),
  )!;
  more.click();
  await nextTick();
  rows = root.querySelectorAll('.tree-host');
  expect(rows).toHaveLength(400);
  hosts.search = 'Host 449';
  await nextTick();
  expect(root.querySelectorAll('.tree-host')).toHaveLength(1);
  expect(root.textContent).toContain('Host 449');
});
