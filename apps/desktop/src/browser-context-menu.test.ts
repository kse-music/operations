import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import script from '../src-tauri/src/prevent-native-context-menu.js?raw';

function fixture() {
  const page = document.implementation.createHTMLDocument();
  page.body.innerHTML = '<main></main><input><textarea></textarea><div contenteditable></div>';
  runInNewContext(script, { document: page });
  return page;
}

it('suppresses the browser menu on blank areas, inputs and dynamically added dialogs', () => {
  const page = fixture();
  const dialog = page.createElement('dialog');
  page.body.append(dialog);
  for (const target of [page.body, ...page.body.children]) {
    for (const shiftKey of [false, true]) {
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        shiftKey,
      });
      expect(target.dispatchEvent(event)).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    }
  }
});

it('preserves business menus even when their handlers stop propagation', () => {
  const page = fixture();
  const target = page.querySelector('main')!;
  const handler = vi.fn((event: Event) => {
    expect(event.defaultPrevented).toBe(true);
    event.stopPropagation();
    const menu = page.createElement('button');
    menu.textContent = '复制';
    page.body.append(menu);
  });
  target.addEventListener('contextmenu', handler);
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expect(handler).toHaveBeenCalledOnce();
  expect(page.querySelector('button')?.textContent).toBe('复制');
});

it('leaves keyboard, selection and clipboard events available to the application', () => {
  const page = fixture();
  const input = page.querySelector('textarea')!;
  for (const type of ['keydown', 'keyup', 'selectstart', 'copy', 'cut', 'paste']) {
    const handler = vi.fn();
    input.addEventListener(type, handler);
    const event = new Event(type, { bubbles: true, cancelable: true });
    expect(input.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(handler).toHaveBeenCalledOnce();
  }
});
