import { expect, it } from 'vitest';
import { actionPayload, safeValues, uiResult } from './plugin-ui';
import type { PluginUiPage } from '../types/plugins';
const page: PluginUiPage = {
  id: 'test',
  title: 'Test',
  initialAction: 'read',
  fields: [],
  actions: [{ id: 'save', label: 'Save', discardDirty: false, enabledWhen: null }],
  log: null,
};
it('accepts only declared actions and bounded primitive state', () => {
  expect(
    actionPayload(page, 'read', { content: '<script>alert(1)</script>', dirty: true }),
  ).toEqual({ action: 'read', values: { content: '<script>alert(1)</script>', dirty: true } });
  expect(() => actionPayload(page, 'plugin:shell|execute', {})).toThrow();
  expect(() => safeValues(JSON.parse('{"__proto__":"bad"}'))).toThrow();
  expect(() => safeValues({ session: { id: 'internal' } })).toThrow();
  expect(() => actionPayload(page, 'save', { a: '中'.repeat(32768) })).toThrow();
});
it('rejects native command messages, URLs, invalid states and prototype mutations', () => {
  for (const result of [
    { values: {}, invoke: 'credential_read' },
    { output: 'x', url: 'https://bad.example' },
    { values: { constructor: 'bad' } },
    { saved: 'yes' },
  ])
    expect(() => uiResult(result)).toThrow();
  expect(
    uiResult({ values: { documentId: 'opaque' }, output: 'real output', saved: false }),
  ).toEqual({ values: { documentId: 'opaque' }, output: 'real output', saved: false });
});
