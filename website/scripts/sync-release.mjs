import { writeFile, rename } from 'node:fs/promises';
import { parseRelease } from './release.mjs';

try {
  const response = await fetch(
    'https://api.github.com/repos/kse-music/operations/releases/latest',
    {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ServerDeck-Website' },
      signal: AbortSignal.timeout(25000),
    },
  );
  if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}；保留现有下载信息。`);
  const release = parseRelease(await response.json());
  const target = new URL('../src/release.json', import.meta.url);
  const temporary = new URL('../src/release.json.tmp', import.meta.url);
  await writeFile(temporary, `${JSON.stringify(release, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
  console.log(`已同步正式发布 v${release.version}（Windows x64）。`);
} catch (error) {
  console.error(error instanceof Error ? error.message : '同步 Release 失败；保留现有下载信息。');
  process.exitCode = 1;
}
