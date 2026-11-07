import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { navigateWorkspace } from './ui-navigation.mjs';

const output = process.env.SERVERDECK_PAGES_OUTPUT ?? '/tmp/serverdeck-pages';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.SERVERDECK_BROWSER ?? '/opt/google/chrome/chrome',
  headless: true,
  args: ['--no-sandbox'],
});
const pages = [
  ['SSH 终端', 'terminals'],
  ['SFTP 文件', 'files'],
  ['服务器管理', 'server'],
  ['关于', 'about'],
  ['通用', 'settings'],
  ['终端', 'settingsTerminal'],
  ['快捷键', 'settingsShortcuts'],
  ['数据与存储', 'settingsStorage'],
];
const fontSizeOnly = process.argv.includes('--font-size');

// Browser-only rendering fixtures; no production fallback, disk changes, or remote commands.
async function fixtures(page, theme) {
  await page.evaluate(async (theme) => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

    const { useApplicationStore } = await import('/src/stores/application.ts');
    const { useHostsStore } = await import('/src/stores/hosts.ts');
    const { useNotificationsStore } = await import('/src/stores/notifications.ts');
    const { defaultTerminalPreferences } = await import('/src/types/preferences.ts');
    const { defaultProductPreferences } = await import('/src/types/product.ts');
    const { hostInput } = await import('/src/types/hosts.ts');
    const hosts = useHostsStore(pinia),
      application = useApplicationStore(pinia);
    hosts.catalog = {
      hosts: ['API production', 'Database primary', 'Staging server'].map((name, n) => ({
        ...hostInput(),
        id: `ui-${n}`,
        name,
        hostname: `192.0.2.${n + 1}`,
        username: 'operator',
        favorite: n === 0,
        createdAt: '',
        updatedAt: '',
      })),
      groups: [],
      credentials: [
        {
          id: 'ui-credential',
          name: 'Operations credential',
          kind: 'password',
          keyPath: null,
          hasSecret: true,
          hostCount: 2,
          revision: 1,
        },
      ],
      pendingSecretDeletions: 0,
    };
    hosts.selectedId = 'ui-0';
    application.error = null;
    application.state = {
      appVersion: '0.3.0',
      databaseVersion: 5,
      dataDirectory: '/ui-fixture/data',
      logDirectory: '/ui-fixture/logs',
      config: {
        version: 1,
        theme,
        interfaceFontSize: 'standard',
        sidebarWidth: 248,
        terminalFontSize: 14,
        connectTimeoutSecs: 15,
        monitorIntervalSecs: 3,
        transferConcurrency: 2,
        logLevel: 'info',
        terminal: defaultTerminalPreferences(),
        product: defaultProductPreferences(),
      },
    };
    useNotificationsStore(pinia).items = [];
    const host = hosts.catalog.hosts[0];
    const { useWorkspaceStore } = await import('/src/stores/workspace.ts');
    useWorkspaceStore(pinia).selectHost(host.id);
    const session = {
      id: 'ui-session',
      hostId: host.id,
      transportId: 'ui-transport',
      routeHostIds: [],
      state: 'connected',
    };
    const { opsApi } = await import('/src/services/ops.ts');
    const { useOpsStore } = await import('/src/stores/ops.ts');
    useOpsStore(pinia).connections[host.id] = {
      host,
      state: 'connected',
      session,
      error: null,
      trust: null,
    };
    opsApi.connections = async () => [session];
    opsApi.feedback = async () => [];
    opsApi.query = async (_id, request) => ({
      success: true,
      records:
        request.kind === 'containers'
          ? [
              {
                ID: 'ui-container',
                Names: 'application-api',
                Image: 'application:stable',
                State: 'running',
                Status: 'Up 2 hours',
                Ports: '127.0.0.1:8080',
              },
            ]
          : [],
      detail:
        request.kind === 'capabilities'
          ? { dockerState: 'running', dockerInstalled: true, systemd: true }
          : {},
    });
    const { filesApi } = await import('/src/services/files.ts');
    const directories = ['config', 'logs', '数据库备份'];
    const listing = {
      path: '/srv/application',
      parent: '/srv',
      entries: [
        ...directories,
        'current',
        'application.log',
        'backup.tar.gz',
        'compose.yaml',
        'deploy.sh',
        'cover.webp',
        '跨环境发布与数据库迁移记录-2026-11-07.md',
        ...Array.from({ length: 60 }, (_, n) => `fixture-${n + 1}.txt`),
      ].map((name, index) => ({
        name,
        path: `/srv/application/${name}`,
        kind: index < directories.length ? 'directory' : name === 'current' ? 'symlink' : 'file',
        size: index < directories.length ? null : 2048,
        modified: 1700000000,
        permissions: index < directories.length ? 0o755 : 0o644,
        uid: 0,
        owner: 'root',
        gid: 1000,
      })),
    };
    filesApi.local = async (path) => ({ ...listing, path: path ?? listing.path });
    filesApi.list = async (_session, path) => ({ ...listing, path });
    filesApi.connections = async () => [session];
    filesApi.tasks = async () => [];
    const { useFilesStore } = await import('/src/stores/files.ts');
    const files = useFilesStore(pinia);
    files.local = listing;
    files.active = host.id;
    files.connections[host.id] = {
      host,
      state: 'connected',
      id: session.id,
      path: listing.path,
      listing,
      loading: false,
      error: null,
      trust: null,
    };
    const { monitorApi } = await import('/src/services/monitor.ts');
    monitorApi.open = async () => session;
    monitorApi.visible = async () => {};
    monitorApi.snapshot = async () => ({
      hostId: host.id,
      sessionId: session.id,
      revision: 1,
      state: 'running',
      intervalSecs: 3,
      error: null,
      sample: {
        sampledAt: 1700000000000,
        uptime: 86400,
        load: [0.2, 0.4, 0.3],
        cpus: [{ name: 'cpu', usage: 24, iowait: 0.3 }],
        memory: {
          total: 8589934592,
          used: 2147483648,
          available: 6442450944,
          usage: 25,
          approximate: false,
          swapTotal: 0,
          swapUsed: 0,
          swapUsage: null,
        },
        disks: [
          {
            mount: '/',
            source: '/dev/sda1',
            filesystem: 'ext4',
            device: '8:1',
            total: 107374182400,
            used: 21474836480,
            available: 85899345920,
            usage: 20,
            pseudo: false,
            image: false,
            container: false,
            duplicateOf: null,
            error: null,
          },
        ],
        network: [
          {
            name: 'eth0',
            index: 1,
            addresses: ['192.0.2.1'],
            received: 2048,
            sent: 1024,
            receiveRate: 256,
            sendRate: 128,
          },
        ],
        warnings: [],
        rateStatus: 'ready',
        system: {
          hostname: 'ui-server',
          distribution: 'Linux',
          kernel: '6.8',
          architecture: 'x86_64',
          cpuModel: 'UI rendering fixture',
          cores: 4,
          systemTime: '2026-11-02',
          timezone: 'UTC',
        },
      },
      history: [0, 1, 2].map((n) => ({
        sampledAt: 1700000000000 + n * 3000,
        uptime: 86400 + n * 3,
        cpu: 24 + n,
        memory: 25,
        receiveRate: 256,
        sendRate: 128,
      })),
    });
    const { useTerminalsStore } = await import('/src/stores/terminals.ts');
    const terminals = useTerminalsStore(pinia);
    terminals.open(host);
    terminals.update(terminals.focused, { state: 'idle', connectRequested: false });
  }, theme);
}

