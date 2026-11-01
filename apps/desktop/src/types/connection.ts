export interface ProxySettings {
  kind: 'socks5' | 'http_connect';
  hostname: string;
  port: number;
  username: string | null;
  credentialId: string | null;
}
export interface SshOptions {
  authTimeoutSecs: number;
  keepaliveIntervalSecs: number;
  keepaliveCountMax: number;
  jumpHostId: string | null;
  proxy: ProxySettings | null;
}
export const defaultSshOptions = (): SshOptions => ({
  authTimeoutSecs: 15,
  keepaliveIntervalSecs: 15,
  keepaliveCountMax: 3,
  jumpHostId: null,
  proxy: null,
});
export interface ForwardInput {
  kind: 'local' | 'remote' | 'dynamic';
  bindAddress: string;
  listenPort: number;
  targetHost: string | null;
  targetPort: number | null;
  confirmPublic: boolean;
}
export interface ForwardInfo {
  id: string;
  sessionId: string;
  input: ForwardInput;
  state: string;
  message: string | null;
  activeConnections: number;
}
