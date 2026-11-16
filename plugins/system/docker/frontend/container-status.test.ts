import { afterEach, expect, it } from 'vitest';
import { createApp, type App } from 'vue';
import { setLocale } from '@serverdeck/plugin-sdk/i18n';
import ComposeDetails from './ComposeDetails.vue';
import { containerExitText, containerStateText } from './container-status';

let app: App | undefined;
let root: HTMLDivElement | undefined;
afterEach(() => {
  app?.unmount();
  root?.remove();
  app = undefined;
  setLocale('zh-CN');
});

it.each([
  ['running', 0, '尚未退出'],
  ['running', 137, '尚未退出'],
  ['paused', 0, '尚未退出'],
  ['restarting', 1, '尚未退出'],
  ['created', 0, '尚未启动'],
  ['exited', 0, '正常结束'],
  ['exited', 1, '异常退出（退出码 1）'],
  ['exited', 137, '异常退出（退出码 137）'],
  ['exited', undefined, '退出结果未知'],
  ['exited', null, '退出结果未知'],
  ['exited', '0', '退出结果未知'],
  ['exited', -1, '退出结果未知'],
  ['exited', 0.5, '退出结果未知'],
  ['dead', 0, '退出结果未知'],
  [undefined, 0, '退出结果未知'],
])('formats the exit result for state %s and code %s', (state, code, expected) => {
  expect(containerExitText(state, code)).toBe(expected);
});

it('translates states and exit results and preserves an unrecognized state', () => {
  setLocale('en-US');
  expect(containerStateText('running')).toBe('Running');
  expect(containerStateText('exited')).toBe('Exited');
  expect(containerStateText('future-state')).toBe('future-state');
  expect(containerExitText('running', 0)).toBe('Not exited');
  expect(containerExitText('exited', 0)).toBe('Completed successfully');
  expect(containerExitText('exited', 137)).toBe('Exited with an error (code 137)');
});

it('shows semantic state and exit results for each Compose service', () => {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(ComposeDetails, {
    detail: {
      composeProject: 'fixture-project',
      services: [
        { ID: 'running', Name: '/running', State: 'running', ExitCode: 0 },
        { ID: 'created', Name: '/created', State: 'created', ExitCode: 0 },
        { ID: 'success', Name: '/success', State: 'exited', ExitCode: 0 },
        { ID: 'failure', Name: '/failure', State: 'exited', ExitCode: 137 },
        { ID: 'missing', Name: '/missing', State: 'exited' },
      ],
    },
  });
  app.mount(root);
  expect(root.querySelector('th:last-child')?.textContent).toBe('退出结果');
  expect(
    [...root.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('td')].slice(3).map((cell) => cell.textContent),
    ),
  ).toEqual([
    ['运行中', '尚未退出'],
    ['已创建', '尚未启动'],
    ['已退出', '正常结束'],
    ['已退出', '异常退出（退出码 137）'],
    ['已退出', '退出结果未知'],
  ]);
});