async function inspect(page, name) {
  const issues = await page.evaluate(() => {
    const issues = [];
    const root = document.querySelector('dialog[open]') ?? document.querySelector('main');
    const visible = (el) =>
      el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    if (root.matches('dialog') && root.scrollWidth > root.clientWidth + 2)
      issues.push('dialog horizontal overflow');
    for (const el of root.querySelectorAll('button.button, button.tool-button')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const label = el.getAttribute('aria-label') ?? el.textContent.trim();
      const scale = Number(
        document.documentElement.style.getPropertyValue('--interface-font-scale') || 1,
      );
      if (r.height < 27 || r.height > Math.max(39, 39 * scale) + 1)
        issues.push(`button height ${r.height}: ${label}`);
      if (el.scrollWidth > el.clientWidth + 2) issues.push(`clipped button: ${label}`);
      if (el.scrollHeight > el.clientHeight + 2) issues.push(`vertically clipped button: ${label}`);
      const next = el.nextElementSibling;
      if (
        next?.matches('button') &&
        visible(next) &&
        !el.closest('[role=tablist], .terminal-tab')
      ) {
        const n = next.getBoundingClientRect();
        if (Math.abs(n.top - r.top) < 2 && n.left - r.right < 4)
          issues.push(`joined buttons: ${label}`);
      }
    }
    if (document.documentElement.scrollWidth > innerWidth) issues.push('page horizontal overflow');
    const content = document.querySelector('.content-scroll');
    if (visible(content) && content.scrollWidth > content.clientWidth + 2)
      issues.push('workspace horizontal overflow');
    return issues;
  });
  assert.deepEqual(issues, [], name);
}

