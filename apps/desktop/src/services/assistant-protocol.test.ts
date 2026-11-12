import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { createPinia, disposePinia } from 'pinia';
import { connectTransport } from '@serverdeck/plugin-sdk/transport';
import { invoke } from '@serverdeck/plugin-sdk';
import { useAssistantApi } from '../../../../plugins/system/assistant/frontend/api';
import assistantUi from '../../../../plugins/system/assistant/ui.json';
import { createPluginUiBridge } from './plugin-ui-bridge';
import { pluginsApi } from './plugins';
import { usePluginsStore } from '../stores/plugins';
import { toolPluginState } from './system-plugins.fixture';
import type { PluginUiPage } from '../types/plugins';

afterEach(() => vi.restoreAllMocks());

it('continues export, transfer and import through the SDK and the declared page action gate', async () => {
  const pinia = createPinia();
  const app = createApp({}).use(pinia);
  const id = 'cn.hiboot.plugins.assistant';
  const owner = 'assistant-protocol';
  const plugins = usePluginsStore(pinia);
  Object.assign(plugins, toolPluginState());
  const page = assistantUi.pages.find((page) => page.id === 'assistant') as PluginUiPage;
  const api = app.runWithContext(useAssistantApi);
  const bridge = app.runWithContext(() =>
    createPluginUiBridge({
      id,
      revision: plugins.installed[0]!.revision,
      page,
      hostId: '',
      contextKey: owner,
    }),
  );
  const disconnect = connectTransport(
    async <T>(method: string, args?: Record<string, unknown>) =>
      (await bridge.call(method, args ?? {})) as T,
  );
  const phases = ['export', 'transfer', 'import'];
  let phase = 0;
  let executed = false;
  let completed = false;
  const call = vi.spyOn(pluginsApi, 'call').mockImplementation(async (plugin, payload, scope) => {
    expect(plugin).toBe(id);
    expect(scope).toBe(owner);
    const request = payload as { action: string; input: { id?: string; proposalId?: string } };
    let result: unknown;
    const answer = () =>
      phase === phases.length
        ? {
            text: '目标镜像 ID 和标签已核对',
            proposals: [],
            usage: null,
            warnings: [],
            task: { status: 'succeeded' },
          }
        : {
            text: phases[phase],
            proposals: [{ id: phases[phase], risk: 'change' }],
            usage: null,
            warnings: [],
            task: { status: 'awaiting_approval' },
          };
    switch (request.action) {
      case 'prepare':
        result = { id: 'root' };
        break;
      case 'send':
        result = answer();
        break;
      case 'execute':
        expect(request.input.proposalId).toBe(phases[phase]);
        expect(executed).toBe(false);
        executed = true;
        result = { pending: true, jobId: phases[phase], success: false, output: '执行中' };
        break;
      case 'poll':
        expect(executed).toBe(true);
        completed = true;
        result = {
          pending: false,
          continuation: true,
          success: true,
          output: '已核对',
          task: { status: 'running' },
        };
        break;
      case 'resume':
        expect(completed).toBe(true);
        phase++;
        executed = completed = false;
        result = answer();
        break;
      default:
        throw new Error(`unexpected action: ${request.action}`);
    }
    return { protocolVersion: 1, error: null, result };
  });
  try {
    await api.prepare({
      modelId: 'model',
      sessionId: null,
      question: '搬运镜像',
      selection: {
        server: true,
        metrics: false,
        processes: false,
        docker: false,
        log: null,
        logLines: 100,
      },
      maskAddresses: true,
      redactValues: [],
    });
    let answer = await api.send('root', true);
    while (answer.proposals.length) {
      await api.execute(answer.proposals[0]!.id, true, null);
      expect((await api.poll('root')).continuation).toBe(true);
      answer = await api.resume('root', 'progress');
    }
    expect(answer.task?.status).toBe('succeeded');
    expect(phase).toBe(3);
    expect(
      call.mock.calls.filter(([, payload]) => (payload as { action: string }).action === 'execute'),
    ).toHaveLength(3);
    const calls = call.mock.calls.length;
    await expect(invoke('undeclared_action')).rejects.toThrow('插件界面动作未在页面声明');
    expect(call).toHaveBeenCalledTimes(calls);
  } finally {
    disconnect();
    disposePinia(pinia);
  }
});
