import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type App } from 'vue';
import FilePane from './FilePane.vue';
import type { DirectoryListing, FileEntry } from '../types/files';
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
function mountPane(
  side: 'local' | 'remote',
  directory: DirectoryListing | null = listing,
  loading = false,
  selected: string[] = [],
) {
  const select = vi.fn();
  const open = vi.fn();
  const remove = vi.fn();
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(FilePane, {
    side,
    listing: directory,
    loading,
    selected,
    onSelect: select,
    onOpen: open,
    onRemove: remove,
  });
  app.mount(root);
  return { select, open, remove };
}

it.each(['local', 'remote'] as const)(
  'requests deletion from the focused %s list and focuses clicked rows',
  (side) => {
    const { remove } = mountPane(side, listing, false, ['/srv/app']);
    const row = root.querySelector<HTMLTableRowElement>('tbody tr')!;
    row.children[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.activeElement).toBe(row.querySelector('.file-name'));
    const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(remove).toHaveBeenCalledOnce();
  },
);

it.each(['local', 'remote'] as const)(
  'ignores Delete modifiers, composition and repeat in the %s list',
  (side) => {
    const { remove } = mountPane(side, listing, false, ['/srv/app']);
    const name = root.querySelector('.file-name')!;
    for (const flag of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'isComposing', 'repeat']) {
      name.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, [flag]: true }),
      );
    }
    expect(remove).not.toHaveBeenCalled();
  },
);

it.each([
  { loading: false, selected: [] },
  { loading: true, selected: ['/srv/app'] },
])('ignores Delete with loading=$loading and selection=$selected', ({ loading, selected }) => {
  const { remove } = mountPane('local', listing, loading, selected);
  root
    .querySelector('.file-table')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  expect(remove).not.toHaveBeenCalled();
});

it.each(['local', 'remote'] as const)(
  'keeps the %s table header above a loading indicator without showing stale entries',
  (side) => {
    mountPane(side, listing, true);
    const table = root.querySelector('table')!;
    expect(table).not.toBeNull();
    expect(table.querySelector('thead')).not.toBeNull();
    expect(table.querySelectorAll('tbody tr')).toHaveLength(0);
    expect(table.querySelector<HTMLInputElement>('thead input')!.disabled).toBe(true);
    const status = root.querySelector('[role="status"]')!;
    expect(status.textContent).toContain('正在读取目录');
    expect(status.classList.contains('file-list-loading')).toBe(true);
    expect(root.querySelector('.file-table')?.getAttribute('aria-busy')).toBe('true');
    expect(root.textContent).not.toContain('空目录');
  },
);

it('shows the table header and loading indicator while reading the first directory', () => {
  mountPane('remote', null, true);
  expect(root.querySelector('thead')).not.toBeNull();
  expect(root.querySelector('[role="status"]')?.textContent).toContain('正在读取目录');
  expect(root.textContent).not.toContain('尚未读取目录');
});

it.each(['remote', 'local'] as const)(
  'renders symbolic permissions and server owner names only in the remote pane (%s)',
  (side) => {
    const { select, open } = mountPane(side);
    const headers = [...root.querySelectorAll('th')].map((th) => th.textContent?.trim());
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

it.each(['local', 'remote'] as const)(
  'shows file-kind icons beside the names in the %s pane',
  (side) => {
    const cases = [
      ['directory', 'images.png', 'folder'],
      ['symlink', 'deploy.sh', 'file-symlink'],
      ['other', 'pipe.zip', 'file-question-mark'],
      ['file', 'deploy.PS1', 'file-terminal'],
      ['file', '.hidden.sh', 'file-terminal'],
      ['file', 'backup.tar.GZ', 'file-archive'],
      ['file', 'preview.JPEG', 'file-image'],
      ['file', 'README.md', 'file'],
      ['file', 'zip', 'file'],
      ['file', '.png', 'file'],
    ] as const;
    const entries: FileEntry[] = cases.map(([kind, name]) => ({
      ...listing.entries[0]!,
      kind,
      name,
      path: `/srv/${name}`,
    }));
    const { select, open } = mountPane(side, { ...listing, entries });
    for (const [kind, name, glyph] of cases) {
      const button = root.querySelector<HTMLButtonElement>(`.file-name[title="${name}"]`)!;
      expect(button.textContent?.trim()).toBe(name);
      const icon = button.querySelector('svg[aria-hidden="true"]')!;
      expect(icon.classList.contains(`lucide-${glyph}`)).toBe(true);
      if (kind === 'directory') {
        icon.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        icon.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      }
    }
    expect(select).toHaveBeenCalledExactlyOnceWith(['/srv/images.png']);
    expect(open).toHaveBeenCalledExactlyOnceWith(entries[0]);
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
