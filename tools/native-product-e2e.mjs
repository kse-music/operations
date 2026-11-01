import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export async function createProductHost(page, target, credentialId, description) {
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.locator('main').getByRole('button', { name: '＋ 新建主机', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建主机', exact: true });
  await dialog.getByLabel('主机名称', { exact: true }).fill('Linux SSH verification');
  await dialog.getByLabel('地址（IP / 域名）', { exact: true }).fill(target.hostname);
  await dialog.getByLabel('用户名', { exact: true }).fill(target.username);
  await dialog.getByLabel('认证方式', { exact: true }).selectOption('password');
  await dialog.getByLabel('安全凭据引用', { exact: true }).selectOption(credentialId);
  await dialog.getByLabel('备注', { exact: true }).fill(description);
  await dialog.getByRole('button', { name: '保存主机', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  return page.evaluate(async (description) => {
    const c = await window.__TAURI_INTERNALS__.invoke('host_list');
    const h = c.hosts.find((h) => h.description === description);
    if (!h) throw new Error('created host not persisted');
    return h.id;
  }, description);
}
function ownWindow(pid, executable, bounds) {
  assert(Number.isSafeInteger(pid) && pid > 0);
  const code = String.raw`
$ErrorActionPreference='Stop'
$p=Get-Process -Id ${pid}
if ($p.Path -ne '${executable.replaceAll("'", "''")}') {throw 'test process path mismatch'}
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class SDWindow { [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;} [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r); [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int hgt,bool repaint); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int command); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); }
'@
$h=$p.MainWindowHandle
if($h -eq 0){throw 'own test window unavailable'}
${bounds?.close ? "if(-not [SDWindow]::PostMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'close request failed'}" : bounds ? `[SDWindow]::ShowWindow($h,9)|Out-Null\nif(-not [SDWindow]::MoveWindow($h,70,70,${bounds.width},${bounds.height},$true)){throw 'resize failed'}` : ''}
$r=New-Object SDWindow+Rect
if(-not [SDWindow]::GetWindowRect($h,[ref]$r)){throw 'read own window failed'}
@{width=$r.Right-$r.Left;height=$r.Bottom-$r.Top}|ConvertTo-Json -Compress
`;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(code, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, 'own native test window operation failed');
  const match = result.stdout.match(/\{"height":\d+,"width":\d+\}|\{"width":\d+,"height":\d+\}/g);
  assert(match, `own window bounds absent: ${result.stdout} ${result.stderr}`);
  return JSON.parse(match.at(-1));
}
export async function productChecks(context) {
  let { page } = context;
  const {
    artifacts,
    hostId,
    passed,
    restart,
    processId,
    registerCleanup,
    command,
    contains,
    description,
  } = context;
  const uuid = randomUUID(),
    name = `Product ${uuid}`,
    scope = { uuid, hosts: [], entries: [], runs: [], remotePaths: [] };
  const rpc = (name, args = {}) =>
    page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), {
      name,
      args,
    });
  const nav = (name) =>
    page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: new RegExp(`^${name}`) })
      .click();
  const until = async (fn) => {
    for (let i = 0; i < 300; i++) {
      const r = await fn();
      if (r) return r;
      await delay(100);
    }
    throw new Error('product condition deadline');
  };
  const remember = () =>
    writeFile(path.join(artifacts, 'product-scope.json'), JSON.stringify(scope, null, 2));
  const config = (await rpc('app_bootstrap')).config;
  const originalHost = (await rpc('host_list')).hosts.find((h) => h.id === hostId);
  assert(originalHost);
  async function cleanup() {
    for (const dialog of await page.getByRole('dialog').all())
      if (await dialog.isVisible())
        await dialog
          .getByRole('button', { name: '关闭对话框', exact: true })
          .click()
          .catch(() => {});
    if (scope.remotePaths.length) {
      await nav('SFTP 文件');
      await page.getByLabel('当前工作区主机', { exact: true }).selectOption(hostId);
      const lease = await until(async () =>
        (await rpc('files_connections')).find((s) => s.hostId === hostId),
      );
      for (const remote of scope.remotePaths) {
        assert(path.posix.basename(remote) === `serverdeck-product-${uuid}.log`);
        await rpc('files_action', {
          id: lease.id,
          action: { kind: 'remove', paths: [remote], recursive: false, confirmed: true },
        });
      }
      scope.remotePaths = [];
      await remember();
    }
    const histories = await rpc('automation_history', { query: {} });
    for (const run of histories.filter((r) => r.entryName.startsWith(name))) {
      await rpc('automation_cancel', { id: run.id, running: true });
      await until(async () => {
        const r = await rpc('automation_run', { id: run.id });
        return !['Pending', 'Running'].includes(r.state);
      });
      await delay(100);
      await rpc('automation_run_delete', { id: run.id, confirmed: true });
    }
    for (const e of (await rpc('automation_catalog')).entries.filter((e) =>
      e.name.startsWith(name),
    ))
      await rpc('automation_entry_delete', { id: e.id, confirmed: true });
    const catalog = await rpc('host_list');
    for (const h of catalog.hosts.filter((h) => h.id !== hostId && h.description === description)) {
      await rpc('terminal_close_host', { hostId: h.id });
      await rpc('host_delete', { id: h.id });
    }
    await rpc('config_save', { config });
    await writeFile(
      path.join(artifacts, 'product-cleanup.json'),
      JSON.stringify({ cleaned: true, uuid }),
    );
  }
  registerCleanup(cleanup);
  await remember();
  // Keep all three independent leases open and verify the same authenticated Transport.
  await nav('SSH 终端');
  await page
    .locator('.terminal-pane:visible')
    .getByRole('button', { name: 'SFTP', exact: false })
    .click();
  await until(async () => {
    const s = await rpc('files_connections');
    return s.some((s) => s.hostId === hostId);
  });
  await page
    .locator('.workspace-context')
    .getByRole('button', { name: 'Processes', exact: true })
    .click();
  await page.getByRole('button', { name: '刷新运维列表', exact: true }).waitFor();
  await until(async () => {
    const b = await rpc('background_tasks');
    return b.connections
      .filter((c) => c.hostId === hostId && c.state === 'connected')
      .some((c) => c.kind === 'operations');
  });
  const operationLease = (await rpc('ops_connections')).find((s) => s.hostId === hostId);
  const missing = await rpc('ops_query', {
    id: operationLease.id,
    request: { kind: 'process_details', pid: 2147483647 },
  });
  assert.equal(missing.success, false);
  assert(missing.message.includes('进程已退出或无权读取'));
  const processes = await rpc('ops_query', {
    id: operationLease.id,
    request: { kind: 'processes' },
  });
  const process = processes.records.find(
    (p) => p.user === originalHost.username && p.command === 'bash',
  );
  assert(process, 'owned interactive shell process must be visible');
  await page.getByLabel('运维项目搜索', { exact: true }).fill(String(process.pid));
  await page
    .locator(`[data-ops-target="${process.pid}"]`)
    .getByRole('button', { name: '进程详情 / 信号', exact: true })
    .click();
  await page.getByRole('button', { name: '查看关联监听端口', exact: true }).click();
  await page.getByLabel('进程关联端口', { exact: true }).waitFor();
  const connected = await rpc('background_tasks'),
    leases = connected.connections.filter((c) => c.hostId === hostId && c.state === 'connected');
  assert(
    leases.some((c) => c.kind === 'files') &&
      leases.some((c) => c.kind === 'terminal') &&
      leases.some((c) => c.kind === 'operations'),
  );
  assert.equal(new Set(leases.map((c) => c.transportId)).size, 1);
  passed(
    'native unified host identity and shared SSH Transport across independent terminal/files/operations leases, with explicit PID-to-port lookup',
  );
  const {
    id: originalId,
    createdAt: originalCreated,
    updatedAt: originalUpdated,
    ...originalInput
  } = originalHost;
  void originalId;
  void originalCreated;
  void originalUpdated;
  await rpc('host_update', { id: hostId, input: { ...originalInput, port: 23 } });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '当前仍操作建立时的连接' }).waitFor();
  await nav('SSH 终端');
  const beforeCross = (await rpc('files_connections')).map((s) => s.id);
  await page
    .locator('.terminal-pane:visible')
    .getByRole('button', { name: 'SFTP 文件', exact: true })
    .click();
  await page.getByRole('alert').filter({ hasText: '主机连接配置已变更' }).waitFor();
  assert.deepEqual(
    (await rpc('files_connections')).map((s) => s.id),
    beforeCross,
  );
  await rpc('host_update', { id: hostId, input: originalInput });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  passed(
    'native edited host configuration does not relabel an existing SSH connection or silently open another endpoint',
  );
  // A genuine refused endpoint: switching context must never leave host A content under host B.
  const b = await rpc('host_copy', { id: hostId });
  scope.hosts.push(b.id);
  await remember();
  const { id, createdAt, updatedAt, ...input } = b;
  void createdAt;
  void updatedAt;
  input.name = `Product connection ${uuid}`;
  input.port = 1;
  input.description = description;
  await rpc('host_update', { id, input });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByLabel('当前工作区主机', { exact: true }).selectOption(id);
  await page.locator('.workspace-context').filter({ hasText: input.name }).waitFor();
  await page
    .locator('.workspace-context')
    .getByRole('button', { name: '诊断连接', exact: true })
    .click();
  assert.equal(
    await page.getByLabel('诊断目标', { exact: true }).inputValue(),
    originalHost.hostname,
  );
  await page.getByRole('button', { name: '开始诊断', exact: true }).click();
  await until(async () => {
    const b = await rpc('background_tasks');
    return b.tasks.some((t) => t.kind === 'diagnostic' && t.state === 'failed');
  });
  assert(
    (await rpc('background_tasks')).connections.some(
      (c) => c.hostId === hostId && c.state === 'connected',
    ),
  );
  await page.getByLabel('当前工作区主机', { exact: true }).selectOption(hostId);
  await nav('SSH 终端');
  await command("printf '\\n__SD_%s__\\n' PRODUCT_CONTEXT_SURVIVED");
  await contains('__SD_PRODUCT_CONTEXT_SURVIVED__');
  await page.getByRole('button', { name: /^后台任务 \d/ }).click();
  await page
    .getByRole('dialog', { name: '后台任务与传输', exact: true })
    .getByText(/TCP|Tcp/)
    .first()
    .waitFor();
  await page
    .getByRole('dialog', { name: '后台任务与传输', exact: true })
    .getByRole('button', { name: '关闭对话框', exact: true })
    .click();
  passed(
    'native host-context switching, real TCP failure notification and background task visibility leave the original SSH session usable',
  );
  for (let n = 0; n < 5; n++) {
    const close = page.getByRole('button', { name: '关闭通知', exact: true });
    if (!(await close.count())) break;
    await close.first().click();
  }
  // Run a reusable real command using the already chosen host, then export its actual result.
  await nav('运维自动化');
  await page.getByRole('button', { name: '新建命令 / 脚本', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '新建命令 / 脚本', exact: true });
  await editor.getByLabel('自动化条目名称').fill(name);
  await editor.getByLabel('自动化条目正文').fill(`printf '__SD_PRODUCT_RESULT__\\n'; uname -s`);
  await editor.getByLabel('持久化任务输出').check();
  await editor.getByRole('button', { name: '保存条目', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  const entry = (await rpc('automation_catalog')).entries.find((e) => e.name === name);
  assert(entry);
  scope.entries.push(entry.id);
  await remember();
  const article = page.locator(`[data-entry-id="${entry.id}"]`);
  await article.getByRole('button', { name: '快捷执行', exact: true }).click();
  let dialog = page.getByRole('dialog').filter({ has: page.getByLabel('自动化执行确认文字') });
  const runDialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: '预览自动化执行', exact: true }) });
  assert.equal(
    await runDialog.getByLabel(`自动化目标 ${originalHost.name}`, { exact: true }).isChecked(),
    true,
  );
  await runDialog.getByRole('button', { name: '连接所选目标', exact: true }).click();
  await until(async () => (await rpc('ops_connections')).some((s) => s.hostId === hostId));
  await runDialog.getByRole('button', { name: '预览自动化执行', exact: true }).click();
  await dialog.getByLabel('自动化执行确认文字').fill('执行 1 台');
  await dialog.getByRole('button', { name: '确认执行自动化', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const run = await until(async () => {
    const list = await rpc('automation_history', { query: {} });
    const row = list.find((r) => r.entryName === name);
    if (!row || row.state !== 'Success') return;
    return rpc('automation_run', { id: row.id });
  });
  scope.runs.push(run.id);
  await remember();
  assert(run.rows[0].stdout.includes('__SD_PRODUCT_RESULT__'));
  assert.equal(run.rows[0].hostId, hostId);
  await page
    .getByLabel('自动化执行详情', { exact: true })
    .locator('pre:visible')
    .filter({ hasText: '__SD_PRODUCT_RESULT__' })
    .first()
    .waitFor();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出任务结果', exact: true }).click();
  const resultFile = path.join(artifacts, 'product-export-result.json');
  await (await downloaded).saveAs(resultFile);
  const actual = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.equal(actual.id, run.id);
  assert(actual.rows[0].stdout.includes('Linux'));
  passed(
    'native current-host command creation, target confirmation, real execution and exported result attribution',
  );
  // Global search invokes navigation/preview, never silently executes a script.
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: '全局搜索', exact: true });
  await search.getByLabel('全局搜索内容').fill(name);
  await search.getByRole('option').filter({ hasText: name }).waitFor();
  await search.getByLabel('全局搜索内容').press('Enter');
  await page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: '预览自动化执行', exact: true }) })
    .getByRole('button', { name: '关闭对话框', exact: true })
    .click();
  assert.equal(
    (await rpc('automation_history', { query: {} })).filter((r) => r.entryName === name).length,
    1,
  );
  passed(
    'native configurable global search opens a current-host task preview without executing it',
  );
  // Export, validate, skip duplicates, then explicitly restore copies without secrets or plans.
  await nav('备份恢复');
  await page.getByRole('button', { name: '导出非敏感备份', exact: true }).click();
  const backup = await rpc('backup_export');
  const parsed = JSON.parse(backup);
  assert.equal(parsed.version, 1);
  assert(!backup.includes(originalHost.credentialId));
  assert(!parsed.credentials && !parsed.schedules && !parsed.runs);
  assert(parsed.hosts.every((h) => h.config.credentialId === null));
  await page.getByLabel('待恢复备份 JSON').fill(backup);
  await page.getByRole('button', { name: '校验并预览备份', exact: true }).click();
  await page.getByLabel(`恢复 ${originalHost.name}`, { exact: true }).check();
  await page.getByLabel(`恢复 ${name}`, { exact: true }).check();
  await page.getByLabel('确认备份恢复', { exact: true }).check();
  await page.getByRole('button', { name: '确认恢复所选配置', exact: true }).click();
  await page.getByRole('heading', { name: '恢复完成', exact: true }).waitFor();
  assert.equal((await rpc('host_list')).hosts.length, 2);
  await page.getByRole('button', { name: '校验并预览备份', exact: true }).click();
  await page.getByLabel('备份冲突策略', { exact: true }).selectOption('copy');
  await page.getByLabel(`恢复 ${originalHost.name}`, { exact: true }).check();
  await page.getByLabel(`恢复 ${name}`, { exact: true }).check();
  await page.getByLabel('确认备份恢复', { exact: true }).check();
  await page.getByRole('button', { name: '确认恢复所选配置', exact: true }).click();
  await page.getByRole('heading', { name: '恢复完成', exact: true }).waitFor();
  const restored = (await rpc('host_list')).hosts.filter((h) => h.id !== hostId && h.id !== b.id);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].credentialId, null);
  scope.hosts.push(restored[0].id);
  await remember();
  assert.equal((await rpc('automation_catalog')).schedules.length, 0);
  await writeFile(
    path.join(artifacts, 'product-backup-metadata.json'),
    JSON.stringify(
      {
        version: parsed.version,
        hosts: parsed.hosts.length,
        entries: parsed.entries.length,
        restoredHostIds: restored.map((h) => h.id),
        credentialsExported: false,
      },
      null,
      2,
    ),
  );
  passed(
    'native versioned backup preview, duplicate skip and confirmed copy restore preserve originals and omit credentials/automatic plans',
  );
  // Settings and logical panel/window persistence. Only manipulate this test process window.
  await nav('全局设置');
  await page.getByLabel('默认 Keepalive 间隔', { exact: true }).fill('33');
  await page.getByLabel('默认下载目录', { exact: true }).fill(artifacts);
  await page.getByTestId('theme-select').selectOption('light');
  await page.getByLabel('全局默认代理', { exact: true }).selectOption('socks5');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await until(
    async () =>
      (await rpc('app_bootstrap')).config.product.sshDefaults.keepaliveIntervalSecs === 33,
  );
  await page.getByRole('button', { name: '＋ 新建主机', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新建主机', exact: true });
  await dialog.getByText('SSH 高级连接设置', { exact: true }).click();
  assert.equal(await dialog.getByLabel('网络代理', { exact: true }).inputValue(), 'socks5');
  assert.equal(await dialog.getByLabel('Keepalive 间隔（秒）', { exact: true }).inputValue(), '33');
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
  assert.equal(
    (await rpc('host_list')).hosts.find((h) => h.id === hostId).ssh.keepaliveIntervalSecs,
    originalHost.ssh.keepaliveIntervalSecs,
  );
  await page.getByLabel('全局默认代理', { exact: true }).selectOption('direct');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await until(async () => (await rpc('app_bootstrap')).config.product.sshDefaults.proxy === null);
  const sourceDirectory = path.join(artifacts, `product-source-${uuid}`),
    fileName = `serverdeck-product-${uuid}.log`,
    content = 'ServerDeck product download 中文\n';
  await mkdir(sourceDirectory);
  await writeFile(path.join(sourceDirectory, fileName), content);
  await nav('SFTP 文件');
  const fileLease = await until(async () =>
    (await rpc('files_connections')).find((s) => s.hostId === hostId),
  );
  const home = (await rpc('files_list', { id: fileLease.id, path: '.' })).path;
  scope.remotePaths.push(home.replace(/\/$/, '') + '/' + fileName);
  await remember();
  await page.getByLabel('本地路径', { exact: true }).fill(sourceDirectory);
  await page
    .locator('.file-side')
    .nth(0)
    .getByRole('button', { name: '前往', exact: true })
    .click();
  await page
    .getByRole('table', { name: '本地文件', exact: true })
    .getByLabel(`选择 ${fileName}`, { exact: true })
    .check();
  const beforeUploads = new Set((await rpc('transfer_list')).map((t) => t.id));
  await page.getByRole('button', { name: '上传选中', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '确认文件传输', exact: true });
  await dialog.getByLabel('传输目标目录', { exact: true }).fill(home);
  await dialog.getByRole('button', { name: '加入传输队列', exact: true }).click();
  await until(async () => {
    const t = (await rpc('transfer_list')).find((t) => !beforeUploads.has(t.id));
    if (t?.state === 'failed') throw new Error(t.message);
    return t?.state === 'completed';
  });
  await page.getByLabel('远程路径', { exact: true }).fill(home);
  await page.getByLabel('远程路径', { exact: true }).press('Enter');
  await page
    .getByRole('table', { name: '远程文件', exact: true })
    .getByLabel(`选择 ${fileName}`, { exact: true })
    .check();
  const beforeDownloads = new Set((await rpc('transfer_list')).map((t) => t.id));
  await page.getByRole('button', { name: '下载选中', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '确认文件传输', exact: true });
  assert.equal(await dialog.getByLabel('传输目标目录', { exact: true }).inputValue(), artifacts);
  await dialog.getByRole('button', { name: '加入传输队列', exact: true }).click();
  await until(async () => {
    const t = (await rpc('transfer_list')).find((t) => !beforeDownloads.has(t.id));
    if (t?.state === 'failed') throw new Error(t.message);
    return t?.state === 'completed';
  });
  assert.equal(await readFile(path.join(artifacts, fileName), 'utf8'), content);
  await rpc('files_action', {
    id: fileLease.id,
    action: { kind: 'remove', paths: scope.remotePaths, recursive: false, confirmed: true },
  });
  scope.remotePaths = [];
  await remember();
  passed(
    'native configured download directory is used by an actual SFTP UI transfer and default proxy is copied only to new host forms',
  );
  await nav('全局设置');
  await page.getByRole('separator', { name: '调整主机侧栏宽度', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await until(
    async () => (await rpc('app_bootstrap')).config.sidebarWidth === config.sidebarWidth + 8,
  );
  const executable = context.executable || path.join(artifacts, 'ServerDeckTerminalE2E.exe');
  const bounds = ownWindow(processId(), executable, {
    width: Math.round(1120 * (await page.evaluate(() => devicePixelRatio))),
    height: Math.round(760 * (await page.evaluate(() => devicePixelRatio))),
  });
  await delay(1000);
  await page.screenshot({ path: path.join(artifacts, 'product-light.png') });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 650,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await delay(250);
  const actualDensity = await page.evaluate(() => devicePixelRatio);
  assert(
    await page.evaluate(() => {
      const a = document.querySelector('.workspace-tab.active').getBoundingClientRect(),
        b = document.querySelector('.workspace-tabs').getBoundingClientRect();
      return a.left >= b.left - 1 && a.right <= b.right + 1;
    }),
    'active workspace tab must remain visible after viewport resize',
  );
  await page.screenshot({ path: path.join(artifacts, 'product-dpi.png') });
  assert(await page.getByRole('button', { name: '打开全局搜索', exact: true }).isVisible());
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  page = await restart();
  assert.equal((await rpc('app_bootstrap')).config.product.sshDefaults.keepaliveIntervalSecs, 33);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal((await rpc('background_tasks')).connections.length, 0);
  const after = ownWindow(processId(), executable);
  assert(
    Math.abs(after.width - bounds.width) <= 24 && Math.abs(after.height - bounds.height) <= 24,
    'logical native window size must survive restart',
  );
  await writeFile(
    path.join(artifacts, 'product-window.json'),
    JSON.stringify({ before: bounds, after, scaleEmulation: 2, actualDensity }, null, 2),
  );
  passed(
    'native theme/default Keepalive/download/panel settings and actual window-size restart persistence; high-DPI emulated layout remains navigable',
  );
  // Every exit route now reviews live sessions, even without an active file transfer.
  ownWindow(processId(), executable, { close: true });
  dialog = page.getByRole('dialog', { name: '确认退出 ServerDeck', exact: true });
  await dialog.waitFor();
  await page.screenshot({ path: path.join(artifacts, 'product-close-review.png') });
  await dialog.getByRole('button', { name: '继续使用', exact: true }).click();
  await page.getByRole('button', { name: '退出应用', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '确认退出 ServerDeck', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '继续使用', exact: true }).click();
  await cleanup();
  registerCleanup(undefined);
  await page.reload();
  await page.getByText('本地后端已就绪', { exact: true }).waitFor();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await nav('主机管理');
  await page.locator('tbody').getByRole('button', { name: originalHost.name, exact: true }).click();
  await page.getByRole('button', { name: '连接 / 新建终端', exact: true }).click();
  await page
    .locator('.terminal-pane:visible')
    .getByRole('status')
    .filter({ hasText: '已连接' })
    .waitFor();
  await command("printf '\\n__SD_%s__\\n' PRODUCT_RESTART_SURVIVED");
  await contains('__SD_PRODUCT_RESTART_SURVIVED__');
  await page.screenshot({ path: path.join(artifacts, 'product-dark.png') });
  passed(
    'native exit review, no unattended reconnect after restart, owned backup/task cleanup and fresh real SSH shell',
  );
}
