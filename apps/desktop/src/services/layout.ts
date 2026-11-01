import type { LayoutNode, SplitAxis } from '../types/workspace';
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Divider {
  id: string;
  axis: SplitAxis;
  ratio: number;
  rect: Rect;
  parent: Rect;
}
export function geometry(root: LayoutNode): { panes: Record<string, Rect>; dividers: Divider[] } {
  const panes: Record<string, Rect> = {};
  const dividers: Divider[] = [];
  function walk(node: LayoutNode, rect: Rect): void {
    if (node.kind === 'leaf') {
      panes[node.pane] = rect;
      return;
    }
    const fraction = node.ratio / 100;
    if (node.axis === 'columns') {
      walk(node.first, { ...rect, width: rect.width * fraction });
      walk(node.second, {
        ...rect,
        left: rect.left + rect.width * fraction,
        width: rect.width * (1 - fraction),
      });
      dividers.push({
        id: node.id,
        axis: node.axis,
        ratio: node.ratio,
        parent: rect,
        rect: {
          left: rect.left + rect.width * fraction,
          top: rect.top,
          width: 0,
          height: rect.height,
        },
      });
    } else {
      walk(node.first, { ...rect, height: rect.height * fraction });
      walk(node.second, {
        ...rect,
        top: rect.top + rect.height * fraction,
        height: rect.height * (1 - fraction),
      });
      dividers.push({
        id: node.id,
        axis: node.axis,
        ratio: node.ratio,
        parent: rect,
        rect: {
          left: rect.left,
          top: rect.top + rect.height * fraction,
          width: rect.width,
          height: 0,
        },
      });
    }
  }
  walk(root, { left: 0, top: 0, width: 100, height: 100 });
  return { panes, dividers };
}
export function replaceLeaf(node: LayoutNode, pane: string, replacement: LayoutNode): LayoutNode {
  if (node.kind === 'leaf') return node.pane === pane ? replacement : node;
  return {
    ...node,
    first: replaceLeaf(node.first, pane, replacement),
    second: replaceLeaf(node.second, pane, replacement),
  };
}
export function removeLeaf(node: LayoutNode, pane: string): LayoutNode | null {
  if (node.kind === 'leaf') return node.pane === pane ? null : node;
  const first = removeLeaf(node.first, pane),
    second = removeLeaf(node.second, pane);
  return first && second ? { ...node, first, second } : (first ?? second);
}
export function resizeNode(node: LayoutNode, id: string, ratio: number): LayoutNode {
  if (node.kind === 'leaf') return node;
  return node.id === id
    ? { ...node, ratio: Math.max(10, Math.min(90, Math.round(ratio))) }
    : {
        ...node,
        first: resizeNode(node.first, id, ratio),
        second: resizeNode(node.second, id, ratio),
      };
}