const results = [];

async function verifyDownloadDragAndDelete(page) {
  await page.evaluate(async () => {
    const { filesApi } = await import('/src/services/files.ts');
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
    pinia._s.get('application').state.config.product.downloadDirectory = '/configured/downloads';
    window.sftpTestCalls = { transfers: [], actions: [] };
    filesApi.start = async (input) => window.sftpTestCalls.transfers.push(input);
    filesApi.action = async (session, input) =>
      window.sftpTestCalls.actions.push({ session, input });
  });
  const remote = page.getByRole('table', { name: '远程文件', exact: true });
  const directory = remote.getByRole('button', { name: 'config', exact: true });
  const file = remote.getByRole('button', { name: 'deploy.sh', exact: true });
  const destination = page.getByRole('textbox', { name: '本地路径', exact: true });
  const download = page.getByRole('dialog', { name: '确认文件传输', exact: true });
  const deleteDialog = page.getByRole('dialog', { name: '确认删除远程项目', exact: true });
  const remove = page.getByRole('button', { name: '删除选中', exact: true });
  const dropHint = page.getByText('松开后下载到当前目录', { exact: true });
  const moveToLocal = async (entry) => {
    await entry.hover();
    const target = await destination.boundingBox();
    assert(target);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
    await dropHint.waitFor();
  };
  await directory.click();
  await file.click({ modifiers: ['Control'] });
  await moveToLocal(file);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await download.count(), 0);
  await moveToLocal(file);
  await page.mouse.up();
  assert.equal(
    await download.getByRole('textbox', { name: '传输目标目录' }).inputValue(),
    '/srv/application',
  );
  assert.equal(
    await download.locator('.file-path-preview').textContent(),
    '/srv/application/config\n/srv/application/deploy.sh',
  );
  await download.getByRole('button', { name: '加入传输队列', exact: true }).click();
  await download.waitFor({ state: 'hidden' });
  const calls = () => page.evaluate(() => window.sftpTestCalls);
  assert.deepEqual((await calls()).transfers, [
    {
      sessionId: 'ui-session',
      direction: 'download',
      sources: ['/srv/application/config', '/srv/application/deploy.sh'],
      destination: '/srv/application',
      conflict: 'fail',
      confirmOverwrite: false,
    },
  ]);
  await moveToLocal(remote.getByRole('button', { name: 'cover.webp', exact: true }));
  await page.mouse.up();
  assert.equal(
    await download.locator('.file-path-preview').textContent(),
    '/srv/application/cover.webp',
  );
  await download.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await calls()).transfers.length, 1);

  await directory.click();
  await remove.click();
  assert.equal(
    (await deleteDialog.locator('.file-delete-message').innerText()).trim(),
    '确定要永久删除「config」吗？',
  );
  assert.equal(await deleteDialog.getByRole('checkbox').count(), 0);
  assert.equal(await deleteDialog.getByRole('button', { name: '帮助' }).count(), 0);
  const cancel = deleteDialog.getByRole('button', { name: '取消', exact: true });
  const confirm = deleteDialog.getByRole('button', { name: '确认', exact: true });
  assert(await cancel.evaluate((element) => document.activeElement === element));
  await deleteDialog.screenshot({ path: `${output}/delete-remote-directory.png` });
  await cancel.click();
  assert.deepEqual((await calls()).actions, []);
  await remove.click();
  await confirm.click();
  await deleteDialog.waitFor({ state: 'hidden' });
  assert.deepEqual((await calls()).actions, [
    {
      session: 'ui-session',
      input: {
        kind: 'remove',
        paths: ['/srv/application/config'],
        recursive: true,
        confirmed: true,
      },
    },
  ]);
  await file.click();
  await remove.click();
  assert.match(await deleteDialog.textContent(), /确定要永久删除「deploy\.sh」吗/);
  assert.equal(await deleteDialog.getByRole('checkbox').count(), 0);
  await confirm.click();
  await deleteDialog.waitFor({ state: 'hidden' });
  const { actions } = await calls();
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[1], {
    session: 'ui-session',
    input: {
      kind: 'remove',
      paths: ['/srv/application/deploy.sh'],
      recursive: false,
      confirmed: true,
    },
  });
}

