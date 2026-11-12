import { expect, it } from 'vitest';
import { createApp } from 'vue';
import AssistantAgent from './AssistantAgent.vue';
import type { AiAgentReport } from './types';

function createAgent(props: InstanceType<typeof AssistantAgent>['$props']) {
  const root = document.createElement('div');
  const app = createApp(AssistantAgent, { ...props });
  return { root, app };
}

it.each(['local', 'remote'] as const)('formats only the local transfer source (%s)', (kind) => {
  const path = kind === 'local' ? '\\\\?\\C:\\images\\image.tar' : '/srv/\\\\?\\C:\\image.tar';
  const report: AiAgentReport = {
    observations: [],
    steps: [
      {
        action: '传输',
        target: 'host',
        preview: {
          kind: 'transfer',
          preview: {
            id: 'copy',
            source: kind === 'local' ? { kind, path } : { kind, hostId: 'source', path },
            destination: { hostId: 'host', path: '/srv/\\\\?\\C:\\image.tar' },
            bytes: 1024,
            overwrite: false,
            targetExists: false,
          },
        },
      },
    ],
  };
  const { root, app } = createAgent({ report });
  try {
    app.mount(root);
    const values = root.querySelectorAll('.ai-destination dd');
    expect(values[0]?.textContent?.trim()).toBe(
      kind === 'local' ? '本机：C:\\images\\image.tar' : `source：${path}`,
    );
    expect(values[1]?.textContent?.trim()).toBe('host：/srv/\\\\?\\C:\\image.tar');
    expect(report.steps[0]!.preview).toMatchObject({ preview: { source: { path } } });
  } finally {
    app.unmount();
  }
});

it('shows completed tool history without asking to approve the recorded plan again', () => {
  const report: AiAgentReport = {
    observations: [],
    steps: [{ action: '保存', target: 'host:/work/file' }],
  };
  const { root, app } = createAgent({
    report,
    completed: true,
    execution: {
      steps: [
        {
          action: '保存',
          target: 'host:/work/file',
          tool: 'file_edit',
          status: 'verified',
          message: '内容已核对',
        },
      ],
    },
  });
  try {
    app.mount(root);
    expect(root.textContent).toContain('执行记录');
    expect(root.textContent).toContain('已执行并复查');
    expect(root.textContent).not.toContain('确认后才会执行');
  } finally {
    app.unmount();
  }
});
