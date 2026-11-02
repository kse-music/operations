export type AuthType = 'password' | 'private_key' | 'agent';
export interface HostInput {
  ssh: import('./connection').SshOptions;
  /** Empty means the address and non-default SSH port are used for display. */
  name: string;
  hostname: string;
  port: number;
  username: string;
  authType: AuthType;
  credentialId: string | null;
  groupId: string | null;
  tags: string[];
  description: string;
  favorite: boolean;
  connectTimeoutSecs: number;
}
export interface Host extends HostInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}
export interface HostGroup {
  id: string;
  name: string;
  sortOrder: number;
}
export interface Credential {
  id: string;
  name: string;
  kind: 'password' | 'private_key';
  keyPath: string | null;
  hasSecret: boolean;
  hostCount: number;
  revision: number;
}
export interface CredentialInput {
  name: string;
  kind: 'password' | 'private_key';
  keyPath: string | null;
  secret: string | null;
  clearSecret: boolean;
}
export interface Catalog {
  hosts: Host[];
  groups: HostGroup[];
  credentials: Credential[];
  pendingSecretDeletions: number;
}
export interface Mutation<T> {
  value: T;
  warnings: string[];
}
export interface SecureStatus {
  available: boolean;
  message: string;
}
export interface ImportCandidate {
  jumpAlias: string | null;
  alias: string;
  host: HostInput;
  identityFile: string | null;
  warnings: string[];
  blocked: boolean;
  duplicate: boolean;
}
export interface ImportPreview {
  candidates: ImportCandidate[];
  warnings: string[];
}
export const authLabels: Record<AuthType, string> = {
  password: 'SSH 密码',
  private_key: 'SSH 私钥',
  agent: '系统 SSH Agent',
};
export function hostDisplayName(
  host: Pick<HostInput, 'name' | 'hostname' | 'port'> | null | undefined,
): string {
  if (!host) return '';
  if (host.name.trim()) return host.name.trim();
  if (host.port === 22) return host.hostname;
  const address = host.hostname.includes(':') ? `[${host.hostname}]` : host.hostname;
  return `${address}:${host.port}`;
}
export function hostInput(host?: Host, timeout = 15): HostInput {
  return {
    ssh: host?.ssh
      ? (JSON.parse(JSON.stringify(host.ssh)) as import('./connection').SshOptions)
      : {
          authTimeoutSecs: 15,
          keepaliveIntervalSecs: 15,
          keepaliveCountMax: 3,
          jumpHostId: null,
          proxy: null,
        },
    name: host?.name ?? '',
    hostname: host?.hostname ?? '',
    port: host?.port ?? 22,
    username: host?.username ?? '',
    authType: host?.authType ?? 'agent',
    credentialId: host?.credentialId ?? null,
    groupId: host?.groupId ?? null,
    tags: [...(host?.tags ?? [])],
    description: host?.description ?? '',
    favorite: host?.favorite ?? false,
    connectTimeoutSecs: host?.connectTimeoutSecs ?? timeout,
  };
}
