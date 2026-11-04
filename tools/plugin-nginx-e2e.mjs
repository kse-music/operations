import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import http from 'node:http';
import {
  navigateWorkspace,
  previewPluginPackage,
  openPluginSettings,
  setPluginEnabled,
} from './ui-navigation.mjs';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const id = 'dev.serverdeck.nginx-manager';
export async function nginxChecks({ page, invoke, root, hostId, credentialId, artifacts, passed }) {
  const container = process.env.SERVERDECK_PLUGIN_TEST_CONTAINER_ID;
  function httpHeaders() {
    return new Promise((resolve, reject) => {
      const request = http.get(
        {
          hostname: '127.0.0.1',
          port: Number(process.env.SERVERDECK_PLUGIN_TEST_HTTP_PORT),
          path: '/',
          agent: false,
          timeout: 4000,
        },
        (response) => {
          response.resume();
          if (response.statusCode !== 200) reject(new Error(`fixture HTTP ${response.statusCode}`));
          else resolve(response.headers);
        },
      );
      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('fixture HTTP timeout')));
    });
  }
  assert(/^[a-f0-9]{64}$/.test(container));
  function docker(args, input) {
    const r = spawnSync(
      'wsl.exe',
      [
        '--distribution',
        process.env.SERVERDECK_PLUGIN_TEST_DISTRO ?? 'Ubuntu-24.04',
        '--exec',
        'docker',
        ...args,
      ],
      { encoding: 'utf8', input, windowsHide: true },
    );
    if (r.error) throw r.error;
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  }
  assert.equal(
    docker(['inspect', '--format', '{{index .Config.Labels "io.serverdeck.qa"}}', container]),
    'plugin-13a',
  );
  const fixture = (code, input = '') =>
    docker(['exec', '--interactive', '--user', 'plugin', container, 'python3', '-c', code], input);
  async function install(packagePath) {
    await navigateWorkspace(page, '插件管理');
    const manager = page.locator('.plugin-manager');
    const preview = await previewPluginPackage(page, packagePath);
    await preview.getByRole('checkbox').check();
    await preview.locator('.dialog-actions .primary').click();
    const upgrade = page.getByRole('dialog', { name: '升级插件？', exact: true });
    if (await upgrade.isVisible())
      await upgrade.getByRole('button', { name: '明确确认', exact: true }).click();
    await preview.waitFor({ state: 'hidden' });
  }
  const card = page.locator(`.plugin-installed-row[data-plugin-id="${id}"]`),
    view = page.locator('.plugin-workspace');
  async function grant() {
    const modal = await openPluginSettings(page, 'Nginx Manager');
    for (const p of ['hosts.read', 'ssh.execute', 'sftp.read', 'sftp.write', 'ui.contribute'])
      await modal.getByLabel(p, { exact: true }).check();
    await modal.getByLabel('允许请求其他命令（仍逐次确认）', { exact: true }).check();
    await modal.getByLabel('插件可读目录', { exact: true }).fill('/home/plugin/nginx');
    await modal.getByLabel('插件可写目录', { exact: true }).fill('/home/plugin/nginx');
    await modal.getByRole('button', { name: '保存并授权', exact: true }).click();
    await modal.getByText('已授权', { exact: true }).waitFor();
    await navigateWorkspace(page, '插件管理');
  }
  async function open() {
    await page.locator('.module-navigation [data-module="plugins"]').click();
    await page
      .locator('[aria-label="运维工具导航"]')
      .getByRole('button', { name: 'Nginx Manager', exact: true })
      .click();
    const back = page.getByRole('button', { name: '返回功能', exact: true });
    if (await back.isVisible()) await back.click();
    await view.waitFor();
    await view.getByLabel('插件目标主机', { exact: true }).selectOption(hostId);
    await view.getByRole('button', { name: '连接 SSH / SFTP', exact: true }).click();
    for (let n = 0; n < 150; n++) {
      const trust = page.getByRole('dialog', { name: '核验 SSH 主机指纹', exact: true });
      if (await trust.isVisible()) {
        const expected =
          'SHA256:' +
          createHash('sha256')
            .update(
              Buffer.from(process.env.SERVERDECK_PLUGIN_TEST_HOST_KEY.split(/\s+/)[1], 'base64'),
            )
            .digest('base64')
            .replace(/=+$/, '');
        assert((await trust.textContent()).includes(expected));
        await trust.getByRole('button', { name: '已核对，信任并连接', exact: true }).click();
      }
      if (await view.locator('.plugin-context').filter({ hasText: 'connected connected' }).count())
        break;
      await delay(100);
    }
    const connections = await invoke('files_connections');
    assert(connections.some((c) => c.hostId === hostId));
  }
  const read = '读取配置',
    save = '保存配置（单次确认）',
    validate = '验证磁盘配置 nginx -t',
    reload = '重载（重新验证并单次确认）';
  async function action(name, { approve = true, expectedCommand } = {}) {
    // A confirmed multi-step SDK action can consume up to 18 VM messages.
    // Pace independent human actions within the public 20 messages/second quota.
    await delay(1100);
    process.stdout.write(`Nginx UI action: ${name}\n`);
    const button = view.getByRole('button', { name, exact: true });
    await button.click();
    let confirmations = 0;
    for (let n = 0; n < 350; n++) {
      const dialogs = page.getByRole('dialog');
      if (await dialogs.count()) {
        const modal = dialogs.last();
        const title = (await modal.getByRole('heading').textContent()) ?? '';
        assert(/插件操作需要单独确认|放弃未保存/.test(title), `unexpected action modal ${title}`);
        const text = await modal.textContent();
        if (expectedCommand)
          assert(
            text.includes(expectedCommand),
            `approval omitted exact command ${expectedCommand}`,
          );
        assert(!/sudo /.test(text));
        await modal
          .getByRole('button', { name: approve ? '明确确认' : '取消', exact: true })
          .click();
        confirmations++;
      }
      if (!(await view.getByRole('button', { name: '取消调用', exact: true }).isVisible()))
        return confirmations;
      await delay(100);
    }
    throw new Error(`Nginx action did not finish: ${name}`);
  }
  const output = async () =>
    JSON.parse(await view.locator(':scope > .plugin-output').textContent());
  const config = view.getByLabel('配置内容', { exact: true });
  await install(path.join(root, '.local', 'plugin-13a', 'nginx-manager.sdplugin'));
  await card.waitFor();
  await grant();
  await setPluginEnabled(page, 'Nginx Manager', true);
  await open();
  await action('检测 Nginx / 版本 / 服务');
  let report = await output();
  assert.equal(report.detection.binaryProbe.exitCode, 0);
  assert((report.detection.version.stderr + report.detection.version.stdout).includes('nginx/'));
  assert(report.detection.serviceStatus.exitCode !== null);
  assert((await view.getByLabel('配置文件路径', { exact: true }).inputValue()).startsWith('/'));
  passed.push(
    'independent public SDK package installs/grants/registers; real Linux detection/version/config path and honest non-systemd status',
  );
  await view.getByLabel('运行前缀（自定义安装）', { exact: true }).fill('/home/plugin/nginx/');
  await view.getByLabel('配置文件路径', { exact: true }).fill('/home/plugin/nginx/nginx.conf');
  await view.getByLabel('日志文件路径', { exact: true }).fill('/home/plugin/nginx/logs/error.log');
  await action(read);
  const original = await config.inputValue();
  assert(original.includes('worker_processes 1;'));
  assert(await view.getByRole('button', { name: reload, exact: true }).isDisabled());
  const marker = 'plugin13a-' + randomUUID();
  const good = original.replace('http {', `http {\n  add_header X-ServerDeck-Plugin ${marker};`);
  await config.fill(good + '\ninvalid_serverdeck_directive on;\n');
  assert.equal(await action(save), 1);
  assert.equal((await output()).saved, true);
  assert.equal(await action(validate, { expectedCommand: ' -t' }), 1);
  report = await output();
  assert.equal(report.success, false);
  assert.notEqual(report.commandResult.exitCode, 0);
  assert(report.commandResult.stderr.includes('unknown directive'));
  assert(await view.getByRole('button', { name: reload, exact: true }).isDisabled());
  passed.push(
    'real authorized atomic SFTP save and nginx -t failure retains stderr/nonzero status and blocks reload',
  );
  await config.fill(good);
  await action(save);
  await action(validate, { expectedCommand: ' -t' });
  report = await output();
  assert.equal(report.success, true);
  assert.equal(report.commandResult.exitCode, 0);
  fixture(
    "from pathlib import Path\np=Path('/home/plugin/nginx/nginx.conf')\np.write_text(p.read_text()+'\\n# external before reload\\n')",
  );
  assert.equal(await action(reload), 0);
  report = await output();
  assert(report.error.includes('changed since validation'));
  assert.equal((await httpHeaders())['x-serverdeck-plugin'], undefined);
  await action(read);
  await action(validate, { expectedCommand: ' -t' });
  assert.equal(await action(reload, { expectedCommand: ' -s reload' }), 1);
  report = await output();
  assert.equal(report.success, true);
  let header;
  for (let n = 0; n < 80; n++) {
    header = (await httpHeaders())['x-serverdeck-plugin'];
    if (header === marker) break;
    await delay(100);
  }
  assert.equal(header, marker, 'real reloaded Nginx must serve the new header');
  passed.push(
    'hash change rejects stale reload; explicit approval reruns nginx -t then reloads, verified by real HTTP behavior',
  );
  const before = await config.inputValue();
  await config.fill(before + '\n# local conflicting edit\n');
  fixture(
    "from pathlib import Path\np=Path('/home/plugin/nginx/nginx.conf')\np.write_text(p.read_text()+'\\n# concurrent external edit\\n')",
  );
  await action(save);
  assert((await config.inputValue()).includes('local conflicting edit'));
  const remote = fixture(
    "from pathlib import Path\nprint(Path('/home/plugin/nginx/nginx.conf').read_text())",
  );
  assert(remote.includes('concurrent external edit') && !remote.includes('local conflicting edit'));
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('plugins')
          .dirtyCount,
    ),
    1,
  );
  const closing = page.getByRole('button', { name: /关闭工作区标签 Nginx Manager/ });
  await closing.click();
  const discard = page.getByRole('dialog', { name: '放弃未保存的插件编辑？', exact: true });
  await discard.getByRole('button', { name: '取消', exact: true }).click();
  assert(await view.isVisible());
  await action(read);
  assert(!(await config.inputValue()).includes('local conflicting edit'));
  passed.push(
    'external SFTP conflict preserves remote changes and local draft; dirty close can be cancelled and reread requires discard',
  );
  fixture(
    "from pathlib import Path\nwith Path('/home/plugin/nginx/logs/error.log').open('a') as f:f.write('SERVERDECK_LOG_INITIAL\\n')",
  );
  await action('开始日志');
  await view.locator('.plugin-log pre').filter({ hasText: 'SERVERDECK_LOG_INITIAL' }).waitFor();
  await view.getByLabel('搜索插件日志', { exact: true }).fill('SERVERDECK_LOG');
  await view.getByRole('button', { name: '暂停', exact: true }).click();
  await view.getByRole('button', { name: '继续', exact: true }).waitFor();
  fixture(
    "from pathlib import Path\nwith Path('/home/plugin/nginx/logs/error.log').open('a') as f:f.write('SERVERDECK_LOG_RESUMED\\n')",
  );
  await delay(700);
  assert(!(await view.locator('.plugin-log pre').textContent()).includes('SERVERDECK_LOG_RESUMED'));
  await view.getByRole('button', { name: '继续', exact: true }).click();
  await view.locator('.plugin-log pre').filter({ hasText: 'SERVERDECK_LOG_RESUMED' }).waitFor();
  await view.getByRole('button', { name: '取消日志', exact: true }).click();
  await view.locator('.plugin-log').filter({ hasText: 'closed' }).waitFor();
  passed.push('real bounded Nginx log stream with search, pause/resume and cancellation');
  const other = (
    await invoke('host_create', {
      input: {
        name: 'Other current host QA',
        hostname: '127.0.0.1',
        port: Number(process.env.SERVERDECK_PLUGIN_TEST_PORT),
        username: 'plugin',
        authType: 'password',
        credentialId,
        groupId: null,
        tags: [],
        description: 'Current host without a connection fixture',
        favorite: false,
        connectTimeoutSecs: 10,
      },
    })
  ).id;
  await invoke('plugin_context', {
    id,
    input: { hostId: other, opsSession: null, fileSession: null },
  });
  const metadata = await invoke('plugin_capability', {
    id,
    request: { apiVersion: 1, requestId: 'other-current-host', operation: { kind: 'hosts_read' } },
  });
  assert.equal(metadata.error, null);
  assert.equal(metadata.result.id, other);
  const denied = await invoke('plugin_call', { id, payload: { action: 'detect', values: {} } });
  assert.equal(denied.error.code, 'PLUGIN_SESSION_CLOSED');
  await invoke('host_delete', { id: other });
  const files = (await invoke('files_connections')).find((c) => c.hostId === hostId);
  await invoke('files_close', { id: files.id, cancel: false });
  const ops = (await invoke('ops_connections')).find((c) => c.hostId === hostId);
  await invoke('plugin_context', { id, input: { hostId, opsSession: ops.id, fileSession: null } });
  const closed = await invoke('plugin_capability', {
    id,
    request: {
      apiVersion: 1,
      requestId: 'closed-lease',
      operation: { kind: 'read_file', path: '/home/plugin/nginx/nginx.conf' },
    },
  });
  assert.equal(closed.error.code, 'PLUGIN_SESSION_CLOSED');
  passed.push(
    'another current host is allowed without a whitelist; missing/closed leases fail rather than executing on another target',
  );
  await setPluginEnabled(page, 'Nginx Manager', false);
  assert.equal(await page.locator('[aria-label="运维工具导航"] [data-plugin-id]').count(), 1);
  assert.equal(await page.locator('[aria-label="运维工具导航"] .plugin-source').count(), 0);
  const upgraded = JSON.parse(
    await readFile(path.join(root, '.local', 'plugin-13a', 'nginx-manager.sdplugin'), 'utf8'),
  );
  upgraded.manifest.version = '1.1.0';
  upgraded.manifest.permissions.push('settings.read');
  const upgradePath = path.join(artifacts, 'nginx-manager-1.1.sdplugin');
  await writeFile(upgradePath, JSON.stringify(upgraded));
  await install(upgradePath);
  const record = await invoke('plugin_detail', { id });
  assert.equal(record.manifest.version, '1.1.0');
  assert.equal(record.previousVersion, '1.0.0');
  assert.equal(record.enabled, false);
  assert.equal(await invoke('plugin_permissions', { id }), null);
  assert.equal(await page.locator('[aria-label="运维工具导航"] [data-plugin-id]').count(), 1);
  assert.equal(await page.locator('[aria-label="运维工具导航"] .plugin-source').count(), 0);
  await grant();
  await setPluginEnabled(page, 'Nginx Manager', true);
  await page
    .locator('[aria-label="运维工具导航"] [data-plugin-id]')
    .getByText('Nginx Manager', { exact: true })
    .waitFor();
  const ownSettings = await openPluginSettings(page, 'Nginx Manager');
  await ownSettings.getByRole('button', { name: '撤销授权', exact: true }).click();
  await page
    .getByRole('dialog', { name: '撤销插件授权？', exact: true })
    .getByRole('button', { name: '明确确认', exact: true })
    .click();
  await ownSettings
    .getByRole('button', { name: '撤销授权', exact: true })
    .waitFor({ state: 'hidden' });
  await navigateWorkspace(page, '插件管理');
  assert.equal(await page.locator('[aria-label="运维工具导航"] [data-plugin-id]').count(), 1);
  assert.equal(await page.locator('[aria-label="运维工具导航"] .plugin-source').count(), 0);
  await invoke('plugin_context', { id, input: { hostId, opsSession: null, fileSession: null } });
  const revoked = await invoke('plugin_capability', {
    id,
    request: { apiVersion: 1, requestId: 'revoked', operation: { kind: 'hosts_read' } },
  });
  assert.equal(revoked.error.code, 'PLUGIN_PERMISSION_DENIED');
  await card.getByRole('button', { name: '卸载 Nginx Manager', exact: true }).click();
  const uninstall = page.getByRole('dialog', { name: '卸载插件？', exact: true });
  assert.equal(await uninstall.getByRole('checkbox').isChecked(), false);
  await uninstall.getByRole('button', { name: '确认卸载', exact: true }).click();
  await card.waitFor({ state: 'hidden' });
  assert.equal((await invoke('plugin_list')).length, 0);
  assert(
    fixture(
      "from pathlib import Path\np=Path('/home/plugin/nginx/nginx.conf')\nassert p.is_file() and Path('/home/plugin/nginx/logs/error.log').is_file()\nprint(p.read_text())",
    ).includes(marker),
  );
  assert.equal((await httpHeaders())['x-serverdeck-plugin'], marker);
  passed.push(
    'disable -> upgrade with added permission -> regrant/enable -> revoke -> uninstall; server config/logs/service retained',
  );
  await page.screenshot({ path: path.join(artifacts, 'nginx-finished.png') });
}
