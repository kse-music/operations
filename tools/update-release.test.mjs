import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureReleaseTag, releaseTag } from './update-release.mjs';

const qa = fileURLToPath(new URL('../.local/qa/update-release/', import.meta.url));

async function fixture(t) {
  await mkdir(qa, { recursive: true });
  const root = await mkdtemp(path.join(qa, 'unit-'));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(qa));
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true });
  });
  const remote = path.join(root, 'origin.git');
  const cwd = path.join(root, 'work');
  const gitAt = (directory, ...args) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'pipe',
    }).trim();
  gitAt(root, 'init', '--bare', remote);
  gitAt(root, 'init', '--initial-branch=main', cwd);
  const git = (...args) => gitAt(cwd, ...args);
  git('config', 'user.name', 'Release fixture');
  git('config', 'user.email', 'release-fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  await writeFile(path.join(cwd, 'source.txt'), 'first release\n');
  git('add', 'source.txt');
  git('commit', '-m', 'First fixture commit');
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'main');
  return {
    cwd,
    git,
    remoteGit: (...args) => gitAt(remote, ...args),
    sha: git('rev-parse', 'HEAD'),
  };
}

test('derives tags from stable workspace versions and rejects prereleases and invalid versions', () => {
  assert.equal(releaseTag('0.8.0'), 'v0.8.0');
  assert.equal(releaseTag('10.20.30'), 'v10.20.30');
  for (const version of ['v0.8.0', '0.8.0-beta.1', '1.2', '01.2.3', '1x2x3']) {
    assert.throws(() => releaseTag(version));
  }
});

test('tag creation entry rejects automatic events and manual runs outside main before any Git access', () => {
  const script = fileURLToPath(new URL('./update-release.mjs', import.meta.url));
  for (const [event, ref, message] of [
    ['push', 'refs/heads/main', 'manual run'],
    ['workflow_dispatch', 'refs/heads/feature', 'must run from main'],
  ]) {
    const result = spawnSync(process.execPath, [script, '--create-tag'], {
      env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert(result.stderr.includes(message));
  }
});

test('creates the remote tag at the exact workflow commit and can retry without moving it', async (t) => {
  const { cwd, remoteGit, sha } = await fixture(t);
  const input = { cwd, sha, version: '0.8.0' };
  assert.deepEqual(ensureReleaseTag(input), { tag: 'v0.8.0', created: true });
  assert.equal(remoteGit('rev-parse', 'refs/tags/v0.8.0'), sha);
  assert.deepEqual(ensureReleaseTag(input), { tag: 'v0.8.0', created: false });
  assert.equal(remoteGit('rev-parse', 'refs/heads/main'), sha);
});

test('accepts an existing annotated tag at the same commit without replacing the tag object', async (t) => {
  const { cwd, git, remoteGit, sha } = await fixture(t);
  git('tag', '-a', 'v0.8.0', '-m', 'Existing annotated release');
  git('push', 'origin', 'refs/tags/v0.8.0');
  const original = remoteGit('rev-parse', 'refs/tags/v0.8.0');
  assert.notEqual(original, sha);
  assert.equal(ensureReleaseTag({ cwd, sha, version: '0.8.0' }).created, false);
  assert.equal(remoteGit('rev-parse', 'refs/tags/v0.8.0'), original);
});

test('rejects a reused version on a different commit and preserves the original remote tag', async (t) => {
  const { cwd, git, remoteGit, sha } = await fixture(t);
  ensureReleaseTag({ cwd, sha, version: '0.8.0' });
  await writeFile(path.join(cwd, 'source.txt'), 'next commit\n');
  git('commit', '-am', 'Changed fixture source');
  const next = git('rev-parse', 'HEAD');
  assert.throws(() => ensureReleaseTag({ cwd, sha: next, version: '0.8.0' }), /another commit/);
  assert.equal(remoteGit('rev-parse', 'refs/tags/v0.8.0'), sha);
  assert.throws(
    () => ensureReleaseTag({ cwd, sha, version: '0.8.1' }),
    /checked-out workflow commit/,
  );
  assert.equal(remoteGit('tag', '--list', 'v0.8.1'), '');
});