async function verifyMouseDirectoryHistory(page) {
  const local = page.getByRole('textbox', { name: '本地路径', exact: true });
  const remote = page.getByRole('textbox', { name: '远程路径', exact: true });
  const paths = async (localPath, remotePath) => {
    await page.waitForFunction(
      ([localPath, remotePath]) => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        const files = pinia._s.get('files');
        return files.local?.path === localPath && files.current?.path === remotePath;
      },
      [localPath, remotePath],
    );
  };
  const cdp = await page.context().newCDPSession(page);
  const press = async (input, button) => {
    const box = await input.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button,
      buttons: button === 'back' ? 8 : 16,
      x,
      y,
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button,
      buttons: 0,
      x,
      y,
      clickCount: 1,
    });
  };
  try {
    const start = '/srv/application';
    await local.fill('/local/next');
    await local.press('Enter');
    await page
      .getByRole('table', { name: '远程文件', exact: true })
      .getByRole('button', { name: 'config', exact: true })
      .dblclick();
    await paths('/local/next', '/srv/application/config');
    await page.evaluate(() => history.pushState(null, '', '#mouse-side-button'));
    const url = page.url();

    await press(remote, 'back');
    await paths('/local/next', start);
    await press(local, 'back');
    await paths(start, start);
    await press(local, 'back');
    assert.equal(page.url(), url);

    await press(local, 'forward');
    await paths('/local/next', start);
    await press(remote, 'forward');
    await paths('/local/next', '/srv/application/config');
    assert.equal(page.url(), url);
    await press(local, 'back');
    await press(remote, 'back');
    await paths(start, start);
  } finally {
    await cdp.detach();
  }
}

