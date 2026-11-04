import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [source, destination] = process.argv.slice(2);
if (!source || !destination || !destination.endsWith('.sdplugin')) {
  throw new Error('Usage: node tools/package-plugin.mjs SOURCE OUTPUT.sdplugin');
}
const root = path.resolve(source);
const output = path.resolve(destination);
if (output === root || output.startsWith(root + path.sep)) {
  throw new Error('Output must be outside the source directory');
}
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const files = [];
const digests = [];
let total = 0;
async function walk(folder, prefix = '') {
  if ((await lstat(folder)).isSymbolicLink()) throw new Error('Links are forbidden');
  for (const name of (await readdir(folder)).sort()) {
    const relative = prefix + name;
    if (relative === 'manifest.json') continue;
    const target = path.join(folder, name);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) throw new Error('Links are forbidden');
    if (metadata.isDirectory()) {
      await walk(target, relative + '/');
      continue;
    }
    if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024 || files.length >= 128) {
      throw new Error('Unsupported file or package quota exceeded');
    }
    const data = await readFile(target);
    total += data.length;
    if (total > 12 * 1024 * 1024) throw new Error('Decoded package exceeds 12 MiB');
    files.push({ path: relative, content: data.toString('base64') });
    digests.push({
      path: relative,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
  }
}
await walk(root);
manifest.files = digests;
const bytes = JSON.stringify({ formatVersion: 1, manifest, files });
if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new Error('Package exceeds 16 MiB');
await writeFile(output, bytes, { flag: 'wx' });
process.stdout.write(
  `Created ${output} (${files.length} files, unverified local development package)\n`,
);
