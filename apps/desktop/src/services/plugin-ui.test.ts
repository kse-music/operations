import { expect, it } from 'vitest';
import { actionPayload, safeValues, safeInput } from './plugin-ui';
import type { PluginUiPage } from '../types/plugins';
const page: PluginUiPage = {
  surface: { kind: 'frontend' },
  id: 'test',
  title: 'Test',
  initialAction: null,
  fields: [],
  actions: ['read', 'save'].map((id) => ({
    id,
    label: id,
    discardDirty: false,
    enabledWhen: null,
  })),
  log: null,
};
it('accepts only declared actions and bounded primitive state', () => {
  expect(
    actionPayload(page, 'read', { content: '<script>alert(1)</script>', dirty: true }),
  ).toEqual({ action: 'read', input: { content: '<script>alert(1)</script>', dirty: true } });
  expect(() => actionPayload(page, 'plugin:shell|execute', {})).toThrow();
  expect(() => safeValues(JSON.parse('{"__proto__":"bad"}'))).toThrow();
  expect(() => safeValues({ session: { id: 'internal' } })).toThrow();
  expect(() => actionPayload(page, 'save', { a: '中'.repeat(32768) })).toThrow();
});
it('does not accept an undeclared action through an initialization field', () => {
  expect(() =>
    actionPayload({ ...page, initialAction: 'credential_read' }, 'credential_read', {}),
  ).toThrow();
});

it('accepts nested business JSON but rejects prototype keys non-finite numbers and unbounded recursion', () => {
  expect(safeInput({ target: { kind: 'container', id: 'literal' }, count: 2 })).toEqual({
    target: { kind: 'container', id: 'literal' },
    count: 2,
  });
  expect(() => safeInput(JSON.parse('{"target":{"__proto__":true}}'))).toThrow();
  expect(() => safeInput({ value: Infinity })).toThrow();
  let nested: unknown = null;
  for (let i = 0; i < 18; i++) nested = { nested };
  expect(() => safeInput(nested)).toThrow();
});
