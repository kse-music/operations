import { createApp, h, reactive, type Component } from 'vue';
import { createPinia } from 'pinia';
import { connectTransport } from './transport';
import { useHostsStore } from './stores/hosts';
import { useOpsStore } from './stores/ops';
import { useFilesStore } from './stores/files';
import { useModelsStore } from './stores/models';
import { useApplicationStore } from './stores/application';
import { updateVisibility } from './visibility';

export function mountPlugin(component: Component): void {
  const pinia = createPinia();
  const props = reactive<Record<string, unknown>>({});
  let port: MessagePort | undefined;
  let nextId = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const streams = new Map<string, (event: unknown) => void>();
  const streamResources = new Map<string, string>();
  function releaseStream(stream: string) {
    streams.delete(stream);
    for (const [resource, owner] of streamResources)
      if (owner === stream) streamResources.delete(resource);
  }
  const disconnect = connectTransport(
    <T>(method: string, input: Record<string, unknown> = {}) =>
      new Promise<T>((resolve, reject) => {
        if (!port || pending.size >= 32) return reject(new Error('插件连接未就绪或请求过多'));
        const id = ++nextId;
        const args = { ...input };
        const events = args.events as { onmessage?: (event: unknown) => void } | undefined;
        let stream = '';
        if (events?.onmessage) {
          if (streams.size >= 64) return reject(new Error('插件事件流超过限制'));
          stream = `stream-${id}`;
          args.events = stream;
        }
        let encoded: string;
        try {
          encoded = JSON.stringify(args);
        } catch (error) {
          return reject(error);
        }
        if (new TextEncoder().encode(encoded).length > 1024 * 1024)
          return reject(new Error('插件请求超过限制'));
        if (stream) streams.set(stream, events!.onmessage!);
        const fail = (error: unknown) => {
          if (stream) releaseStream(stream);
          reject(error);
        };
        const timer = setTimeout(() => {
          pending.delete(id);
          fail(new Error('宿主请求超时，请核对实际状态'));
        }, 180_000);
        pending.set(id, {
          resolve: (value) => {
            if (
              stream &&
              value &&
              typeof value === 'object' &&
              'id' in value &&
              typeof value.id === 'string'
            )
              streamResources.set(value.id, stream);
            if (method === 'ops_log_close' || method === 'ops_close') {
              const closed = streamResources.get(String(args.id));
              if (closed) releaseStream(closed);
            }
            resolve(value as T);
          },
          reject: fail,
          timer,
        });
        try {
          port.postMessage({ kind: 'request', id, method, args: JSON.parse(encoded) });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          fail(error);
        }
      }),
  );
  const event =
    (name: string) =>
    (...args: unknown[]) => {
      if (port) port.postMessage(JSON.parse(JSON.stringify({ kind: 'event', name, args })));
    };
  let mounted = false;
  const app = createApp({
    render: () =>
      h(component, {
        ...props,
        onNavigate: event('navigate'),
        onShell: event('shell'),
        onSection: event('section'),
        onLog: event('log'),
        onIntentConsumed: event('intentConsumed'),
      }),
  }).use(pinia);
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
      } else if (data?.kind === 'stream') {
        streams.get(data.id)?.(data.event);
        if (
          data.event?.type === 'state' &&
          ['closed', 'failed', 'cancelled'].includes(data.event.state)
        )
          releaseStream(data.id);
      } else if (data?.kind === 'context') {
        for (const key of Object.keys(props)) if (!(key in data.props)) delete props[key];
        for (const [key, value] of Object.entries(data.props))
          if (JSON.stringify(props[key]) !== JSON.stringify(value)) props[key] = value;
        document.documentElement.dataset.pluginSurface = data.props.page?.surface?.kind ?? '';
        const state = data.state;
        if (!state) return;
        document.documentElement.dataset.theme = state.theme;
        const hosts = useHostsStore(pinia);
        if (JSON.stringify(hosts.catalog) !== JSON.stringify(state.catalog))
          hosts.catalog = state.catalog;
        hosts.selectedId = state.hostId;
        const ops = useOpsStore(pinia),
          files = useFilesStore(pinia),
          application = useApplicationStore(pinia);
        if (JSON.stringify(ops.connections) !== JSON.stringify(state.operations))
          ops.connections = state.operations;
        if (JSON.stringify(files.connections) !== JSON.stringify(state.files))
          files.connections = state.files;
        if (application.state?.config.monitorIntervalSecs !== state.monitorIntervalSecs)
          application.state = { config: { monitorIntervalSecs: state.monitorIntervalSecs } };
        const models = useModelsStore(pinia);
        if (JSON.stringify(models.models) !== JSON.stringify(state.models))
          models.models = state.models;
        if (
          models.selectedId &&
          !state.models.some((model: { id: string }) => model.id === models.selectedId)
        )
          models.selectedId = '';
        if (!models.loaded && state.models.length === 1) models.selectedId = state.models[0].id;
        models.loaded = true;
        updateVisibility(data.visible !== false);
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
  window.addEventListener(
    'pagehide',
    () => {
      disconnect();
      if (mounted) app.unmount();
      for (const job of pending.values()) {
        clearTimeout(job.timer);
        job.reject(new Error('插件界面已关闭'));
      }
      pending.clear();
      streams.clear();
      streamResources.clear();
      port?.close();
    },
    { once: true },
  );
  parent.postMessage({ kind: 'serverdeck-sdk-ready', version: 1 }, '*');
}
