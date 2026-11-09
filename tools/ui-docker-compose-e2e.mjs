// Layout/interaction fixtures only: production Docker frontend and SDK MessageChannel.
// Real Compose/Wasm commands are tested separately by docker_compose_live_project_lifecycle.
/* global Buffer, process, window, document, MessageChannel, btoa, innerWidth, console */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const output = process.env.SERVERDECK_DOCKER_UI_OUTPUT ?? '.local/qa/compose/ui';
await mkdir(output, { recursive: true });
const pkg = JSON.parse(await readFile('plugins/system/packages/docker.sdplugin', 'utf8'));
const server = createServer((request, response) => {
  const file = pkg.files.find((file) => `/${file.path}` === request.url);
  response.setHeader(
    'Content-Type',
    file ? (file.path.endsWith('.css') ? 'text/css' : 'text/javascript') : 'text/html',
  );
  response.end(
    file
      ? Buffer.from(file.content, 'base64')
      : request.url === '/plugin'
        ? '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/frontend.css"><div id="app"></div><script src="/frontend.js"></script>'
        : '<!doctype html><meta charset="utf-8"><style>html,body,iframe{border:0;margin:0;width:100%;height:100%;display:block;overflow:hidden}</style>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.SERVERDECK_BROWSER ??
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const results = [];
try {
  for (const [width, height, scale, theme] of [
    [1280, 820, 1, 'dark'],
    [960, 600, 1.45, 'light'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.evaluate(
      ({ scale, theme }) => {
        window.fixture = { mode: 'normal', actions: [], stopped: [], state: 'running(2)' };
        window.addEventListener('message', (event) => {
          if (event.data?.kind !== 'serverdeck-sdk-ready') return;
          const channel = new MessageChannel();
          channel.port1.onmessage = async ({ data }) => {
            if (data.kind === 'connected') {
              channel.port1.postMessage({
                kind: 'context',
                visible: true,
                props: { hostId: 'host', initialSection: 'compose' },
                state: {
                  theme,
                  interfaceFontScale: scale,
                  hosts: [{ id: 'host', name: 'Compose QA', hostname: '192.0.2.1' }],
                  connections: { host: { state: 'connected' } },
                  models: [],
                  groups: [],
                  settingsRevision: 0,
                },
              });
            }
            if (data.kind !== 'request') return;
            const { args, id, method } = data;
            let result = null,
              error = null;
            if (method === 'invoke') {
              const request = args.input.request;
              if (args.action === 'logs') result = { id: 'project-log' };
              else if (request.kind === 'compose_projects' && window.fixture.mode === 'error')
                error = { code: 'REMOTE_COMMAND', message: 'Compose 未安装或访问被拒绝' };
              else {
                if (request.kind === 'compose_action') {
                  window.fixture.actions.push({ request, confirmation: args.confirmation });
                  window.fixture.state = request.action === 'stop' ? 'exited(2)' : 'running(2)';
                }
                result = {
                  success: true,
                  code: null,
                  message: null,
                  records:
                    request.kind === 'compose_projects' && window.fixture.mode !== 'empty'
                      ? [
                          {
                            Name: 'shop-production',
                            Status: window.fixture.state,
                            ConfigFiles:
                              '/srv/业务系统/production deployment/compose.yaml,/srv/业务系统/production deployment/override.yaml',
                          },
                        ]
                      : [],
                  detail:
                    request.kind === 'capabilities'
                      ? {
                          dockerInstalled: true,
                          dockerState: 'running',
                          dockerVersion: {
                            Client: { Version: '28.5.1', GitCommit: 'CLIENT_BUILD_METADATA' },
                            Server: {
                              Version: '27.5.1',
                              Os: 'linux',
                              Arch: 'amd64',
                              Components: [{ Name: 'containerd', Version: 'UNNEEDED_DETAILS' }],
                            },
                          },
                        }
                      : request.kind === 'compose_services'
                        ? {
                            composeProject: 'shop-production',
                            services: ['web', 'worker'].map((service) => ({
                              ID: service,
                              Name: `/shop-production-${service}-1`,
                              Service: service,
                              Image: `registry.example.com/application/${service}:stable`,
                              State: 'running',
                              ExitCode: 0,
                            })),
                          }
                        : null,
                };
              }
            } else if (method === 'platform.request') {
              const operation = args.operation;
              if (operation.kind === 'stream_stop') window.fixture.stopped.push(operation.streamId);
              if (operation.kind === 'stream_poll')
                result = {
                  events: [
                    {
                      type: 'data',
                      stream: 'stdout',
                      dataBase64: btoa('web | COMPOSE_UI_LOG_OK\n'),
                    },
                    { type: 'state', state: 'closed' },
                  ],
                };
            } else if (method !== 'ui.notify')
              throw new Error(`Unexpected fixture method ${method}`);
            channel.port1.postMessage({ kind: 'response', id, result, error });
          };
          event.source.postMessage({ kind: 'serverdeck-sdk-connect' }, '*', [channel.port2]);
        });
        const frame = document.createElement('iframe');
        frame.src = '/plugin';
        document.body.append(frame);
      },
      { scale, theme },
    );
    const frame = page.frameLocator('iframe');
    await frame.locator('[data-ops-target="shop-production"]').waitFor();
    const measure = async () => {
      const geometry = await page
        .frames()[1]
        .evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 }));
      assert.equal(geometry.overflow, false);
    };
    await measure();
    await page.screenshot({ path: `${output}/projects-${width}-${theme}.png` });
    await frame.getByRole('button', { name: '版本 / 能力详情', exact: true }).click();
    const capabilities = frame.getByRole('dialog', { name: '主机能力与版本' });
    await capabilities.getByText('27.5.1', { exact: true }).waitFor();
    assert.deepEqual(await capabilities.locator('dt').allTextContents(), [
      'Docker 已安装',
      'Docker 状态',
      'Docker 版本',
      '客户端版本',
      '运行平台',
    ]);
    assert.deepEqual(
      (await capabilities.locator('dd').allTextContents()).map((value) => value.trim()),
      ['是', '运行中', '27.5.1', '28.5.1', 'linux / amd64'],
    );
    assert.equal(await capabilities.locator('details, pre').count(), 0);
    assert.equal((await capabilities.textContent()).includes('UNNEEDED_DETAILS'), false);
    await measure();
    const bounds = await capabilities.boundingBox();
    assert(
      bounds &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= width + 1 &&
        bounds.y + bounds.height <= height + 1,
    );
    await page.screenshot({ path: `${output}/capabilities-${width}-${theme}.png` });
    await frame.getByRole('button', { name: '关闭对话框' }).click();
    await frame.getByRole('button', { name: '服务', exact: true }).click();
    await frame
      .getByRole('dialog')
      .getByText('shop-production-worker-1', { exact: true })
      .waitFor();
    await measure();
    await page.screenshot({ path: `${output}/services-${width}-${theme}.png` });
    await frame.getByRole('button', { name: '关闭对话框' }).click();
    for (const label of ['停止', '启动', '重启']) {
      await frame.getByRole('button', { name: label, exact: true }).click();
      await frame.locator('[data-ops-target="shop-production"]').waitFor();
    }
    const actions = await page.evaluate(() => window.fixture.actions);
    assert.deepEqual(
      actions.map((a) => a.request.action),
      ['stop', 'start', 'restart'],
    );
    assert(actions.every((a) => a.confirmation.message.includes('shop-production')));
    await frame.getByRole('button', { name: '日志', exact: true }).click();
    await frame
      .getByRole('dialog')
      .getByText('web | COMPOSE_UI_LOG_OK', { exact: false })
      .waitFor();
    await frame
      .getByRole('tab', { name: '镜像', exact: true })
      .evaluate((button) => button.click());
    await page.waitForFunction(() => window.fixture.stopped.includes('project-log'));
    await frame.getByRole('tab', { name: 'Compose 项目', exact: true }).click();
    await frame.locator('[data-ops-target="shop-production"]').waitFor();
    await page.evaluate(() => {
      window.fixture.mode = 'empty';
    });
    await frame.getByRole('button', { name: '刷新运维列表' }).click();
    await frame.getByText('没有匹配项目。', { exact: true }).waitFor();
    await page.evaluate(() => {
      window.fixture.mode = 'error';
    });
    await frame.getByRole('button', { name: '刷新运维列表' }).click();
    await frame
      .getByRole('alert')
      .getByText('Compose 未安装或访问被拒绝', { exact: false })
      .waitFor();
    assert.deepEqual(errors, []);
    results.push({ width, height, scale, theme, passed: true });
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
