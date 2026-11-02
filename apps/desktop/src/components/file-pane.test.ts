import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import FilePane from './FilePane.vue';
import type { DirectoryListing } from '../types/files';
import { permissionText } from '../types/files';

let app: App, root: HTMLDivElement;
afterEach(() => {
  app?.unmount();
  root?.remove();
});
const listing: DirectoryListing = {
  path: '/srv',
  parent: '/',
  entries: [
    { name: 'app', permissions: 0o100644, uid: 0, owner: 'root' },
    { name: 'executable', permissions: 0o4755, uid: 1000, owner: 'deploy' },
    { name: 'restricted', permissions: 0, uid: 1001 },
    { name: 'unknown', permissions: null, uid: null },
    { name: 'z-root-id-only', permissions: 0o755, uid: 0, owner: null },
  ].map((entry) => ({
    ...entry,
    path: `/srv/${entry.name}`,
    kind: 'file',
    size: 0,
    modified: null,
    gid: null,
  })),
};
it.each(['remote', 'local'] as const)(
  'renders symbolic permissions and server owner names only in the remote pane (%s)',
  (side) => {
    const select = vi.fn(),
      open = vi.fn();
    root = document.createElement('div');
    document.body.append(root);
    app = createApp(FilePane, {
      side,
      listing,
      loading: false,
      selected: [],
      onSelect: select,
      onOpen: open,
    });
    app.mount(root);
    const headers = [...root.querySelectorAll('th')].map((th) => th.textContent);
    expect(headers.includes('权限')).toBe(side === 'remote');
    expect(headers.includes('拥有者')).toBe(side === 'remote');
    const rows = [...root.querySelectorAll('tbody tr')];
    expect(rows.map((row) => row.children.length)).toEqual(
      Array(5).fill(side === 'remote' ? 7 : 5),
    );
    if (side === 'remote') {
      expect(rows.map((row) => row.children[5]!.textContent?.trim())).toEqual([
        'rw-r--r--',
        'rwsr-xr-x',
        '---------',
        '—',
        'rwxr-xr-x',
      ]);
      expect(rows.map((row) => row.children[6]!.textContent)).toEqual([
        'root',
        'deploy',
        '1001',
        '—',
        '0',
      ]);
    }
    rows[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(select).toHaveBeenCalledWith(['/srv/app']);
    rows[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(open).toHaveBeenCalledWith(listing.entries[0]);
  },
);

it.each([
  [0o755, 'rwxr-xr-x'],
  [0o644, 'rw-r--r--'],
  [0o4644, 'rwSr--r--'],
  [0o2750, 'rwxr-s---'],
  [0o1777, 'rwxrwxrwt'],
  [0o1000, '--------T'],
  [0, '---------'],
  [null, '—'],
])('formats permission %s as %s', (mode, text) => {
  expect(permissionText(mode as number | null)).toBe(text);
});
