import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { tr } from '../i18n/messages';
import { forwardingApi } from '../services/forwarding';
import { errorMessage } from '../services/ipc';
import { terminalApi } from '../services/terminal';
import type { ForwardInfo, LocalForwardInput } from '../types/connection';
import type { TerminalEvent } from '../types/terminal';
import { useNotificationsStore } from './notifications';

interface Rule {
  input: LocalForwardInput;
  id?: string;
  state: ForwardInfo['state'] | 'stopping';
  activeConnections: number;
  message: string | null;
}
interface Lease {
  id?: string;
  opened?: Promise<string>;
  trust?: Extract<TerminalEvent, { type: 'trust' }>;
  cancelReady?: () => void;
}
interface ForwardingWorkspace {
  draft: { listenPort: string; targetHost: string; targetPort: string };
  rules: Rule[];
  rulesLoaded?: boolean;
  loadingRules?: boolean;
  rulesError?: string;
  lease?: Lease;
  pending?: Promise<void>;
  closing?: boolean;
  statusError?: string;
}

function stoppedRule(input: LocalForwardInput): Rule {
  return { input, state: 'stopped', activeConnections: 0, message: null };
}

export const useForwardingStore = defineStore('forwarding', () => {
  const workspaces = reactive<Record<string, ForwardingWorkspace>>({});

  function forHost(hostId: string): ForwardingWorkspace {
    return (workspaces[hostId] ??= reactive({
      draft: { listenPort: '', targetHost: '127.0.0.1', targetPort: '' },
      rules: [],
    }));
  }

  async function loadRules(hostId: string): Promise<void> {
    const host = forHost(hostId);
    if (host.rulesLoaded || host.loadingRules || host.closing) return;
    host.loadingRules = true;
    host.rulesError = undefined;
    try {
      host.rules = (await forwardingApi.savedRules(hostId)).map(stoppedRule);
      host.rulesLoaded = true;
    } catch (cause) {
      host.rulesError = tr('无法读取转发规则：{0}', errorMessage(cause));
    } finally {
      host.loadingRules = false;
    }
  }

  function addRule(hostId: string, input: LocalForwardInput): Promise<void> {
    const host = forHost(hostId);
    if (!host.rulesLoaded) return Promise.resolve();
    const submittedPort = host.draft.listenPort;
    return run(host, async () => {
      host.rulesError = undefined;
      try {
        const saved = await forwardingApi.addRule(hostId, input);
        host.rules.push(stoppedRule(saved));
        if (host.draft.listenPort === submittedPort) host.draft.listenPort = '';
      } catch (cause) {
        host.rulesError = tr('无法保存转发规则：{0}', errorMessage(cause));
      }
    });
  }

  function removeRule(hostId: string, rule: Rule): Promise<void> {
    const host = forHost(hostId);
    if (!host.rulesLoaded || rule.id) return Promise.resolve();
    return run(host, async () => {
      host.rulesError = undefined;
      try {
        await forwardingApi.removeRule(hostId, rule.input.listenPort);
        host.rules = host.rules.filter((item) => item !== rule);
      } catch (cause) {
        host.rulesError = tr('无法移除转发规则：{0}', errorMessage(cause));
      }
    });
  }

  async function connect(hostId: string, host: ForwardingWorkspace): Promise<string> {
    if (host.lease?.id) return host.lease.id;
    const lease = reactive<Lease>({});
    host.lease = lease;
    let receive!: (event: TerminalEvent) => void;
    const ready = new Promise<void>((resolve, reject) => {
      lease.cancelReady = () => reject(new Error(tr('SSH 连接已关闭，转发已停止。')));
      receive = (event) => {
        if (host.lease !== lease) return;
        if (event.type === 'trust') lease.trust = event;
        if (event.type !== 'state') return;
        if (event.state === 'connected') resolve();
        if (event.state !== 'closed' && event.state !== 'failed') return;
        const message = event.message || tr('SSH 连接已关闭，转发已停止。');
        host.lease = undefined;
        host.statusError = undefined;
        for (const rule of host.rules) {
          if (!rule.id && rule.state !== 'starting') continue;
          rule.id = undefined;
          rule.activeConnections = 0;
          rule.state = event.state === 'failed' ? 'failed' : 'stopped';
          rule.message = tr(message);
        }
        reject(new Error(message));
      };
    });
    lease.opened = Promise.resolve()
      .then(() => forwardingApi.open(hostId, receive))
      .then(({ id }) => (lease.id = id));
    try {
      const [id] = await Promise.all([lease.opened, ready]);
      return id;
    } catch (cause) {
      if (host.lease === lease) host.lease = undefined;
      throw cause;
    }
  }

  function run(host: ForwardingWorkspace, operation: () => Promise<void>): Promise<void> {
    if (host.pending || host.closing) return Promise.resolve();
    return (host.pending = operation().finally(async () => {
      try {
        const lease = host.lease;
        if (!host.closing && lease?.id && host.rules.every((rule) => !rule.id)) {
          await terminalApi.close(lease.id);
          if (host.lease === lease) host.lease = undefined;
        }
      } catch (cause) {
        useNotificationsStore().push(errorMessage(cause), true);
      } finally {
        host.pending = undefined;
      }
    }));
  }

  function start(hostId: string, rule: Rule): Promise<void> {
    if (rule.id) return Promise.resolve();
    const host = forHost(hostId);
    return run(host, async () => {
      rule.state = 'starting';
      rule.message = null;
      try {
        const id = await connect(hostId, host);
        if (host.lease?.id !== id) return;
        if (host.closing) {
          rule.state = 'stopped';
          return;
        }
        const info = await forwardingApi.start(id, rule.input);
        if (host.lease?.id !== id) return;
        rule.id = info.id;
        applyStatus(rule, info);
      } catch (cause) {
        if (rule.state !== 'starting') return;
        rule.state = 'failed';
        rule.message = errorMessage(cause);
      }
    });
  }

  function applyStatus(rule: Rule, info: ForwardInfo): void {
    rule.state = info.state;
    rule.message = info.message && tr(info.message);
    rule.activeConnections = info.activeConnections;
    if (info.state === 'stopped' || info.state === 'failed') rule.id = undefined;
  }

  function stop(hostId: string, rule: Rule): Promise<void> {
    const host = forHost(hostId);
    const id = rule.id;
    if (!id) return Promise.resolve();
    return run(host, async () => {
      rule.state = 'stopping';
      try {
        await forwardingApi.stop(id);
        if (rule.state !== 'stopping') return;
        rule.id = undefined;
        rule.activeConnections = 0;
        rule.state = 'stopped';
        rule.message = null;
      } catch (cause) {
        if (rule.state !== 'stopping') return;
        rule.state = 'running';
        useNotificationsStore().push(errorMessage(cause), true);
        await refresh(hostId);
      }
    });
  }

  async function refresh(hostId: string): Promise<void> {
    const host = workspaces[hostId];
    const session = host?.lease?.id;
    if (!session || host.closing) return;
    const ids = new Set(
      host.rules.filter((rule) => rule.state === 'running').map((rule) => rule.id),
    );
    try {
      const states = await forwardingApi.list(session);
      if (host.lease?.id !== session || host.closing) return;
      host.statusError = undefined;
      for (const rule of host.rules) {
        if (!rule.id || !ids.has(rule.id) || rule.state !== 'running') continue;
        const info = states.find((item) => item.id === rule.id);
        if (info) applyStatus(rule, info);
        else {
          rule.id = undefined;
          rule.activeConnections = 0;
          rule.state = 'failed';
          rule.message = tr('转发监听已关闭。');
        }
      }
    } catch (cause) {
      if (host.lease?.id === session && !host.closing) host.statusError = errorMessage(cause);
    }
  }

  async function trust(hostId: string, accept: boolean): Promise<void> {
    const lease = workspaces[hostId]?.lease;
    if (!lease?.id || !lease.trust) return;
    lease.trust = undefined;
    try {
      await terminalApi.trust(lease.id, accept);
    } catch (cause) {
      useNotificationsStore().push(errorMessage(cause), true);
    }
  }

  async function close(hostId: string): Promise<boolean> {
    const host = workspaces[hostId];
    if (!host) return true;
    host.closing = true;
    try {
      // An open failure is already handled by start(). It has no native lease to close.
      const lease = host.lease;
      const id = await lease?.opened?.catch(() => undefined);
      if (id) await terminalApi.close(id);
      lease?.cancelReady?.();
      await host.pending;
      delete workspaces[hostId];
      return true;
    } catch (cause) {
      useNotificationsStore().push(errorMessage(cause), true);
      return false;
    } finally {
      host.closing = false;
    }
  }

  return { forHost, loadRules, addRule, removeRule, start, stop, refresh, trust, close };
});
