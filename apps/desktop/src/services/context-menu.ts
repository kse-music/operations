export function submenuPosition(
  parent: DOMRectReadOnly,
  triggerTop: number,
  { width, height }: { width: number; height: number },
): { x: number; y: number } {
  const margin = 8;
  const right = window.innerWidth - margin;
  const bottom = window.innerHeight - margin;
  let x = parent.right;
  let y = triggerTop;
  if (x + width > right) {
    x = parent.left - width;
    if (x < margin) {
      x = Math.min(parent.left, right - width);
      y = parent.bottom + height <= bottom ? parent.bottom : parent.top - height;
    }
  }
  return { x: Math.max(margin, x), y: Math.max(margin, Math.min(y, bottom - height)) };
}
