import { afterEach, expect, it, vi } from 'vitest';
import { createApp, h, ref, type App } from 'vue';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import GroupManager from './GroupManager.vue';
import { useHostsStore } from '../stores/hosts';
import { useNotificationsStore } from '../stores/notifications';
import { hostsApi } from '../services/hosts';

let app: App, pinia: Pinia, root: HTMLDivElement;
const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
afterEach(() => {
  app?.unmount();
  disposePinia(pinia);
  root?.remove();
  if (original) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', original);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});
it.each([true, false])(
  'closes a created group dialog only after successful save (%s)',
  async (success) => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    });
    pinia = createPinia();
    setActivePinia(pinia);
    useHostsStore().catalog = { hosts: [], groups: [], credentials: [], pendingSecretDeletions: 0 };
    const group = { id: 'group', name: 'Production', sortOrder: 0 };
    const save = vi.spyOn(hostsApi, 'groupSave');
    if (success) save.mockResolvedValue(group);
    else save.mockRejectedValue({ message: 'save failed' });
    vi.spyOn(hostsApi, 'list').mockResolvedValue({ ...useHostsStore().catalog!, groups: [group] });
    const visible = ref(true);
    root = document.createElement('div');
    document.body.append(root);
    app = createApp({
      setup: () => () =>
        visible.value ? h(GroupManager, { onClose: () => (visible.value = false) }) : null,
    }).use(pinia);
    app.mount(root);
    const dialog = document.querySelector('dialog')!;
    const name = dialog.querySelector('input')!;
    name.value = 'Production';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    dialog
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(useHostsStore().busy).toBe(false));
    expect(save).toHaveBeenCalledWith(null, { name: 'Production', sortOrder: 0 });
    expect(document.querySelector('dialog') === null).toBe(success);
    if (!success) {
      expect(useNotificationsStore().items).toContainEqual(
        expect.objectContaining({ text: 'save failed', error: true }),
      );
      expect(document.querySelector('dialog')?.textContent).not.toContain('save failed');
      expect(name.value).toBe('Production');
    }
  },
);
