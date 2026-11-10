import { afterEach, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import ContainerStartup from './ContainerStartup.vue';
import { composeYaml } from './compose-yaml';
import type { OpsRequest, OpsResponse } from './types';

let app: App | undefined;
let root: HTMLDivElement;
const settle = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
  await nextTick();
};
const response = (request: OpsRequest): OpsResponse => ({
  success: true,
  code: null,
  message: null,
  records: [],
  detail: {
    id: 'selected',
    source: 'compose',
    project: 'shop',
    service: 'web',
    environmentRevealed: 'revealEnv' in request && request.revealEnv,
    warnings: ['当前项目文件中的 service 配置'],
    configuration: {
      services: {
        web: {
          image: 'nginx',
          environment: {
            TOKEN: 'revealEnv' in request && request.revealEnv ? 'visible-secret' : '[已隐藏]',
          },
        },
      },
    },
  },
});
function mount(query: (request: OpsRequest) => Promise<OpsResponse>) {
  root = document.createElement('div');
  document.body.append(root);
  app = createApp(ContainerStartup, { containerId: 'selected', query });
  app.mount(root);
}
afterEach(() => {
  app?.unmount();
  app = undefined;
  root?.remove();
});

it('displays environment values on entry without a reveal button and clears them on close', async () => {
  const query = vi.fn(async (request: OpsRequest) => response(request));
  mount(query);
  await settle();
  expect(root.textContent).toContain('Compose · shop / web');
  expect(root.querySelector('pre')?.textContent).toContain('services:\n  web:');
  expect(root.textContent).toContain('visible-secret');
  expect(root.querySelectorAll('button')).toHaveLength(0);
  expect(query).toHaveBeenCalledExactlyOnceWith({
    kind: 'container_startup',
    id: 'selected',
    revealEnv: true,
    inspectOnly: false,
  });
  app!.unmount();
  app = undefined;
  expect(document.body.textContent).not.toContain('visible-secret');
});

it('discards a pending configuration response after closing', async () => {
  let finish: (result: OpsResponse) => void = () => {};
  const query = vi.fn(
    () =>
      new Promise<OpsResponse>((resolve) => {
        finish = resolve;
      }),
  );
  mount(query);
  await settle();
  expect(root.querySelector('[role="status"]')?.textContent).toContain('正在读取');
  app!.unmount();
  app = undefined;
  finish(
    response({ kind: 'container_startup', id: 'selected', revealEnv: true, inspectOnly: false }),
  );
  await settle();
  expect(document.body.textContent).not.toContain('visible-secret');
});

it('shows config failures and loads values during explicit inspect fallback', async () => {
  const query = vi.fn(async (request: OpsRequest) => response(request));
  query.mockRejectedValueOnce(new Error('Compose 配置文件不存在'));
  mount(query);
  await settle();
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('配置文件不存在');
  const fallback = [...root.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('容器信息转换'),
  )!;
  query.mockImplementationOnce(async (request) => {
    const result = response(request);
    result.detail!.source = 'inspect';
    return result;
  });
  fallback.click();
  await settle();
  expect(query).toHaveBeenLastCalledWith({
    kind: 'container_startup',
    id: 'selected',
    revealEnv: true,
    inspectOnly: true,
  });
  expect(root.textContent).toContain('容器信息转换');
  expect(root.textContent).toContain('visible-secret');
});

it('rejects wrong-container data without displaying its configuration', async () => {
  const query = vi.fn(async (request: OpsRequest) => {
    const result = response(request);
    result.detail!.id = 'other-container';
    return result;
  });
  mount(query);
  await settle();
  expect(root.querySelector('pre')).toBeNull();
  expect(root.textContent).not.toContain('visible-secret');
  expect(root.querySelector('[role="alert"]')?.textContent).toContain('未能读取此容器');
});

it('encodes YAML scalars without turning strings into numbers, booleans or structure', () => {
  const yaml = composeYaml({
    services: {
      true: {
        image: 'x',
        command: ['echo', 'a\nb', '${HOME}', 'a: #b', '</code><script>', 'a\u0085b\u2028c\u2029d'],
        environment: { OFF: 'no', NULL: 'null', PORT: '08080' },
        healthcheck: { disable: false },
        volumes: [],
      },
    },
  });
  expect(yaml).toContain('  "true":');
  expect(yaml).toContain('"OFF": "no"');
  expect(yaml).toContain('"NULL": "null"');
  expect(yaml).toContain('PORT: "08080"');
  expect(yaml).toContain('- "a\\nb"');
  expect(yaml).toContain('- "a\\u0085b\\u2028c\\u2029d"');
  expect(yaml).toContain('volumes: []');
  expect(yaml).toContain('disable: false');
});
