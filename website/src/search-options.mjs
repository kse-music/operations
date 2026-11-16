/** @param {string} text */
export function tokenize(text) {
  return Array.from(new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(text), (part) =>
    part.segment.toLowerCase(),
  ).filter((part) => /[\p{L}\p{N}]/u.test(part));
}

export const searchOptions = {
  fields: ['title', 'pageTitle', 'text'],
  storeFields: ['title', 'pageTitle', 'text', 'url'],
  tokenize,
  searchOptions: {
    prefix: true,
    fuzzy: 0.2,
    combineWith: /** @type {'AND'} */ ('AND'),
    boost: { title: 5, pageTitle: 3, text: 1 },
  },
};
