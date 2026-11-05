import { computed, onActivated, onDeactivated, onScopeDispose, ref } from 'vue';
let visible = true;
export function isPluginVisible(): boolean {
  return visible && !document.hidden;
}
export function updateVisibility(value: boolean): void {
  if (visible === value) return;
  visible = value;
  document.dispatchEvent(new Event('visibilitychange'));
}
// A cached panel is inactive even while its containing plugin remains visible.
export function usePluginVisibility() {
  const documentVisible = ref(isPluginVisible()),
    panelActive = ref(true);
  const update = () => {
    documentVisible.value = isPluginVisible();
  };
  document.addEventListener('visibilitychange', update);
  onScopeDispose(() => document.removeEventListener('visibilitychange', update));
  onActivated(() => {
    panelActive.value = true;
    update();
  });
  onDeactivated(() => {
    panelActive.value = false;
  });
  return computed(() => documentVisible.value && panelActive.value);
}
