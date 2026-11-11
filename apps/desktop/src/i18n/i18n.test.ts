import { afterEach, expect, it } from 'vitest';
import { computed } from 'vue';
import { createTranslator, setLocale } from '@serverdeck/plugin-sdk/i18n';
import desktop from './en.json';
import sdk from '../../../../packages/plugin-sdk/src/i18n/en.json';
import assistant from '../../../../plugins/system/assistant/frontend/i18n/en.json';
import docker from '../../../../plugins/system/docker/frontend/i18n/en.json';
import { settingsCategories, viewLabels } from '../types/product';
import { stateLabels } from '../types/terminal';

afterEach(() => setLocale('zh-CN'));

it('updates existing navigation and connection labels reactively', () => {
  const labels = computed(() => [
    settingsCategories[0].label,
    viewLabels.files,
    stateLabels.connected,
  ]);
  expect(labels.value).toEqual(['通用', 'SFTP 文件', '已连接']);
  setLocale('en-US');
  expect(labels.value).toEqual(['General', 'SFTP files', 'Connected']);
  setLocale('zh-CN');
  expect(labels.value).toEqual(['通用', 'SFTP 文件', '已连接']);
});

it('preserves user text and placeholder-looking content without recursive substitution', () => {
  const tr = createTranslator({ '主机 {0}：{1}': 'Host {0}: {1}' });
  setLocale('en-US');
  expect(tr('主机 {0}：{1}', '设置{1}', '<script>中文</script>')).toBe(
    'Host 设置{1}: <script>中文</script>',
  );
  expect(tr('自定义名称')).toBe('自定义名称');
  expect(tr('constructor')).toBe('constructor');
  expect(tr('__proto__')).toBe('__proto__');
});

it.each(Object.entries({ desktop, sdk, assistant, docker }))(
  '%s translations retain interpolation arguments',
  (_name, dictionary) => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{\d+\}/g)].map(([value]) => value).sort();
    for (const [source, translation] of Object.entries(dictionary)) {
      expect(translation.trim(), source).not.toBe('');
      expect(placeholders(translation), source).toEqual(placeholders(source));
    }
  },
);
