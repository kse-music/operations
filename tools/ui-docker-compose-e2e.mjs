// Layout/interaction fixtures only: production Docker frontend and SDK MessageChannel.
// Real Compose/Wasm commands are tested separately by docker_compose_live_project_lifecycle.
/* global Buffer, process, window, document, MessageChannel, btoa, innerWidth, console */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// --details runs container detail layout and close checks independently.
const detailsOnly = process.argv.includes('--details');
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
    [2361, 900, 1, 'dark'],
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
              if (args.action === 'logs') {
                if (args.input.source.kind === 'container') {
                  window.fixture.logPaused = false;
                  window.fixture.containerLogs = [
                    {
                      type: 'data',
                      stream: 'stdout',
                      dataBase64: btoa(
                        Array.from(
                          { length: 200 },
                          (_, index) =>
                            `2026-11-10T03:00:00Z CONTAINER_LOG_${String(index + 1).padStart(4, '0')} ${'Error: sample stack trace with a long request path /api/stock/history?query=fixture '.repeat(3)}\n`,
                        ).join(''),
                      ),
                    },
                  ];
                  result = { id: 'container-log' };
                } else result = { id: 'project-log' };
              } else if (request.kind === 'compose_projects' && window.fixture.mode === 'error')
                error = { code: 'REMOTE_COMMAND', message: 'Compose 未安装或访问被拒绝' };
              else if (
                request.kind === 'container_startup' &&
                window.fixture.mode === 'config-error' &&
                !request.inspectOnly
              )
                error = { code: 'REMOTE_COMMAND', message: 'Compose 配置文件不存在' };
              else {
                if (
                  ['compose_action', 'container_maintenance', 'container_action'].includes(
                    request.kind,
                  )
                ) {
                  window.fixture.actions.push({ request, confirmation: args.confirmation });
                  window.fixture.state = request.action === 'stop' ? 'exited(2)' : 'running(2)';
                }
                result = {
                  success: true,
                  code: null,
                  message:
                    request.kind === 'container_maintenance'
                      ? '匹配 2 个，成功 2 个，失败 0 个，跳过 0 个。'
                      : null,
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
                      : request.kind === 'containers'
                        ? [
                            {
                              ID: 'a'.repeat(64),
                              Names: 'production-web',
                              Image: 'nginx:stable',
                              State: 'running',
                            },
                            {
                              ID: 'b'.repeat(64),
                              Names: 'production-worker',
                              Image: 'worker:stable',
                              State: 'exited',
                            },
                          ]
                        : [],
                  detail:
                    request.kind === 'capabilities'
                      ? {
                          dockerInstalled: true,
                          dockerState: 'running',
                          dockerOperatingSystem: 'Ubuntu 24.04.3 LTS',
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
                        : request.kind === 'container_details'
                          ? {
                              id: request.id,
                              name: '/production-web',
                              image: 'nginx:stable',
                              environment: [],
                              state: { Status: 'running' },
                            }
                          : request.kind === 'container_startup'
                            ? {
                                id: request.id,
                                source: request.inspectOnly ? 'inspect' : 'compose',
                                project: 'shop-production',
                                service: 'web',
                                environmentRevealed: request.revealEnv,
                                warnings: [
                                  '展示当前项目文件中的 service 配置，可能与容器创建时不同。',
                                ],
                                configuration: {
                                  services: {
                                    web: {
                                      image: 'nginx:stable',
                                      ports: [
                                        {
                                          target: 80,
                                          published: '8080',
                                          protocol: 'tcp',
                                          host_ip: '::1',
                                        },
                                      ],
                                      volumes: [
                                        {
                                          type: 'bind',
                                          source: '/srv/业务系统/production deployment/html',
                                          target: '/usr/share/nginx/html',
                                          read_only: true,
                                        },
                                      ],
                                      environment: Object.fromEntries(
                                        Array.from({ length: 20 }, (_, index) => [
                                          `VARIABLE_${index}`,
                                          request.revealEnv ? 'CONFIG_FIXTURE_SECRET' : '[已隐藏]',
                                        ]),
                                      ),
                                    },
                                  },
                                },
                              }
                            : null,
                };
              }
            } else if (method === 'platform.request') {
              const operation = args.operation;
              if (operation.kind === 'stream_stop') window.fixture.stopped.push(operation.streamId);
              if (operation.kind === 'stream_pause') window.fixture.logPaused = operation.paused;
              if (operation.kind === 'stream_poll' && operation.streamId === 'container-log')
                result = {
                  events: window.fixture.logPaused ? [] : window.fixture.containerLogs.splice(0),
                };
              else if (operation.kind === 'stream_poll')
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
      const geometry = await page.frames()[1].evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        searchWidth: document.querySelector('.ops-search').getBoundingClientRect().width,
      }));
      assert.equal(geometry.overflow, false);
      assert(geometry.searchWidth >= 140 && geometry.searchWidth <= 322);
    };
    const checkDetails = async () => {
      await frame
        .locator(`[data-ops-target="${'a'.repeat(64)}"]`)
        .getByRole('button', { name: '详情', exact: true })
        .click();
      const detail = frame.getByRole('dialog', { name: '容器详情', exact: true });
      await detail.getByRole('tab', { name: '启动配置', exact: true }).click();
      const yaml = detail.getByLabel('Compose 启动配置');
      await yaml.getByText('read_only: true', { exact: false }).waitFor();
      assert.deepEqual(
        (await detail.getByRole('tab').allTextContents()).map((label) => label.trim()),
        ['概览', '资源使用', '启动配置', '环境变量'],
      );
      assert((await yaml.textContent()).includes('published: "8080"'));
      assert((await yaml.textContent()).includes('/srv/业务系统/production deployment/html'));
      const panel = detail.getByRole('tabpanel');
      await panel.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await detail.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const scrollGeometry = await detail.evaluate((element) => {
        const close = element.querySelector('[aria-label="关闭对话框"]').getBoundingClientRect();
        const tabs = element.querySelector('[role="tablist"]').getBoundingClientRect();
        const panel = element.querySelector('[role="tabpanel"]');
        const box = element.getBoundingClientRect();
        return {
          outerScroll: element.scrollTop,
          panelScroll: panel.scrollTop,
          closeTop: close.top,
          closeBottom: close.bottom,
          tabsTop: tabs.top,
          boxTop: box.top,
          boxBottom: box.bottom,
        };
      });
      await page.screenshot({ path: `${output}/startup-scrolled-${width}-${theme}.png` });
      assert.equal(scrollGeometry.outerScroll, 0, '详情弹窗自身不应滚动');
      assert(scrollGeometry.panelScroll > 0, '详情内容区应当可以独立滚动');
      assert(
        scrollGeometry.closeTop >= scrollGeometry.boxTop &&
          scrollGeometry.closeBottom <= scrollGeometry.boxBottom,
      );
      assert(scrollGeometry.tabsTop >= scrollGeometry.boxTop);
      await detail.getByRole('button', { name: '关闭对话框' }).click();
      await detail.waitFor({ state: 'detached' });
      await frame
        .locator(`[data-ops-target="${'a'.repeat(64)}"]`)
        .getByRole('button', { name: '详情', exact: true })
        .click();
      await detail.getByRole('tab', { name: '启动配置', exact: true }).click();
      await yaml.getByText('CONFIG_FIXTURE_SECRET', { exact: false }).waitFor();
      await panel.evaluate((element) => {
        element.scrollTop = 0;
      });
      assert((await detail.textContent()).includes('CONFIG_FIXTURE_SECRET'));
      assert.equal(
        await detail.getByRole('button', { name: '查看环境变量值', exact: true }).count(),
        0,
      );
      assert.equal(
        await detail.getByRole('button', { name: '隐藏环境变量值', exact: true }).count(),
        0,
      );
      const configBounds = await detail.boundingBox();
      assert(
        configBounds &&
          configBounds.x >= 0 &&
          configBounds.y >= 0 &&
          configBounds.x + configBounds.width <= width + 1 &&
          configBounds.y + configBounds.height <= height + 1,
      );
      await measure();
      await page.screenshot({ path: `${output}/startup-${width}-${theme}.png` });
      await yaml.getByText('CONFIG_FIXTURE_SECRET', { exact: false }).waitFor();
      await detail.getByRole('tab', { name: '概览', exact: true }).click();
      assert(!(await detail.textContent()).includes('CONFIG_FIXTURE_SECRET'));
      await page.evaluate(() => {
        window.fixture.mode = 'config-error';
      });
      await detail.getByRole('tab', { name: '启动配置', exact: true }).click();
      await detail
        .getByRole('alert')
        .getByText('Compose 配置文件不存在', { exact: false })
        .waitFor();
      await detail.getByRole('button', { name: '使用容器信息转换', exact: true }).click();
      await detail.getByText('容器信息转换 · Compose 格式', { exact: true }).waitFor();
      await yaml.waitFor();
      await detail.getByRole('button', { name: '关闭对话框' }).click();
      await page.evaluate(() => {
        window.fixture.mode = 'normal';
      });
    };
    if (detailsOnly) {
      await frame.getByRole('tab', { name: '容器', exact: true }).click();
      await frame.locator(`[data-ops-target="${'a'.repeat(64)}"]`).waitFor();
      await checkDetails();
      assert.deepEqual(errors, []);
      results.push({ width, height, scale, theme, scope: 'details', passed: true });
      await page.close();
      continue;
    }
    await measure();
    await page.screenshot({ path: `${output}/projects-${width}-${theme}.png` });
    await frame.getByRole('button', { name: 'Docker信息', exact: true }).click();
    const capabilities = frame.getByRole('dialog', { name: 'Docker信息' });
    await capabilities.getByText('27.5.1', { exact: true }).waitFor();
    assert.deepEqual(await capabilities.locator('dt').allTextContents(), [
      'Docker 已安装',
      'Docker 状态',
      'Docker 版本',
      '客户端版本',
      '运行平台',
      '操作系统',
    ]);
    assert.deepEqual(
      (await capabilities.locator('dd').allTextContents()).map((value) => value.trim()),
      ['是', '运行中', '27.5.1', '28.5.1', 'linux / amd64', 'Ubuntu 24.04.3 LTS'],
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
    await measure();
    await page.screenshot({ path: `${output}/images-${width}-${theme}.png` });
    await frame.getByRole('tab', { name: 'Compose 项目', exact: true }).click();
    await frame.locator('[data-ops-target="shop-production"]').waitFor();
    await page.evaluate(() => {
      window.fixture.mode = 'empty';
    });
    await frame.getByRole('button', { name: '刷新' }).click();
    await frame.getByText('没有匹配项目。', { exact: true }).waitFor();
    await page.evaluate(() => {
      window.fixture.mode = 'error';
    });
    await frame.getByRole('button', { name: '刷新' }).click();
    await frame
      .getByRole('alert')
      .getByText('Compose 未安装或访问被拒绝', { exact: false })
      .waitFor();
    await page.evaluate(() => {
      window.fixture.mode = 'normal';
    });
    await frame.getByRole('tab', { name: '容器', exact: true }).click();
    await frame.locator(`[data-ops-target="${'a'.repeat(64)}"]`).waitFor();
    await measure();
    assert.equal(await frame.getByRole('button', { name: '重启全部容器', exact: true }).count(), 0);
    const restart = frame
      .locator(`[data-ops-target="${'a'.repeat(64)}"]`)
      .getByRole('button', { name: '重启', exact: true });
    await restart.click();
    await frame.getByText('请求完成，请核对刷新后的目标状态。', { exact: true }).waitFor();
    const singleRestart = await page.evaluate(() => window.fixture.actions.at(-1));
    assert.deepEqual(singleRestart.request, {
      kind: 'container_action',
      id: 'a'.repeat(64),
      action: 'restart',
      confirmed: true,
    });
    assert.equal(singleRestart.confirmation.title, '重启容器？');
    assert(singleRestart.confirmation.message.includes('production-web'));
    await frame.getByRole('textbox', { name: '运维项目搜索' }).fill('production-web');
    for (const [label, action] of [
      ['清空容器日志', 'clear_logs'],
      ['重启已退出容器', 'restart_exited'],
    ]) {
      const button = frame.getByRole('button', { name: label, exact: true });
      await button.click();
      await frame
        .getByText('匹配 2 个，成功 2 个，失败 0 个，跳过 0 个。', { exact: true })
        .waitFor();
      const request = await page.evaluate(() => window.fixture.actions.at(-1));
      assert.equal(request.request.kind, 'container_maintenance');
      assert.equal(request.request.action, action);
      assert.equal(request.confirmation.title, `${label}？`);
      assert(request.confirmation.message.includes('不受列表搜索条件影响'));
      await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width + 1);
    }
    await measure();
    await page.screenshot({ path: `${output}/maintenance-${width}-${theme}.png` });
    await frame
      .locator(`[data-ops-target="${'a'.repeat(64)}"]`)
      .getByRole('button', { name: '日志', exact: true })
      .click();
    const logs = frame.getByRole('dialog', { name: 'production-web', exact: true });
    const logOutput = logs.locator('.platform-stream-output');
    await logOutput.getByText('CONTAINER_LOG_0200', { exact: false }).waitFor();
    const plugin = page.frames()[1];
    const assertLatest = async (stage = 'latest') => {
      try {
        await plugin.waitForFunction(
          () => {
            const el = document.querySelector('.platform-stream-output');
            return (
              el &&
              el.scrollHeight > el.clientHeight &&
              el.scrollHeight - el.clientHeight - el.scrollTop <= 2
            );
          },
          undefined,
          { timeout: 5000 },
        );
      } catch (error) {
        await writeFile(
          `${output}/log-follow-failure-${width}-${theme}.json`,
          JSON.stringify(
            {
              stage,
              geometry: await logOutput.evaluate((element) => ({
                top: element.scrollTop,
                height: element.scrollHeight,
                client: element.clientHeight,
                status: element
                  .closest('.platform-stream-dialog')
                  .querySelector('[role="status"]')
                  .textContent.trim(),
                filter: element.closest('.platform-stream-dialog').querySelector('input').value,
                length: element.textContent.length,
              })),
            },
            null,
            2,
          ),
        );
        await page.screenshot({ path: `${output}/log-follow-failure-${width}-${theme}.png` });
        throw error;
      }
    };
    await assertLatest();
    const appendLog = async (line) =>
      page.evaluate((line) => {
        window.fixture.containerLogs.push({
          type: 'data',
          stream: 'stdout',
          dataBase64: btoa(`${line}\n`),
        });
      }, line);
    await appendLog('CONTAINER_LIVE_0201');
    await logOutput.getByText('CONTAINER_LIVE_0201', { exact: false }).waitFor();
    await assertLatest();
    await logOutput.hover();
    await page.mouse.wheel(0, -600);
    await logs.getByText('查看历史 · 新日志继续接收', { exact: true }).waitFor();
    await logOutput.evaluate((el) => {
      el.scrollTop = 0;
    });
    await logs.getByText('查看历史 · 新日志继续接收', { exact: true }).waitFor();
    await appendLog('CONTAINER_LIVE_0202');
    await logOutput.getByText('CONTAINER_LIVE_0202', { exact: false }).waitFor();
    assert.equal(await logOutput.evaluate((el) => el.scrollTop), 0);
    await logOutput.evaluate((element) => {
      element.scrollTop = 200;
    });
    await logs.getByRole('textbox', { name: '过滤输出' }).fill('no-match-fixture');
    await logOutput.getByText('没有匹配的日志。', { exact: true }).waitFor();
    await logs.getByText('查看历史 · 新日志继续接收', { exact: true }).waitFor();
    await logs.getByRole('textbox', { name: '过滤输出' }).fill('');
    await logOutput.getByText('CONTAINER_LIVE_0202', { exact: false }).waitFor();
    await plugin.waitForFunction(() => {
      const output = document.querySelector('.platform-stream-output');
      return (
        output.scrollTop === 0 &&
        output
          .closest('.platform-stream-dialog')
          .querySelector('[role="status"]')
          .textContent.includes('查看历史')
      );
    });
    await logs.getByRole('button', { name: '最新日志', exact: true }).click();
    await assertLatest();
    await logs.getByRole('button', { name: '暂停', exact: true }).click();
    await logs.getByText('已暂停', { exact: true }).waitFor();
    await logOutput.evaluate((element) => {
      element.scrollTop = 100;
    });
    await logs.getByRole('textbox', { name: '过滤输出' }).fill('CONTAINER_LOG_');
    assert.equal(await logOutput.evaluate((element) => element.scrollTop), 100);
    await logs.getByRole('textbox', { name: '过滤输出' }).fill('');
    assert.equal(await logOutput.evaluate((element) => element.scrollTop), 100);
    await appendLog('CONTAINER_RESUMED_0203');
    await logs.getByRole('button', { name: '继续', exact: true }).click();
    await logOutput.getByText('CONTAINER_RESUMED_0203', { exact: false }).waitFor();
    await assertLatest();
    await logs.getByRole('textbox', { name: '过滤输出' }).fill('CONTAINER_LOG_');
    await assertLatest('filter-long');
    assert.equal((await logOutput.textContent()).includes('CONTAINER_LIVE'), false);
    await logs.getByRole('textbox', { name: '过滤输出' }).fill('no-match-fixture');
    await logOutput.getByText('没有匹配的日志。', { exact: true }).waitFor();
    await logs.getByRole('textbox', { name: '过滤输出' }).fill('');
    await assertLatest('clear-empty-filter');
    await logs.getByRole('textbox', { name: '过滤输出' }).fill('CONTAINER_LIVE_');
    await logOutput.getByText('CONTAINER_LIVE_0202', { exact: false }).waitFor();
    await logs.getByText('实时跟踪 · 自动滚动到最新', { exact: true }).waitFor();
    await logs.getByRole('textbox', { name: '过滤输出' }).fill('');
    await assertLatest('clear-short-filter');
    await plugin.evaluate(
      (value) =>
        document.documentElement.style.setProperty('--interface-font-scale', String(value)),
      scale === 1 ? 1.45 : 1,
    );
    await assertLatest('font-scale');
    await plugin.evaluate(
      (value) =>
        document.documentElement.style.setProperty('--interface-font-scale', String(value)),
      scale,
    );
    await assertLatest('restore-font-scale');
    await page.setViewportSize({ width: 800, height });
    await assertLatest('narrow-window');
    await page.setViewportSize({ width, height });
    await assertLatest('restore-width');
    await page.setViewportSize({ width, height: 500 });
    await assertLatest('short-window');
    await page.setViewportSize({ width, height });
    await assertLatest();
    const logGeometry = await logs.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        outerOverflow: el.scrollHeight > el.clientHeight + 1,
      };
    });
    assert(
      !logGeometry.outerOverflow &&
        logGeometry.x >= 0 &&
        logGeometry.y >= 0 &&
        logGeometry.x + logGeometry.width <= width + 1 &&
        logGeometry.y + logGeometry.height <= height + 1,
    );
    await page.screenshot({ path: `${output}/container-logs-${width}-${theme}.png` });
    await frame.getByRole('button', { name: '关闭对话框' }).click();
    await page.waitForFunction(() => window.fixture.stopped.includes('container-log'));
    await checkDetails();
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
