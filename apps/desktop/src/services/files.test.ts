import { describe, it, expect } from 'vitest';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { filesApi } from './files';
import { osc7Path } from './osc7';
import { remoteDirectoryLocations, remoteJoin } from '../types/files';
describe('trusted file navigation contracts', () => {
  it('creates an editor document on the original lease with an explicit create flag', async () => {
    Reflect.set(window, 'isTauri', true);
    const document = {
      token: 'new-token',
      sessionId: 'original-session',
      path: '/srv/中文 ;$file.txt',
    };
    mockIPC((command, args) => {
      expect(command).toBe('editor_open');
      expect(args).toEqual({
        id: 'original-session',
        path: document.path,
        connectionCaption: 'ops@server',
        create: true,
      });
      return document;
    });
    try {
      expect(await filesApi.createEditor('original-session', document.path, 'ops@server')).toEqual(
        document,
      );
    } finally {
      clearMocks();
      Reflect.deleteProperty(window, 'isTauri');
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });
  it('binds both remote copy endpoints and the exact confirmed target over IPC', async () => {
    Reflect.set(window, 'isTauri', true);
    const input = {
      sessionId: 'original-session',
      targetSessionId: 'target-session',
      sources: ['/work/中文;$(id).txt'],
      destination: '/target',
      name: 'new.txt',
      conflict: 'overwrite' as const,
      confirmed: true,
      confirmOverwrite: true,
    };
    const result = {
      id: 'remote-job',
      remoteCopy: true,
      remoteName: 'new.txt',
      remoteTargetHostId: 'target-host',
      remoteTargetSessionId: 'target-session',
    };
    mockIPC((command, args) => {
      expect(command).toBe('files_remote_copy');
      expect(args).toEqual({ input });
      return result;
    });
    try {
      expect(await filesApi.remoteCopy(input)).toEqual(result);
    } finally {
      clearMocks();
      Reflect.deleteProperty(window, 'isTauri');
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });
  it('binds search start and cancellation to the same Files lease and request', async () => {
    Reflect.set(window, 'isTauri', true);
    const input = {
      requestId: crypto.randomUUID(),
      path: '/srv',
      query: '中文;$(id)',
      recursive: true,
      includeHidden: false,
    };
    const commands: string[] = [];
    mockIPC((command, args) => {
      commands.push(command);
      expect(args).toHaveProperty('id', 'file-lease');
      if (command === 'files_search_start') {
        expect(args).toHaveProperty('input', input);
        expect(args).toHaveProperty('events');
      } else {
        expect(command).toBe('files_search_cancel');
        expect(args).toHaveProperty('requestId', input.requestId);
      }
    });
    try {
      await filesApi.search('file-lease', input, () => {});
      await filesApi.cancelSearch('file-lease', input.requestId);
      expect(commands).toEqual(['files_search_start', 'files_search_cancel']);
    } finally {
      clearMocks();
      Reflect.deleteProperty(window, 'isTauri');
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });
  it('keeps native properties and remote property operations bound to their original paths and request IDs', async () => {
    Reflect.set(window, 'isTauri', true);
    const input = {
      requestId: crypto.randomUUID(),
      path: '/work/中文 file',
      operation: { kind: 'size' as const },
    };
    const localPath = '\\\\?\\C:\\中文 file';
    const result = {
      bytes: 5,
      files: 1,
      directories: 0,
      skippedLinks: 0,
      changed: 0,
      checksum: null,
      cancelled: false,
      message: null,
    };
    const commands: string[] = [];
    mockIPC((command, args) => {
      commands.push(command);
      if (command === 'files_local_properties') expect(args).toEqual({ path: localPath });
      else if (command === 'files_property_operation') {
        expect(args).toEqual({ id: 'original-lease', input });
        return result;
      } else {
        expect(command).toBe('files_property_cancel');
        expect(args).toEqual({ id: 'original-lease', requestId: input.requestId });
      }
    });
    try {
      await filesApi.localProperties(localPath);
      expect(await filesApi.propertyOperation('original-lease', input)).toEqual(result);
      await filesApi.propertyCancel('original-lease', input.requestId);
      expect(commands).toEqual([
        'files_local_properties',
        'files_property_operation',
        'files_property_cancel',
      ]);
    } finally {
      clearMocks();
      Reflect.deleteProperty(window, 'isTauri');
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });
  it('binds a local rename to its parent, source and new leaf name over IPC', async () => {
    Reflect.set(window, 'isTauri', true);
    const input = { parent: 'D:/test', path: 'D:/test/config.json', name: '配置.json' };
    mockIPC((command, args) => {
      expect(command).toBe('files_local_rename');
      expect(args).toEqual({ input });
      return 'D:/test/配置.json';
    });
    try {
      expect(await filesApi.localRename(input)).toBe('D:/test/配置.json');
    } finally {
      clearMocks();
      Reflect.deleteProperty(window, 'isTauri');
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });
  it('binds recycling to the exact confirmed local parent and paths over IPC', async () => {
    Reflect.set(window, 'isTauri', true);
    const input = { parent: 'D:/test', paths: ['D:/test/中文 空格.txt'], confirmed: true };
    let invoked = false;
    mockIPC((command, args) => {
      expect(command).toBe('files_local_recycle');
      expect(args).toEqual({ input });
      invoked = true;
    });
    try {
      await filesApi.localRecycle(input);
      expect(invoked).toBe(true);
    } finally {
      clearMocks();
      Reflect.deleteProperty(window, 'isTauri');
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });
  it('derives the root-to-current folder chain without changing special file names', () => {
    expect(remoteDirectoryLocations('/home/dh')).toEqual([
      { path: '/', name: '/ <root>', depth: 0 },
      { path: '/home', name: 'home', depth: 1 },
      { path: '/home/dh', name: 'dh', depth: 2 },
    ]);
    expect(remoteDirectoryLocations('/')).toEqual([{ path: '/', name: '/ <root>', depth: 0 }]);
    expect(remoteDirectoryLocations('/home//中文 空格/a\\b/')).toEqual([
      { path: '/', name: '/ <root>', depth: 0 },
      { path: '/home', name: 'home', depth: 1 },
      { path: '/home/中文 空格', name: '中文 空格', depth: 2 },
      { path: '/home/中文 空格/a\\b', name: 'a\\b', depth: 3 },
    ]);
    for (const path of ['', '.', '../tmp', '/srv/../tmp', '/srv/./tmp'])
      expect(remoteDirectoryLocations(path)).toEqual([]);
  });
  it('accepts only explicit OSC 7 file URIs and decodes Unicode/space without reading shell text', () => {
    expect(osc7Path('file://linux-host/home/user/%E4%B8%AD%E6%96%87%20path')).toBe(
      '/home/user/中文 path',
    );
    for (const value of [
      'user@host:/tmp$ pwd',
      'https://host/etc',
      'file://host/tmp?run=bad',
      'file://host/tmp%00bad',
      'file://host/tmp\nother',
      'file://user:pw@host/tmp',
    ])
      expect(osc7Path(value)).toBeNull();
  });
  it('preserves shell metacharacters as names while rejecting traversal components', () => {
    expect(remoteJoin('/tmp', "中文 ;$'file.txt")).toBe("/tmp/中文 ;$'file.txt");
    expect(() => remoteJoin('/tmp', '../outside')).toThrow();
    expect(() => remoteJoin('/tmp', 'bad\0path')).toThrow();
  });
});