async function verifyInterfaceFontSize(page, variant, width) {
  const columns = page.locator('.file-columns');
  const measure = () =>
    columns.evaluate((element) => ({
      columns: getComputedStyle(element)
        .gridTemplateColumns.split(' ')
        .filter((track) => parseFloat(track) > 0).length,
      fontSizes: [...element.querySelectorAll('table, .path-bar input, .toolbar .button')].map(
        (item) => parseFloat(getComputedStyle(item).fontSize),
      ),
      tables: [...element.querySelectorAll('.file-table')].map((table) => {
        const folderIcon = table.querySelector('.file-entry-icon[data-kind="directory"]');
        const icon = folderIcon.getBoundingClientRect();
        const label = folderIcon.nextElementSibling.getBoundingClientRect();
        return {
          top: table.getBoundingClientRect().top,
          width: table.clientWidth,
          scrollWidth: table.scrollWidth,
          scrolls: table.scrollHeight > table.clientHeight,
          folderIconWidth: icon.width,
          folderIconAligned:
            icon.right < label.left &&
            Math.abs(icon.top + icon.height / 2 - label.top - label.height / 2) < 1,
        };
      }),
    }));
  const standard = await measure();
  assert(
    standard.fontSizes.every((size) => size === 14),
    `${variant}: primary text is 14px`,
  );
  await navigateWorkspace(page, '通用');
  const slider = page.getByRole('slider', { name: '界面字号', exact: true });
  assert.equal(await slider.getAttribute('aria-valuetext'), '标准');
  assert.deepEqual(
    (await page.locator('.interface-font-ticks button').allTextContents()).map((text) =>
      text.trim(),
    ),
    ['小', '标准', '大', '特大', '超大'],
  );
  for (const [label, scale] of [
    ['小', 0.95],
    ['标准', 1],
    ['大', 1.15],
    ['特大', 1.3],
    ['超大', 1.45],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    const typography = await page.evaluate(() => {
      const size = (selector) =>
        parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
      return {
        body: size('body'),
        field: size('#interface-font-size'),
        navigation: size('.nav-label'),
        caption: size('#interface-font-size-help'),
        section: size('.settings-panel legend'),
        title: size('.settings-panel h1'),
      };
    });
    for (const [key, base] of Object.entries({
      body: 14,
      field: 14,
      navigation: 14,
      caption: 12,
      section: 16,
      title: 24,
    }))
      assert(Math.abs(typography[key] - base * scale) < 0.01, `${variant}/${label}: ${key}`);
    await inspect(page, `${variant}/settings-${label}`);
  }
  await page.getByRole('button', { name: '小', exact: true }).click();
  assert.equal(await slider.inputValue(), '0');
  await slider.press('ArrowRight');
  assert.equal(await slider.getAttribute('aria-valuetext'), '标准');
  await slider.press('Home');
  const track = await slider.boundingBox();
  assert(track);
  const center = track.y + track.height / 2;
  await page.mouse.move(track.x + 7, center);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width - 7, center, { steps: 8 });
  assert.equal(await slider.getAttribute('aria-valuetext'), '超大');
  assert.equal(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--interface-font-scale'),
    ),
    '1.45',
  );
  await page.mouse.up();
  await page.screenshot({ path: `${output}/${variant}-font-size-settings.png` });
  await navigateWorkspace(page, 'SFTP 文件');
  const largest = await measure();
  assert.equal(largest.fontSizes.length, 6);
  for (const [index, size] of largest.fontSizes.entries())
    assert(Math.abs(size - standard.fontSizes[index] * 1.45) < 0.01);
  assert.equal(largest.columns, width >= 1800 ? 2 : 1);
  if (width === 1366 || width === 1240) assert.equal(standard.columns, 2);
  if (largest.columns === 2) assert.equal(largest.tables[0].top, largest.tables[1].top);
  for (const [index, table] of largest.tables.entries()) {
    assert(standard.tables[index].folderIconAligned && table.folderIconAligned);
    assert(Math.abs(table.folderIconWidth - standard.tables[index].folderIconWidth * 1.45) < 0.1);
    assert(table.scrolls, `${variant}: file list lost vertical scrolling`);
    if (width >= 900) {
      assert(
        table.scrollWidth <= table.width + 1,
        `${variant}: file table overflows (${table.scrollWidth} > ${table.width})`,
      );
    }
  }
  await inspect(page, `${variant}/files-ultra-large`);
  await page.screenshot({ path: `${output}/${variant}-files-ultra-large.png` });
  if (width === 900) {
    await page
      .getByRole('table', { name: '远程文件', exact: true })
      .getByRole('button', { name: 'config', exact: true })
      .click();
    await page.getByRole('button', { name: '删除选中', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认删除远程项目', exact: true });
    await dialog.waitFor();
    assert(
      await dialog.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.width <= 470 &&
          box.top >= 0 &&
          box.bottom <= innerHeight &&
          element.scrollWidth <= element.clientWidth
        );
      }),
    );
    await dialog.screenshot({ path: `${output}/delete-remote-directory-ultra-large.png` });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
  }
  if (fontSizeOnly) {
    for (const category of ['终端', '快捷键', '数据与存储', '关于', '模型管理']) {
      await navigateWorkspace(page, category);
      await inspect(page, `${variant}/${category}-ultra-large`);
      const clippedControls = await page
        .locator('.settings-category:visible')
        .evaluateAll((panels) =>
          panels
            .flatMap((panel) => [...panel.querySelectorAll('input, select')])
            .filter(
              (element) =>
                element.getClientRects().length && element.scrollHeight > element.clientHeight + 2,
            )
            .map((element) => element.getAttribute('aria-label') ?? element.id),
        );
      assert.deepEqual(clippedControls, [], `${variant}/${category}: clipped form controls`);
      if (category === '快捷键' || category === '数据与存储')
        await page.screenshot({ path: `${output}/${variant}-${category}-ultra-large.png` });
    }
  }
  await navigateWorkspace(page, '通用');
  await slider.press('Home');
  await slider.press('ArrowRight');
  assert.equal(await slider.getAttribute('aria-valuetext'), '标准');
  await navigateWorkspace(page, 'SFTP 文件');
  return largest;
}

