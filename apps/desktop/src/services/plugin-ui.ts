import type { PluginUiPage, PluginValues, PluginUiResult, PluginReply } from '../types/plugins';
import { pluginsApi } from './plugins';

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
  if (
    !identifier(action) ||
    !(page.actions.some((a) => a.id === action) || page.initialAction === action)
  )
    throw new Error('插件界面动作未在页面声明');
  const payload = { action, values: safeValues(values) };
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 60 * 1024)
    throw new Error('插件表单超过消息大小限制');
  return payload;
}
export function uiResult(value: unknown): PluginUiResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { output: value };
  const data = value as Record<string, unknown>;
  if (!('values' in data) && !('output' in data) && !('saved' in data)) return { output: value };
  if (Object.keys(data).some((key) => !['values', 'output', 'saved'].includes(key)))
    throw new Error('插件返回了不支持的界面消息');
  if ('saved' in data && typeof data.saved !== 'boolean') throw new Error('插件保存状态无效');
  return {
    values: 'values' in data ? safeValues(data.values) : undefined,
    output: data.output,
    saved: data.saved as boolean | undefined,
  };
}
export async function sendPluginAction(
  id: string,
  page: PluginUiPage,
  action: string,
  values: PluginValues,
): Promise<PluginReply> {
  return pluginsApi.call(id, actionPayload(page, action, values));
}
