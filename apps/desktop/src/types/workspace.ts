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
export interface SavedTab {
  key: string;
  title: string;
  panes: { key: string; hostId: string | null }[];
  layout: LayoutNode;
}
export interface WorkspaceLayout {
  version: 1;
  active: string;
  tabs: SavedTab[];
}
