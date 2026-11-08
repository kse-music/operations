export type SplitAxis = 'rows' | 'columns';
export type LayoutNode =
  | { kind: 'leaf'; pane: string }
  | {
      kind: 'split';
      id: string;
      axis: SplitAxis;
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };
