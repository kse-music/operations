import { afterEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import { createPinia, disposePinia } from 'pinia';
import { setLocale } from '@serverdeck/plugin-sdk/i18n';
import DOMPurify from 'dompurify';
import UpdateReleaseNotes from './UpdateReleaseNotes.vue';
import { terminalApi } from '../services/terminal';
import { useNotificationsStore } from '../stores/notifications';

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  setLocale('zh-CN');
});

function mountNotes(content: string) {
  const pinia = createPinia();
  const props = reactive({ content });
  const root = document.createElement('div');
  const app = createApp({ render: () => h(UpdateReleaseNotes, props) }).use(pinia);
  app.mount(root);
  disposers.push(() => {
    app.unmount();
    disposePinia(pinia);
  });
  return { root, props, notifications: useNotificationsStore(pinia) };
}

it('renders release headings, lists, code, tables and Markdown entities', () => {
  const { root } = mountNotes(
    '## 更新内容\n\n- **修复连接**\n- *改善体验*与 `SSH`\n\n> 请先保存工作\n\n```sh\necho "<safe>"\n```\n\n|项目|状态|\n|---|---|\n|连接|已修复|\n\nTom &amp; Jerry\n下一行',
  );
  expect(root.querySelector('h2')?.textContent).toBe('更新内容');
  expect([...root.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
    '修复连接',
    '改善体验与 SSH',
  ]);
  expect(root.querySelector('strong')?.textContent).toBe('修复连接');
  expect(root.querySelector('em')?.textContent).toBe('改善体验');
  expect(root.querySelector('blockquote')?.textContent).toContain('请先保存工作');
  expect(root.querySelector('pre code')?.textContent).toBe('echo "<safe>"\n');
  expect([...root.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual([
    '连接',
    '已修复',
  ]);
  expect(root.textContent).toContain('Tom & Jerry');
  expect(root.querySelector('br')).not.toBeNull();
});

it('keeps raw HTML inert and blocks remote images and non-HTTP links', () => {
  const { root } = mountNotes(
    '<script>attack()</script>\n\n<img src="https://track.invalid/pixel" onerror="attack()">\n\n<svg onload="attack()"></svg>\n\n![tracking](https://track.invalid/pixel)\n\n[script](javascript:attack()) [encoded](jav&#x61;script:attack()) [data](data:text/html,attack) [file](file:///secret) [relative](/settings) [protocol-relative](//track.invalid) [ok](https://example.com/docs?a=1&b=2)',
  );
  expect(root.querySelector('script, img, svg, iframe, input, style')).toBeNull();
  expect(root.querySelector('[onerror], [onload], [style]')).toBeNull();
  expect(root.textContent).toContain('<script>attack()</script>');
  expect(root.textContent).toContain('tracking');
  expect([...root.querySelectorAll('a')].map((link) => link.href)).toEqual([
    'https://example.com/docs?a=1&b=2',
  ]);
});

it('labels the generated changelog link without changing its destination or the rest of the notes', async () => {
  const changelog = 'https://github.com/kse-music/operations/compare/v0.9.12...v0.9.13';
  const footer = `**Full Changelog**: ${changelog}`;
  const customLink = `**Full Changelog**: [版本对比](${changelog})`;
  const { root } = mountNotes(
    `## 更新内容\n\n${customLink}\n\n\`\`\`md\n${footer}\n\`\`\`\n\n${footer}`,
  );
  const links = root.querySelectorAll<HTMLAnchorElement>('a');
  expect(links).toHaveLength(2);
  expect(links[0].parentElement?.textContent).toBe('Full Changelog: 版本对比');
  expect(root.querySelector('pre code')?.textContent).toBe(`${footer}\n`);
  expect(links[1].parentElement?.textContent).toBe('完整更新日志');
  expect(links[1].getAttribute('href')).toBe(changelog);

  setLocale('en-US');
  await nextTick();
  expect(root.querySelector('p:last-child a')?.textContent).toBe('Full changelog');
});

it('opens links through the existing browser IPC and reports failures', async () => {
  const open = vi.spyOn(terminalApi, 'openLink').mockResolvedValue();
  const { root, notifications } = mountNotes('[**完整变更**](https://example.com/compare)');
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  root.querySelector('a strong')!.dispatchEvent(click);
  expect(click.defaultPrevented).toBe(true);
  expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/compare');

  const middle = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true });
  root.querySelector('a')!.dispatchEvent(middle);
  expect(middle.defaultPrevented).toBe(true);
  expect(open).toHaveBeenCalledTimes(1);

  open.mockRejectedValueOnce({ code: 'BROWSER_OPEN', message: '无法打开默认浏览器' });
  root.querySelector<HTMLAnchorElement>('a')!.click();
  await nextTick();
  expect(notifications.items).toEqual([
    expect.objectContaining({ text: '无法打开默认浏览器', error: true }),
  ]);
});

it('replaces old notes when release content changes', async () => {
  const { root, props } = mountNotes('**旧说明**');
  props.content = '[新说明](https://example.com/new)';
  await nextTick();
  expect(root.querySelector('strong')).toBeNull();
  expect(root.querySelector('a')?.textContent).toBe('新说明');
});

it('reports a rendering failure and retains the original notes as inert text', () => {
  vi.spyOn(DOMPurify, 'sanitize').mockImplementationOnce(() => {
    throw new Error('render failure');
  });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const content = '**更新** <img src="https://track.invalid/pixel">';
  const { root } = mountNotes(content);
  expect(root.querySelector('[role="status"]')?.textContent).toBe('格式解析失败，已按文本显示。');
  expect(root.querySelector('pre')?.textContent).toBe(content);
  expect(root.querySelector('img')).toBeNull();
  expect(warning).toHaveBeenCalledWith('Release notes Markdown parsing failed');
});
