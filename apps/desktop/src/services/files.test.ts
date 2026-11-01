import { describe, it, expect } from 'vitest';
import { osc7Path } from './osc7';
import { remoteJoin } from '../types/files';
describe('trusted file navigation contracts', () => {
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
