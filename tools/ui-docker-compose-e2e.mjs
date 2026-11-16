// Layout/interaction fixtures only: production Docker frontend and SDK MessageChannel.
// Real Compose/Wasm commands are tested separately by docker_compose_live_project_lifecycle.
/* global Buffer, process, window, document, MessageChannel, btoa, innerWidth, console */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// --details and --services isolate container and Compose service detail layout checks.
const detailsOnly = process.argv.includes('--details');
const servicesOnly = process.argv.includes('--services');
const output = process.env.SERVERDECK_DOCKER_UI_OUTPUT ?? '.local/qa/compose/ui';
await mkdir(output, { recursive: true });
const pkg = JSON.parse(
  await readFile(
    process.env.SERVERDECK_DOCKER_UI_PACKAGE ?? 'plugins/system/packages/docker.sdplugin',
    'utf8',
  ),
);
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
    [2361, servicesOnly ? 1400 : 900, 1, 'dark'],
    [1280, 820, 1, 'dark'],
    [960, 600, 1.45, 'light'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.evaluate(
      ({ scale, theme }) => {
        window.fixture = {
          mode: 'normal',
          actions: [],
          stopped: [],
          state: 'running(2)',
          serviceCount: 2,
          queries: [],
        };
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
              if (args.action === 'query') window.fixture.queries.push(request);
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
                            services: Array.from(
                              { length: window.fixture.serviceCount },
                              (_, index) => {
                                const service = ['web', 'worker'][index] ?? `service-${index}`;
                                return {
                                  ID: service,
                                  Name: `/shop-production-${service}-1`,
                                  Service: service,
                                  Image: `registry.example.com/application/${service}:stable`,
                                  State:
                                    ['running', 'exited', 'exited', 'created'][index] ?? 'running',
                                  ExitCode: index === 2 ? 137 : 0,
                                };
                              },
                            ),
                          }
                        : request.kind === 'container_details'
                          ? {
                              id: request.id,
                              name: '/production-web',
                              image: 'nginx:stable',
                              environment: request.revealEnv ? ['TOKEN=ENV_FIXTURE_SECRET'] : [],
                              environmentRevealed: request.revealEnv,
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
      const open = () =>
        frame
          .locator(`[data-ops-target="${'a'.repeat(64)}"]`)
          .getByRole('button', { name: '详情', exact: true })
          .click();
      await open();
      const detail = frame.getByRole('dialog', { name: '容器详情', exact: true });
      const summary = (label) =>
        detail.locator('summary').filter({ hasText: new RegExp('^' + label + '$') });
      const isOpen = (label) => summary(label).evaluate((element) => element.parentElement.open);
      const panel = detail.locator('.docker-detail-panel');
      const queryCounts = () =>
        page.evaluate(() => ({
          startup: window.fixture.queries.filter((request) => request.kind === 'container_startup')
            .length,
          environment: window.fixture.queries.filter(
            (request) => request.kind === 'container_details' && request.revealEnv,
          ).length,
        }));
      await summary('概览').waitFor();
      assert.deepEqual(
        (await detail.locator('summary').allTextContents()).map((label) => label.trim()),
        ['概览', '启动配置', '环境变量'],
      );
      assert.equal(await isOpen('概览'), true);
      assert.equal(await isOpen('启动配置'), false);
      assert.equal(await isOpen('环境变量'), false);
      assert.equal(await detail.locator('[role="tab"], [role="tablist"]').count(), 0);
      await page.screenshot({ path: `${output}/overview-${width}-${theme}.png` });
      await summary('启动配置').focus();
      await summary('启动配置').press('Enter');
      const yaml = detail.getByLabel('Compose 启动配置');
      await yaml.getByText('read_only: true', { exact: false }).waitFor();
      assert.equal(await isOpen('概览'), true);
      assert((await yaml.textContent()).includes('published: "8080"'));
      assert((await yaml.textContent()).includes('/srv/业务系统/production deployment/html'));
      await panel.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await detail.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const scrollGeometry = await detail.evaluate((element) => {
        const close = element.querySelector('[aria-label="关闭对话框"]').getBoundingClientRect();
        const panel = element.querySelector('.docker-detail-panel');
        const box = element.getBoundingClientRect();
        return {
          outerScroll: element.scrollTop,
          panelScroll: panel.scrollTop,
          closeTop: close.top,
          closeBottom: close.bottom,
          boxTop: box.top,
          boxBottom: box.bottom,
          outerOverflow: element.scrollWidth > element.clientWidth + 1,
        };
      });
      await page.screenshot({ path: `${output}/startup-scrolled-${width}-${theme}.png` });
      assert.equal(scrollGeometry.outerScroll, 0, '详情弹窗自身不应滚动');
      assert(scrollGeometry.panelScroll > 0, '折叠分组内容区应当可以独立滚动');
      assert.equal(scrollGeometry.outerOverflow, false);
      assert(
        scrollGeometry.closeTop >= scrollGeometry.boxTop &&
          scrollGeometry.closeBottom <= scrollGeometry.boxBottom,
      );
      await detail.getByRole('button', { name: '关闭对话框' }).click();
      await detail.waitFor({ state: 'detached' });
      await open();
      await summary('概览').waitFor();
      assert.equal(await isOpen('启动配置'), false);
      assert.equal(await isOpen('环境变量'), false);
      assert(!(await detail.textContent()).includes('CONFIG_FIXTURE_SECRET'));
      await summary('启动配置').click();
      await yaml.getByText('CONFIG_FIXTURE_SECRET', { exact: false }).waitFor();
      assert.equal(
        await detail.getByRole('button', { name: '查看环境变量值', exact: true }).count(),
        0,
      );
      assert.equal(
        await detail.getByRole('button', { name: '隐藏环境变量值', exact: true }).count(),
        0,
      );
      await summary('环境变量').focus();
      await summary('环境变量').press('Space');
      await detail.getByText('ENV_FIXTURE_SECRET', { exact: true }).waitFor();
      await detail.getByText('ENV_FIXTURE_SECRET', { exact: true }).scrollIntoViewIfNeeded();
      assert.equal(await isOpen('启动配置'), true);
      assert.equal(await isOpen('概览'), true);
      const configBounds = await detail.boundingBox();
      assert(
        configBounds &&
          configBounds.x >= 0 &&
          configBounds.y >= 0 &&
          configBounds.x + configBounds.width <= width + 1 &&
          configBounds.y + configBounds.height <= height + 1,
      );
      await measure();
      await page.screenshot({ path: `${output}/expanded-${width}-${theme}.png` });
      const loadedCounts = await queryCounts();
      await summary('启动配置').click();
      await yaml.waitFor({ state: 'hidden' });
      assert((await yaml.textContent()).includes('CONFIG_FIXTURE_SECRET'));
      assert(await detail.getByText('ENV_FIXTURE_SECRET', { exact: true }).isVisible());
      await summary('环境变量').click();
      await detail.getByText('ENV_FIXTURE_SECRET', { exact: true }).waitFor({ state: 'hidden' });
      await page.evaluate(() => {
        window.fixture.mode = 'config-error';
      });
      for (let repeat = 0; repeat < 2; repeat++) {
        await summary('启动配置').click();
        await yaml.waitFor();
        await summary('启动配置').click();
        await yaml.waitFor({ state: 'hidden' });
        await summary('环境变量').click();
        await detail.getByText('ENV_FIXTURE_SECRET', { exact: true }).waitFor();
        await summary('环境变量').click();
        await detail.getByText('ENV_FIXTURE_SECRET', { exact: true }).waitFor({ state: 'hidden' });
      }
      assert.deepEqual(await queryCounts(), loadedCounts, '折叠和展开不得重复读取');
      await detail.getByRole('button', { name: '关闭对话框' }).click();
      await detail.waitFor({ state: 'detached' });
      assert(!(await frame.locator('body').textContent()).includes('CONFIG_FIXTURE_SECRET'));
      assert(!(await frame.locator('body').textContent()).includes('ENV_FIXTURE_SECRET'));
      await open();
      await summary('概览').waitFor();
      await summary('启动配置').click();
      await detail
        .getByRole('alert')
        .getByText('Compose 配置文件不存在', { exact: false })
        .waitFor();
      const failedCounts = await queryCounts();
      await summary('启动配置').click();
      await summary('启动配置').click();
      await detail
        .getByRole('alert')
        .getByText('Compose 配置文件不存在', { exact: false })
        .waitFor();
      assert.deepEqual(await queryCounts(), failedCounts, '失败仅通过显式重试重新读取');
      await detail.getByRole('button', { name: '使用容器信息转换', exact: true }).click();
      await detail.getByText('容器信息转换 · Compose 格式', { exact: true }).waitFor();
      await yaml.waitFor();
      await detail.getByRole('button', { name: '关闭对话框' }).click();
      await page.evaluate(() => {
        window.fixture.mode = 'normal';
      });
    };
    if (servicesOnly) {
      const sizes = {};
      for (const count of [0, 2, 18, 60]) {
        await page.evaluate((count) => {
          window.fixture.serviceCount = count;
        }, count);
        await frame.getByRole('button', { name: '服务', exact: true }).click();
        const detail = frame.getByRole('dialog', {
          name: 'shop-production · 服务状态',
          exact: true,
        });
        await detail.locator('.ops-detail-content > div').waitFor();
        assert.equal(await detail.locator('tbody tr').count(), count);
        if (count >= 2) {
          const states = await detail
            .locator('tbody tr')
            .evaluateAll((rows) =>
              rows
                .slice(0, 2)
                .map((row) =>
                  [...row.querySelectorAll('td')].slice(3).map((cell) => cell.textContent),
                ),
            );
          assert.deepEqual(states, [
            ['运行中', '尚未退出'],
            ['已退出', '正常结束'],
          ]);
        }
        if (count >= 18) {
          assert.equal(
            await detail.locator('tbody tr').nth(2).locator('td').last().textContent(),
            '异常退出（退出码 137）',
          );
          assert.equal(
            await detail.locator('tbody tr').nth(3).locator('td').last().textContent(),
            '尚未启动',
          );
        }
        const geometry = await detail.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const content = element.querySelector('.ops-detail-content').firstElementChild;
          const note = content.lastElementChild.getBoundingClientRect();
          const table = content.querySelector('.ops-table');
          const tableBox = table?.getBoundingClientRect();
          return {
            top: box.top,
            bottom: box.bottom,
            height: box.height,
            outerOverflow: element.scrollHeight > element.clientHeight + 1,
            contentOverflow: content.scrollHeight > content.clientHeight + 1,
            horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
            bottomGap: box.bottom - note.bottom,
            contentWidth: content.getBoundingClientRect().width,
            availableWidth: content.parentElement.clientWidth,
            tableHeight: tableBox?.height ?? 0,
            tableOverflow: !!table && table.scrollHeight > table.clientHeight + 1,
            viewportHeight: window.innerHeight,
          };
        });
        assert(geometry.top >= 0 && geometry.bottom <= height + 1);
        assert.equal(geometry.outerOverflow, false, JSON.stringify(geometry));
        assert.equal(geometry.contentOverflow, false, JSON.stringify(geometry));
        assert.equal(geometry.horizontalOverflow, false, JSON.stringify(geometry));
        assert(
          Math.abs(geometry.contentWidth - geometry.availableWidth) <= 1,
          JSON.stringify(geometry),
        );
        assert(geometry.bottomGap <= 26, `Unused space below note: ${JSON.stringify(geometry)}`);
        if (count <= 2) {
          assert.equal(geometry.tableOverflow, false);
          assert(geometry.height < height * 0.8, JSON.stringify(geometry));
        } else if (geometry.tableOverflow) {
          assert(
            geometry.height >= height - 62,
            `Table scrolls before using viewport: ${JSON.stringify(geometry)}`,
          );
        }
        if (count === 60) {
          assert.equal(geometry.tableOverflow, true);
          const table = detail.locator('.ops-table');
          await table.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          const scrolled = await detail.evaluate((element) => {
            const table = element.querySelector('.ops-table');
            const box = table.getBoundingClientRect();
            const heading = table.querySelector('thead th').getBoundingClientRect();
            const last = table.querySelector('tbody tr:last-child').getBoundingClientRect();
            const close = element
              .querySelector('[aria-label="关闭对话框"]')
              .getBoundingClientRect();
            return {
              outerScroll: element.scrollTop,
              tableScroll: table.scrollTop,
              headerVisible: heading.top >= box.top - 1 && heading.bottom <= box.bottom + 1,
              lastVisible: last.bottom <= box.bottom + 1 && last.top >= box.top,
              closeVisible: close.top >= 0 && close.bottom <= window.innerHeight,
            };
          });
          assert.equal(scrolled.outerScroll, 0);
          assert(
            scrolled.tableScroll > 0 &&
              scrolled.headerVisible &&
              scrolled.lastVisible &&
              scrolled.closeVisible,
          );
        }
        sizes[count] = geometry;
        await page.screenshot({ path: `${output}/services-${count}-${width}-${theme}.png` });
        await detail.getByRole('button', { name: '关闭对话框' }).click();
      }
      assert(sizes[18].tableHeight > sizes[2].tableHeight);
      assert.deepEqual(errors, []);
      results.push({ width, height, scale, theme, scope: 'services', sizes, passed: true });
      await page.close();
      continue;
    }
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
    const summary = frame.getByRole('region', { name: 'Docker 全局统计' });
    await summary.getByText('27.5.1', { exact: true }).waitFor();
    assert.deepEqual(await summary.locator('article > div > span').allTextContents(), [
      'Docker 版本',
      '本地镜像',
      '运行容器',
      'Compose 配置',
    ]);
    assert.equal(await frame.getByRole('button', { name: 'Docker信息', exact: true }).count(), 0);
    assert.equal(await frame.locator('.ops-capabilities').count(), 0);
    assert.equal((await summary.textContent()).includes('UNNEEDED_DETAILS'), false);
    await page.screenshot({ path: `${output}/summary-${width}-${theme}.png` });
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
