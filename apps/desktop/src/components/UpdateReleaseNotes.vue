<script setup lang="ts">
import { computed } from 'vue';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { tr } from '../i18n/messages';
import { terminalApi } from '../services/terminal';
import { errorMessage } from '../services/ipc';
import { useNotificationsStore } from '../stores/notifications';

const props = defineProps<{ content: string }>();
const notifications = useNotificationsStore();
const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const generatedChangelog =
  /^\*\*Full Changelog\*\*: (https:\/\/github\.com\/kse-music\/operations\/compare\/v\d+\.\d+\.\d+\.\.\.v\d+\.\d+\.\d+)$/;

const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    paragraph({ text }) {
      const match = text.match(generatedChangelog);
      if (!match) return false;
      return `<p><a href="${match[1]}">${escapeHtml(tr('完整更新日志'))}</a></p>\n`;
    },
    html({ text }) {
      return escapeHtml(text);
    },
    image({ text }) {
      return escapeHtml(text);
    },
    link(token) {
      try {
        const url = new URL(token.href);
        if (url.protocol === 'https:' || url.protocol === 'http:') return false;
      } catch {
        // Relative and malformed links remain readable without navigating the WebView.
      }
      return this.parser.parseInline(token.tokens);
    },
  },
});
const rendered = computed(() => {
  try {
    return DOMPurify.sanitize(markdown.parse(props.content, { async: false }), {
      ALLOWED_TAGS: [
        'p',
        'br',
        'strong',
        'em',
        'del',
        'a',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'ul',
        'ol',
        'li',
        'blockquote',
        'pre',
        'code',
        'hr',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
      ],
      ALLOWED_ATTR: ['href', 'title', 'start', 'align'],
      ALLOWED_URI_REGEXP: /^https?:\/\//i,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    });
  } catch {
    console.warn('Release notes Markdown parsing failed');
    return null;
  }
});

async function openLink(event: MouseEvent): Promise<void> {
  const anchor = event.target instanceof Element ? event.target.closest('a') : null;
  if (!anchor) return;
  event.preventDefault();
  if (event.button !== 0 || !anchor.href) return;
  try {
    await terminalApi.openLink(anchor.href);
  } catch (cause) {
    notifications.push(errorMessage(cause), true);
  }
}
</script>

<template>
  <!-- Only the Markdown output sanitized with the allowlist above reaches v-html. -->
  <!-- eslint-disable vue/no-v-html -->
  <div
    v-if="rendered !== null"
    class="update-notes"
    @click="openLink"
    @auxclick="openLink"
    v-html="rendered"
  ></div>
  <!-- eslint-enable vue/no-v-html -->
  <div v-else class="update-notes">
    <p role="status">{{ tr('格式解析失败，已按文本显示。') }}</p>
    <pre>{{ content }}</pre>
  </div>
</template>
