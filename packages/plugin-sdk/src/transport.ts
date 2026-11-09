export type Request = <T>(method: string, input?: Record<string, unknown>) => Promise<T>;
let transport: Request | undefined;

/** Installed by the isolated UI runtime. It grants no native IPC access. */
export function connectTransport(value: Request): () => void {
  transport = value;
  return () => {
    if (transport === value) transport = undefined;
  };
}

export function request<T>(method: string, input?: Record<string, unknown>): Promise<T> {
  if (!transport)
    return Promise.reject(
      Object.assign(new Error('插件尚未连接宿主 SDK'), { code: 'PLUGIN_CANCELLED' }),
    );
  return transport<T>(method, input);
}
