import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

// Browser-only selection checks. Copy events are intercepted to preserve the system clipboard.
const output = process.env.SERVERDECK_SELECTION_OUTPUT ?? '.local/qa/selection-scope';
await mkdir(output, { recursive: true });
const server = await createServer({
  root: 'apps/desktop',
  mode: 'test',
  server: { host: '127.0.0.1', port: 15440, strictPort: true },
});
await server.listen();
let browser;
const passed = [];

async function dragText(page, element) {
  const points = await element.evaluate((element) => {
    window.getSelection().removeAllRanges();
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 1);
    const first = range.getBoundingClientRect();
    range.setStart(node, node.textContent.length - 1);
    range.setEnd(node, node.textContent.length);
    const last = range.getBoundingClientRect();
    return {
      x1: first.left + 0.5,
      y1: first.top + first.height / 2,
      x2: last.right - 0.5,
      y2: last.top + last.height / 2,
    };
  });
  await page.mouse.move(points.x1, points.y1);
  await page.mouse.down();
  await page.mouse.move(points.x2, points.y2, { steps: 16 });
  await page.mouse.up();
  return page.evaluate(() => window.getSelection().toString());
}

async function copyToast(page, message) {
  await page.evaluate(async (message) => {
    const { useNotificationsStore } = await import('/src/stores/notifications.ts');
    const notifications = useNotificationsStore();
    notifications.items = [];
    notifications.push(message, true);
  }, message);
  const text = page.locator('.toast > span').filter({ hasText: message });
  await text.waitFor();
  assert.equal(await dragText(page, text), message);
  await text.evaluate((element) => {
    document.addEventListener(
      'copy',
      (event) => {
        event.preventDefault();
        element.dataset.copied = window.getSelection().toString();
      },
      { once: true },
    );
  });
  await page.keyboard.press('Control+c');
  assert.equal(await text.getAttribute('data-copied'), message);
  await page.getByRole('button', { name: '关闭通知', exact: true }).click();
}

try {
  browser = await chromium.launch({
    executablePath:
      process.env.SERVERDECK_BROWSER ??
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('http://127.0.0.1:15440');
  await page.locator('.app-brand strong').waitFor();
  await page.evaluate(async () => {
    const { useNotificationsStore } = await import('/src/stores/notifications.ts');
    useNotificationsStore().items = [];
  });

  for (const selector of ['.app-brand strong', '.app-search-button span']) {
    assert.equal(
      await dragText(page, page.locator(selector)),
      '',
      `${selector}: UI text was selected`,
    );
    await page.keyboard.press('Escape');
  }
  await page.locator('.app-brand').click();
  await page.keyboard.press('Control+a');
  assert.equal(await page.evaluate(() => window.getSelection().toString()), '');
  passed.push('Chrome drag and Ctrl+A do not select interface labels');

  await copyToast(page, '消息仍能选中复制，包含中文和 Unicode 🚀');
  passed.push('Page notification remains selectable and copyable');

  await page.locator('.host-list-heading [aria-label="新建主机"]').click();
  const dialog = page.getByRole('dialog', { name: '新建主机', exact: true });
  const input = dialog.getByLabel('主机名称（可选）', { exact: true });
  const value = 'selection-input-中文';
  await input.fill(value);
  await input.press('Control+a');
  assert.deepEqual(
    await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [0, value.length],
  );
  passed.push('Real host form input supports selecting its text');
  await copyToast(page, '弹窗中的消息仍能选中复制');
  passed.push('Dialog notification remains selectable and copyable');
  await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();

  // Exercise the shared text-content selectors without saving settings or opening remote resources.
  await page.evaluate(() => {
    const fixture = document.createElement('section');
    fixture.id = 'selection-fixture';
    fixture.style.cssText =
      'position:fixed;left:320px;top:300px;z-index:1000;background:var(--panel);padding:20px';
    fixture.innerHTML =
      '<textarea>textarea-中文</textarea><div contenteditable="true">editable-中文</div><pre>output-中文</pre>';
    document.body.append(fixture);
  });
  const textarea = page.locator('#selection-fixture textarea');
  await textarea.click();
  await textarea.press('Control+a');
  assert.equal(
    await textarea.evaluate((element) =>
      element.value.slice(element.selectionStart, element.selectionEnd),
    ),
    'textarea-中文',
  );
  assert.equal(
    await dragText(page, page.locator('#selection-fixture [contenteditable]')),
    'editable-中文',
  );
  assert.equal(await dragText(page, page.locator('#selection-fixture pre')), 'output-中文');
  passed.push('Textarea, editable content and text output support selection');
  await page.locator('#selection-fixture').evaluate((element) => element.remove());
  await page.screenshot({ path: `${output}/selection-scope.png` });
  await writeFile(`${output}/results.json`, JSON.stringify({ passed }, null, 2));
  console.log(`Passed ${passed.length} selection checks`);
} finally {
  await browser?.close();
  await server.close();
}
