import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppVersion } from './app-version.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));

export function releaseTag(version) {
  assert.match(
    version,
    /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$/,
    'only stable Cargo workspace versions can be released',
  );
  return `v${version}`;
}

export function prepareReleaseNotes({ version, sha, repo, notes = '' }, run = execFileSync) {
  const tag = releaseTag(version);
  if (!notes.trim()) {
    assert.match(sha, /^[0-9a-f]{40}$/, 'release requires the full workflow commit SHA');
    assert.match(repo, /^[\w.-]+\/[\w.-]+$/, 'release requires the GitHub owner/repository');
    const response = run(
      'gh',
      ['api', `repos/${repo}/releases/generate-notes`, '--method', 'POST', '--input', '-'],
      {
        input: JSON.stringify({ tag_name: tag, target_commitish: sha }),
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    notes = JSON.parse(response).body;
  }
  assert(typeof notes === 'string' && notes.trim(), 'release notes are empty or invalid');
  assert(Buffer.byteLength(notes, 'utf8') <= 64 * 1024, 'release notes exceed 64 KiB');
  return notes;
}

export function ensureReleaseTag({ version, sha, cwd = repository }) {
  const tag = releaseTag(version);
  assert.match(sha, /^[0-9a-f]{40}$/, 'release requires the full workflow commit SHA');
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), sha, 'release must use the checked-out workflow commit');
  const ref = `refs/tags/${tag}`;
  const references = new Map(
    git('ls-remote', '--tags', 'origin', ref, `${ref}^{}`)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [target, name] = line.trim().split(/\s+/);
        return [name, target];
      }),
  );
  const existing = references.get(`${ref}^{}`) ?? references.get(ref);
  if (existing) {
    assert.equal(
      existing,
      sha,
      `${tag} already belongs to another commit; increase Cargo.toml version`,
    );
    return { tag, created: false };
  }
  // Push exactly this immutable commit; never move or force-replace an existing tag.
  git('push', 'origin', `${sha}:${ref}`);
  return { tag, created: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  assert(
    ['--prepare', '--create-tag'].includes(command),
    'usage: node tools/update-release.mjs <--prepare|--create-tag>',
  );
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'release requires a manual run');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'release must run from main');
  const version = readAppVersion();
  const sha = process.env.GITHUB_SHA;
  if (command === '--prepare') {
    assert(process.env.GITHUB_OUTPUT, 'release preparation requires GITHUB_OUTPUT');
    const notes = prepareReleaseNotes({
      version,
      sha,
      repo: process.env.GITHUB_REPOSITORY,
      notes: process.env.RELEASE_NOTES,
    });
    const directory = path.join(repository, '.local/update-release');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'notes.txt'), notes);
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${releaseTag(version)}\n`);
  } else {
    const result = ensureReleaseTag({ version, sha });
    console.log(`${result.created ? 'Created' : 'Reused'} ${result.tag} at ${sha}`);
  }
}