async function verifyTransferLayout(page, variant) {
  const measure = () =>
    page.evaluate(() => {
      const content = document.querySelector('.content-scroll');
      const columns = document.querySelector('.file-columns');
      const panel = document.querySelector('.files-view > .transfer-panel');
      const bottom =
        content.getBoundingClientRect().bottom -
        Number.parseFloat(getComputedStyle(content).paddingBottom);
      return {
        columnCount: getComputedStyle(columns)
          .gridTemplateColumns.split(' ')
          .filter((track) => parseFloat(track) > 0).length,
        gap: bottom - columns.getBoundingClientRect().bottom,
        columnsBottom: columns.getBoundingClientRect().bottom,
        panelTop: panel?.getBoundingClientRect().top,
        panelGap: panel ? bottom - panel.getBoundingClientRect().bottom : null,
        tables: [...columns.querySelectorAll('.file-table')].map((table) => ({
          height: table.clientHeight,
          scrolls: table.scrollHeight > table.clientHeight,
        })),
      };
    });
  const setTransfer = (state) =>
    page.evaluate(async (state) => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const { filesApi } = await import('/src/services/files.ts');
      const files = pinia._s.get('files');
      const task = {
        id: 'fixture-upload',
        hostId: 'ui-0',
        sessionId: 'ui-session',
        state,
        direction: 'upload',
        sources: ['D:/fixtures/upload-report.txt'],
        destination: '/srv/application',
        totalBytes: 1024,
        transferredBytes: 512,
        remainingBytes: 512,
        bytesPerSecond: 128,
        filesTotal: 1,
        filesDone: 0,
        skipped: 0,
        message: null,
        recoveryPaths: [],
      };
      const tasks = [task, { ...task, id: 'other-host-upload', hostId: 'ui-1', state: 'running' }];
      filesApi.tasks = async () => tasks;
      files.tasks = tasks;
    }, state);
  const idle = await measure();
  assert(
    (idle.columnCount === 2 ? Math.abs(idle.gap) : idle.gap) <= 1,
    `${variant}: idle file lists do not fill the workspace: ${idle.gap}px`,
  );
  assert(
    idle.tables.every((table) => table.height >= 96 && table.scrolls),
    `${variant}: tables must scroll independently`,
  );

  const panel = page.getByRole('region', { name: '传输任务', exact: true });
  await setTransfer('running');
  await panel.getByText(/upload-report\.txt/).waitFor();
  assert.equal(await panel.locator('.transfer-row').count(), 1);
  const active = await measure();
  assert(active.panelTop >= active.columnsBottom, `${variant}: transfer overlaps file lists`);
  if (idle.columnCount === 2) {
    assert(
      Math.abs(active.panelGap) <= 1,
      `${variant}: transfer panel must end at workspace bottom`,
    );
  } else {
    await panel.scrollIntoViewIfNeeded();
    await page.evaluate(() => (document.querySelector('.content-scroll').scrollTop = 0));
  }
  if (idle.tables.every((table) => table.height > 96)) {
    assert(
      active.tables.every((table, index) => table.height < idle.tables[index].height),
      `${variant}: file lists must yield space`,
    );
  }
  assert(
    active.tables.every((table) => table.height >= 96),
    `${variant}: file lists stay usable during transfer`,
  );

  await setTransfer('completed');
  await panel.waitFor({ state: 'hidden' });
  assert.deepEqual(
    (await measure()).tables,
    idle.tables,
    `${variant}: file lists must reclaim space`,
  );
  await page.getByRole('button', { name: '传输记录', exact: true }).click();
  const history = page.getByRole('dialog', { name: '传输记录', exact: true });
  await history.getByText(/已完成/).waitFor();
  assert.equal(await history.getByText(/upload-report\.txt/).count(), 1);
  await history.getByRole('button', { name: '关闭对话框', exact: true }).click();
}

