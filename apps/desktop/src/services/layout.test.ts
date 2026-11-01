import { describe, it, expect } from 'vitest';
import { geometry, removeLeaf, resizeNode } from './layout';
import type { LayoutNode } from '../types/workspace';
describe('split geometry', () => {
  it('partitions the full area and collapses a closed branch', () => {
    const root: LayoutNode = {
      kind: 'split',
      id: 'one',
      axis: 'columns',
      ratio: 30,
      first: { kind: 'leaf', pane: 'a' },
      second: {
        kind: 'split',
        id: 'two',
        axis: 'rows',
        ratio: 60,
        first: { kind: 'leaf', pane: 'b' },
        second: { kind: 'leaf', pane: 'c' },
      },
    };
    const layout = geometry(root);
    expect(layout.panes.a).toEqual({ left: 0, top: 0, width: 30, height: 100 });
    expect(layout.panes.b).toEqual({ left: 30, top: 0, width: 70, height: 60 });
    expect(Object.values(layout.panes).reduce((sum, r) => sum + r.width * r.height, 0)).toBe(10000);
    const resized = geometry(resizeNode(root, 'one', 99));
    expect(resized.panes.a!.width).toBe(90);
    const closed = removeLeaf(root, 'b');
    expect(closed && geometry(closed).panes.c).toEqual({
      left: 30,
      top: 0,
      width: 70,
      height: 100,
    });
  });
});
