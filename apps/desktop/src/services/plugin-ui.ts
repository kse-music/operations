import type { PluginUiPage, PluginValues } from '../types/plugins';

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
  values: PluginValues,
): { action: string; values: PluginValues } {
  if (!identifier(action) || !page.actions.some((a) => a.id === action))
    throw new Error('插件界面动作未在页面声明');
  const payload = { action, values: safeValues(values) };
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 60 * 1024)
    throw new Error('插件表单超过消息大小限制');
  return payload;
}
