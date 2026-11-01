import { onBeforeUnmount, watch, type Ref } from 'vue';
import type { Theme } from '../types/ipc';

export function resolveTheme(theme: Theme, systemIsDark: boolean): 'dark' | 'light' {
  return theme === 'system' ? (systemIsDark ? 'dark' : 'light') : theme;
}

export function useTheme(theme: Ref<Theme | undefined>): void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  function update(): void {
    document.documentElement.dataset.theme = resolveTheme(theme.value ?? 'dark', media.matches);
  }
  media.addEventListener('change', update);
  watch(theme, update, { immediate: true });
  onBeforeUnmount(() => media.removeEventListener('change', update));
}
