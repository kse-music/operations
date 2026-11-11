import { readonly, ref } from 'vue';
import type { PluginLocale } from './types/plugins';

const currentLocale = ref<PluginLocale>('zh-CN');
export const locale = readonly(currentLocale);

/** Set from the saved application preference or authenticated host context. */
export function setLocale(value: PluginLocale): void {
  currentLocale.value = value;
  if (typeof document !== 'undefined') document.documentElement.lang = value;
}

/** Translate application-owned text. Interpolated user data is never translated. */
export function createTranslator(english: Readonly<Record<string, string>>) {
  return (source: string, ...values: unknown[]): string => {
    const text =
      currentLocale.value === 'en-US' && Object.hasOwn(english, source) ? english[source]! : source;
    return text.replace(/\{(\d+)\}/g, (match, index: string) =>
      Number(index) < values.length ? String(values[Number(index)]) : match,
    );
  };
}
