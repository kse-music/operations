import { expect, it } from 'vitest';
import { osc52Text } from './osc52';

const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64');

it.each(['c', '', 's', 'cs'])('decodes UTF-8 clipboard writes for selection "%s"', (selection) => {
  const text = '\ufeff你好 🙂\r\nsecond line';
  expect(osc52Text(`${selection};${encode(text)}`)).toBe(text);
});

it.each(['c;?', ';?', 'p;?', 'p;dGV4dA==', 'q;dGV4dA==', '8;dGV4dA==', 'c', 'c;', 'c;!'])(
  'ignores queries, other selections, empty writes and malformed data: %s',
  (data) => expect(osc52Text(data)).toBeNull(),
);

it.each(['c;Z', 'c;====', 'c;dGV4dA===', 'c;dGV4dA==;extra', 'c;dGV4 dA==', 'c;/w=='])(
  'rejects invalid Base64 or UTF-8 without changing the text: %s',
  (data) => expect(osc52Text(data)).toBeNull(),
);

it('accepts unpadded Base64 used by terminal applications', () => {
  expect(osc52Text('c;5L2g5aW9')).toBe('你好');
  expect(osc52Text('c;dGV4dA')).toBe('text');
});

it('limits decoded text to 2 MiB, including payloads with the same encoded length', () => {
  const text = 'x'.repeat(2 * 1024 * 1024);
  expect(osc52Text(`c;${encode(text)}`)).toBe(text);
  expect(osc52Text(`c;${encode(text + 'x')}`)).toBeNull();
  expect(osc52Text(`c;${encode(text + 'xxx')}`)).toBeNull();
});
