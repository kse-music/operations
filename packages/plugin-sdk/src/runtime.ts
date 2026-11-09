import { createApp, h, reactive, type Component } from 'vue';
import { connectTransport } from './transport';
import { updateVisibility } from './visibility';
import { updatePlatformContext, type PlatformContext } from './context';
/** One authenticated parent channel; no native IPC, host stores or service business logic. */
export function mountPlugin(component: Component): void {
  const props = reactive<Record<string, unknown>>({});
  let port: MessagePort | undefined,
    nextId = 0,
    mounted = false;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const disconnect = connectTransport(
    <T>(method: string, args: Record<string, unknown> = {}) =>
      new Promise<T>((resolve, reject) => {
        if (!port || pending.size >= 32) {
          reject(new Error('插件连接未就绪或请求过多'));
          return;
        }
        let input: Record<string, unknown>;
        try {
          const text = JSON.stringify(args);
          if (new TextEncoder().encode(text).length > 1024 * 1024)
            throw new Error('插件请求超过限制');
          input = JSON.parse(text);
        } catch (error) {
          reject(error);
          return;
        }
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('平台请求超时，请核对实际状态'));
        }, 180000);
        pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
        try {
          port.postMessage({ kind: 'request', id, method, args: input });
        } catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      }),
  );
  const routeEvent = (name: string, value: unknown) => {
    if (typeof value === 'string' && value.length <= 64)
      port?.postMessage({ kind: 'event', name, args: [value] });
  };
  const app = createApp({
    render: () =>
      h(component, {
        ...props,
        onSection: (value: unknown) => routeEvent('section', value),
        onNavigate: (value: unknown) => routeEvent('navigate', value),
      }),
  });
  function initialize(message: MessageEvent) {
    if (
      message.source !== parent ||
      message.data?.kind !== 'serverdeck-sdk-connect' ||
      message.ports.length !== 1 ||
      port
    )
      return;
    window.removeEventListener('message', initialize);
    port = message.ports[0]!;
    port.onmessage = ({ data }) => {
      if (data?.kind === 'response' && Number.isSafeInteger(data.id)) {
        const job = pending.get(data.id);
        if (!job) return;
        pending.delete(data.id);
        clearTimeout(job.timer);
        if (data.error) job.reject(data.error);
        else job.resolve(data.result);
      } else if (data?.kind === 'context') {
        for (const key of Object.keys(props)) if (!(key in data.props)) delete props[key];
        for (const [key, value] of Object.entries(data.props))
          if (JSON.stringify(props[key]) !== JSON.stringify(value)) props[key] = value;
        const state = data.state;
        if (!state) return;
        document.documentElement.dataset.theme = state.theme;
        const scale = Number(state.interfaceFontScale);
        document.documentElement.style.setProperty(
          '--interface-font-scale',
          String(Number.isFinite(scale) && scale > 0 ? scale : 1),
        );
        const context: PlatformContext = {
          hostId: String(data.props.hostId ?? ''),
          hosts: state.hosts ?? [],
          groups: state.groups ?? [],
          connections: state.connections ?? {},
          models: state.models ?? [],
          settingsRevision: state.settingsRevision,
          visible: data.visible !== false,
        };
        updatePlatformContext(context);
        updateVisibility(context.visible);
        if (!mounted) {
          mounted = true;
          app.mount('#app');
        }
      }
    };
    port.start();
    port.postMessage({ kind: 'connected' });
  }
  window.addEventListener('message', initialize);
  let closed = false;
  function dispose() {
    if (closed) return;
    closed = true;
    window.removeEventListener('pagehide', dispose);
    window.removeEventListener('unload', dispose);
    window.removeEventListener('message', initialize);
    disconnect();
    port?.close();
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error('插件页面已关闭'));
    }
    pending.clear();
    if (mounted) app.unmount();
  }
  window.addEventListener('pagehide', dispose, { once: true });
  window.addEventListener('unload', dispose, { once: true });
  parent.postMessage({ kind: 'serverdeck-sdk-ready', version: 1 }, '*');
}
