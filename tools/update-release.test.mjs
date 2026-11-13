import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ensureReleaseTag, prepareReleaseNotes, releaseTag } from './update-release.mjs';
import { updateManifest } from './update-manifest.mjs';

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

test('release entries reject automatic events and manual runs outside main before any Git access', () => {
  const script = fileURLToPath(new URL('./update-release.mjs', import.meta.url));
  for (const [event, ref, message] of [
    ['push', 'refs/heads/main', 'manual run'],
    ['workflow_dispatch', 'refs/heads/feature', 'must run from main'],
  ]) {
    for (const command of ['--prepare', '--create-tag']) {
      const result = spawnSync(process.execPath, [script, command], {
        env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: ref },
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(result.status, 1);
      assert(result.stderr.includes(message));
    }
  }
});

const notesInput = { version: '0.9.0', sha: 'a'.repeat(40), repo: 'kse-music/operations' };

test('custom release notes preserve Unicode, newlines and shell text without calling GitHub', () => {
  const notes = ' 修复终端问题\n保留 `$HOME` 与 $(literal) 原文\n';
  assert.equal(
    prepareReleaseNotes({ ...notesInput, notes }, () => assert.fail('must not call GitHub')),
    notes,
  );
});

test('blank notes generate against the exact release commit and feed the same body to the updater', () => {
  const body = "## What's Changed\n* 修复终端问题 by @contributor in #10\n";
  for (const blank of [undefined, '', ' \n\t']) {
    let calls = 0;
    const notes = prepareReleaseNotes({ ...notesInput, notes: blank }, (command, args, options) => {
      calls += 1;
      assert.equal(command, 'gh');
      assert.deepEqual(args, [
        'api',
        'repos/kse-music/operations/releases/generate-notes',
        '--method',
        'POST',
        '--input',
        '-',
      ]);
      assert.deepEqual(JSON.parse(options.input), {
        tag_name: 'v0.9.0',
        target_commitish: notesInput.sha,
      });
      assert.notEqual(options.shell, true);
      return JSON.stringify({ name: 'v0.9.0', body });
    });
    assert.equal(calls, 1);
    assert.equal(notes, body);
    assert.equal(
      updateManifest({
        version: '0.9.0',
        signature: Buffer.from('trusted comment: timestamp:1\tversion:0.9.0\n').toString('base64'),
        notes,
        publishedAt: '2026-11-14T00:00:00Z',
      }).notes,
      body,
    );
  }
});

test('note generation propagates API failures and rejects malformed or empty responses', () => {
  const failure = new Error('GitHub API unavailable');
  assert.throws(
    () =>
      prepareReleaseNotes(notesInput, () => {
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.throws(() => prepareReleaseNotes(notesInput, () => 'not JSON'), SyntaxError);
  for (const body of [undefined, null, 123, '', ' \n']) {
    assert.throws(
      () => prepareReleaseNotes(notesInput, () => JSON.stringify({ body })),
      /release notes are empty or invalid/,
    );
  }
});

test('custom and generated notes respect the updater UTF-8 byte limit without truncation', () => {
  const boundary = 'a'.repeat(64 * 1024);
  assert.equal(prepareReleaseNotes({ ...notesInput, notes: boundary }), boundary);
  const oversized = '中'.repeat(22 * 1024);
  for (const input of [{ ...notesInput, notes: oversized }, notesInput]) {
    assert.throws(
      () => prepareReleaseNotes(input, () => JSON.stringify({ body: oversized })),
      /release notes exceed 64 KiB/,
    );
  }
});

test('generation rejects invalid version, repository or commit before calling GitHub', () => {
  for (const changed of [{ version: '0.9.0-beta.1' }, { sha: 'main' }, { repo: 'operations' }]) {
    let calls = 0;
    assert.throws(() =>
      prepareReleaseNotes({ ...notesInput, ...changed }, () => {
        calls += 1;
      }),
    );
    assert.equal(calls, 0);
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
