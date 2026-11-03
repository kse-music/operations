import { defineComponent, h, type VNodeChild } from 'vue';
import { Lexer, type MarkedToken, type Token } from 'marked';

function text(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return named[name.toLowerCase()] ?? entity;
    const n = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
      ? String.fromCodePoint(n)
      : '\ufffd';
  });
}

// Build Vue nodes from a fixed set of Markdown tokens. Never interpret model HTML.
function nodes(tokens: Token[], depth = 0): VNodeChild[] {
  return tokens.map((raw): VNodeChild => {
    if (depth > 32) return raw.raw;
    const t = raw as MarkedToken;
    const nested = (items: Token[]) => nodes(items, depth + 1);
    switch (t.type) {
      case 'space':
      case 'def':
        return null;
      case 'heading':
        return h(`h${Math.min(6, Math.max(2, t.depth + 1))}`, nested(t.tokens));
      case 'paragraph':
        return h('p', nested(t.tokens));
      case 'text':
        return 'tokens' in t && t.tokens ? nested(t.tokens) : text(t.text);
      case 'escape':
        return text(t.text);
      case 'html':
        return t.text;
      case 'strong':
        return h('strong', nested(t.tokens));
      case 'em':
        return h('em', nested(t.tokens));
      case 'del':
        return h('del', nested(t.tokens));
      case 'codespan':
        return h('code', text(t.text));
      case 'code':
        return h('pre', { tabindex: 0 }, [h('code', t.text)]);
      case 'br':
        return h('br');
      case 'hr':
        return h('hr');
      case 'blockquote':
        return h('blockquote', nested(t.tokens));
      case 'list':
        return h(
          t.ordered ? 'ol' : 'ul',
          t.ordered && t.start !== '' ? { start: t.start } : {},
          t.items.map((item) =>
            h('li', [item.task ? (item.checked ? '☑ ' : '☐ ') : '', ...nested(item.tokens)]),
          ),
        );
      case 'list_item':
        return h('li', nested(t.tokens));
      case 'link': {
        let href = '';
        try {
          const url = new URL(text(t.href));
          if (['https:', 'http:'].includes(url.protocol)) href = url.href;
        } catch {
          /* A relative or malformed URL is shown as text. */
        }
        return href
          ? h(
              'a',
              { href, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' },
              nested(t.tokens),
            )
          : h('span', nested(t.tokens));
      }
      case 'image':
        return h('span', { class: 'ai-image-alt' }, `[图片：${t.text || '未加载'}]`);
      case 'table':
        return h('div', { class: 'ai-markdown-table', tabindex: 0 }, [
          h('table', [
            h('thead', [
              h(
                'tr',
                t.header.map((cell) => h('th', nested(cell.tokens))),
              ),
            ]),
            h(
              'tbody',
              t.rows.map((row) =>
                h(
                  'tr',
                  row.map((cell) => h('td', nested(cell.tokens))),
                ),
              ),
            ),
          ]),
        ]);
      default:
        return raw.raw;
    }
  });
}
export default defineComponent({
  props: { content: { type: String, required: true } },
  setup(props) {
    return () => {
      try {
        return h(
          'div',
          { class: 'ai-markdown' },
          nodes(Lexer.lex(props.content, { gfm: true, breaks: true })),
        );
      } catch {
        return h('div', { class: 'ai-markdown' }, [
          h('p', { role: 'status' }, '格式解析失败，已按文本显示。'),
          h('pre', props.content),
        ]);
      }
    };
  },
});
