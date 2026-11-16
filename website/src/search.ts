import MiniSearch from 'minisearch';
import { searchOptions } from './search-options.mjs';

export interface SearchDocument {
  id: string;
  title: string;
  pageTitle: string;
  text: string;
  url: string;
}
let loaded: Promise<MiniSearch<SearchDocument>> | undefined;

export function loadSearchIndex(reload = false) {
  if (!loaded || reload || import.meta.env.DEV) {
    loaded = fetch('/search-index.json', { cache: import.meta.env.DEV ? 'no-store' : 'default' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`文档搜索索引加载失败（HTTP ${response.status}）`);
        const data = (await response.json()) as { version: number; index: object };
        if (data.version !== 1 || !data.index) throw new Error('文档搜索索引格式不匹配');
        return MiniSearch.loadJSON<SearchDocument>(JSON.stringify(data.index), searchOptions);
      })
      .catch((error) => {
        loaded = undefined;
        throw error;
      });
  }
  return loaded;
}

export function searchExcerpt(text: string, query: string) {
  const position = text.toLowerCase().indexOf(query.trim().toLowerCase());
  const start = Math.max(0, position - 32);
  return (
    (start ? '…' : '') + text.slice(start, start + 150) + (text.length > start + 150 ? '…' : '')
  );
}
