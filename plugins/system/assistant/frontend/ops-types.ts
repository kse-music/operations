export type Scope = 'system' | 'user';
export type LogSource =
  | { kind: 'container'; id: string }
  | { kind: 'file'; path: string }
  | { kind: 'service'; scope: Scope; unit: string };
