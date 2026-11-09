import type { PluginUiPage, PluginValues } from '../types/plugins';
import type { JsonValue } from '@serverdeck/plugin-sdk/types/platform';

export function safeInput(value: unknown): JsonValue {
  let nodes = 0;
  function visit(value: unknown, depth: number): JsonValue {
    if (++nodes > 4096 || depth > 16) throw new Error('插件动作输入层级或数量超过限制');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (
      value &&
      typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ) {
      const entries = Object.entries(value);
      if (
        entries.some(
          ([key]) => key.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(key),
        )
      )
        throw new Error('插件动作字段无效');
      return Object.fromEntries(entries.map(([key, value]) => [key, visit(value, depth + 1)]));
    }
    throw new Error('插件动作仅接受 JSON 数据');
  }
  const result = visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > 60 * 1024)
    throw new Error('插件动作输入超过 60 KiB');
  return result;
}

const identifier = (key: string) =>
  /^[a-zA-Z0-9_-]{1,64}$/.test(key) && !['__proto__', 'prototype', 'constructor'].includes(key);
export function safeValues(value: unknown): PluginValues {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('插件表单状态无效');
  const entries = Object.entries(value);
  if (
    entries.length > 64 ||
    entries.some(
      ([key, v]) =>
        !identifier(key) ||
        !(v === null || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 32768)),
    )
  )
    throw new Error('插件表单字段超限或包含不支持的类型');
  return Object.fromEntries(entries) as PluginValues;
}
export function actionPayload(
  page: PluginUiPage,
  action: string,
  input: unknown,
): { action: string; input: JsonValue } {
  if (!identifier(action) || !page.actions.some((a) => a.id === action))
    throw new Error('插件界面动作未在页面声明');
  const payload = { action, input: safeInput(input) };
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 60 * 1024)
    throw new Error('插件表单超过消息大小限制');
  return payload;
}