try {
  for (const [variant, width, height, theme] of [
    ['desktop', 1440, 1000, 'dark'],
    ...(fontSizeOnly
      ? [
          ['compact-desktop', 1366, 800, 'dark'],
          ['stacking-desktop', 1240, 800, 'dark'],
          ['wide-desktop', 1920, 1000, 'light'],
        ]
      : []),
    ['small', 900, 700, 'light'],
    ['mobile', 390, 844, 'light'],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.SERVERDECK_LAYOUT_URL ?? 'http://127.0.0.1:1421');
    await page.getByText('后端未连接', { exact: true }).waitFor();
    await fixtures(page, theme);
    for (const [label, view] of fontSizeOnly
      ? pages.filter(([, view]) => view === 'files')
      : pages) {
      await navigateWorkspace(page, label);
      await page.waitForFunction((view) => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
        return pinia._s.get('workspace').current?.view === view;
      }, view);
      await page
        .locator(view === 'terminals' ? '.terminal-pane:visible' : '.page-view:visible')
        .waitFor({ state: 'visible' });
      await page.evaluate(() => (document.querySelector('.content-scroll').scrollTop = 0));
      if (view === 'files') {
        const remote = page.getByRole('table', { name: '远程文件', exact: true });
        const local = page.getByRole('table', { name: '本地文件', exact: true });
        for (const pane of [local, remote]) {
          for (const [name, glyph] of [
            ['deploy.sh', 'file-terminal'],
            ['backup.tar.gz', 'file-archive'],
            ['cover.webp', 'file-image'],
            ['application.log', 'file'],
          ]) {
            const file = pane.getByRole('button', { name, exact: true });
            assert.equal(await file.locator(`svg.lucide-${glyph}`).count(), 1);
          }
        }
        assert.equal(
          await remote.getByRole('columnheader', { name: '权限', exact: true }).count(),
          1,
        );
        assert.equal(
          await remote.getByRole('columnheader', { name: '拥有者', exact: true }).count(),
          1,
        );
        assert.deepEqual(
          await remote.locator('tbody tr').first().locator('.file-metadata').allTextContents(),
          ['rwxr-xr-x', 'root'],
        );
        assert.equal(await local.locator('.file-metadata').count(), 0);
        // A plain browser cannot register Tauri's native drag/drop listener.
        await page
          .getByText(/^拖放入口不可用/)
          .first()
          .waitFor();
        await inspect(page, `${variant}/files-native-unavailable`);
        await page.evaluate(async () => {
          const { useNotificationsStore } = await import('/src/stores/notifications.ts');
          useNotificationsStore().items = [];
        });
        const columns = await page.locator('.file-columns').evaluate(
          (el) =>
            getComputedStyle(el)
              .gridTemplateColumns.split(' ')
              .filter((track) => parseFloat(track) > 0).length,
        );
        if (columns === 2) {
          const tops = await page
            .locator('.file-table')
            .evaluateAll((tables) => tables.map((table) => table.getBoundingClientRect().top));
          assert.equal(tops[0], tops[1], `${variant}: file lists aligned`);
        }
        if (!fontSizeOnly || variant === 'desktop') await verifyTransferLayout(page, variant);
        const largest = await verifyInterfaceFontSize(page, variant, width);
        results.push({ variant, view: 'files-ultra-large', ...largest });
        if (variant === 'desktop') {
          await verifyMouseDirectoryHistory(page);
          await verifyDownloadDragAndDelete(page);
        }
      }
      await page.mouse.move(width - 8, height - 8);
      await inspect(page, `${variant}/${view}`);
      await page.screenshot({ path: `${output}/${variant}-${view}.png` });
      if (view === 'server') {
        const tabs = page.locator('.page-view [role=tablist]').getByRole('tab');
        for (let n = 0; n < (await tabs.count()); n++) {
          await tabs.nth(n).click();
          await inspect(page, `${variant}/${view}-tab-${n}`);
        }
        await page.screenshot({ path: `${output}/${variant}-${view}-last-tab.png` });
      }
      if (view === 'settingsTerminal') {
        await page.getByLabel('全局默认代理').selectOption('socks5');
        await page.getByText('代理需要认证', { exact: true }).click();
        await inspect(page, `${variant}/proxy-settings`);
        await page.getByRole('button', { name: '保存设置', exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/${variant}-settings-bottom.png` });
      }
      results.push(`${variant}/${view}`);
    }
    assert.deepEqual(errors, [], `${variant}: browser errors`);
    await page.close();
  }
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
  console.log(
    `Passed ${results.length} menu pages plus form/dialog states. Screenshots: ${output}`,
  );
} finally {
  await browser.close();
}
