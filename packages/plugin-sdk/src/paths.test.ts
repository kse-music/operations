import { expect, it } from 'vitest';
import { displayLocalPath } from './paths';

it.each([
  ['\\\\?\\C:\\Users\\DH\\.sts4', 'C:\\Users\\DH\\.sts4'],
  ['\\\\?\\d:\\资料\\', 'd:\\资料\\'],
  ['\\\\?\\UNC\\server\\share\\资料', '\\\\server\\share\\资料'],
  ['\\\\?\\unc\\server\\share', '\\\\server\\share'],
  ['C:\\Users\\DH', 'C:\\Users\\DH'],
  ['\\\\server\\share', '\\\\server\\share'],
  ['/home/ops/\\\\?\\C:\\file', '/home/ops/\\\\?\\C:\\file'],
  ['\\\\?\\Volume{example}\\资料', '\\\\?\\Volume{example}\\资料'],
  ['\\\\.\\pipe\\service', '\\\\.\\pipe\\service'],
  ['\\\\?\\UNC\\server', '\\\\?\\UNC\\server'],
  ['', ''],
])('displays %s as %s without changing other namespaces', (path, expected) => {
  expect(displayLocalPath(path)).toBe(expected);
});
