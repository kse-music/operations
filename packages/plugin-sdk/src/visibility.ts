let visible = true;
export function isPluginVisible(): boolean {
  return visible && !document.hidden;
}
export function updateVisibility(value: boolean): void {
  if (visible === value) return;
  visible = value;
  document.dispatchEvent(new Event('visibilitychange'));
}
