import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppVersion } from './app-version.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const exceptionVersion = '0.9.6';
const advisoryId = 'GHSA-fc5q-39xc-vjpf';
const advisoryUrl = `https://github.com/advisories/${advisoryId}`;
const nonblocking = new Set(['info', 'low']);
const blocking = new Set(['moderate', 'high', 'critical']);

export function allowsPicomatchException(version, report, packages) {
  if (version !== exceptionVersion || report?.auditReportVersion !== 2 || report.error)
    return false;
  const findings = new Map(Object.entries(report.vulnerabilities ?? {}));
  const counts = report.metadata?.vulnerabilities;
  if (findings.size !== counts?.total || !findings.size) return false;
  for (const [name, finding] of findings) {
    if (
      finding?.name !== name ||
      (!blocking.has(finding.severity) && !nonblocking.has(finding.severity)) ||
      !Array.isArray(finding.via) ||
      !finding.via.length
    )
      return false;
  }

  const picomatch = findings.get('picomatch');
  const copies = Object.entries(packages ?? {}).filter(
    ([location, entry]) =>
      /(?:^|\/)node_modules\/picomatch$/.test(location) || entry?.name === 'picomatch',
  );
  if (
    picomatch?.severity !== 'high' ||
    !Array.isArray(picomatch.nodes) ||
    !copies.length ||
    copies.length !== picomatch.nodes.length ||
    !copies.every(
      ([location, entry]) =>
        entry?.version === '4.0.7' && entry.dev === true && picomatch.nodes.includes(location),
    )
  )
    return false;

  // A via string points to another finding. Only resolve chains rooted in the approved advisory.
  const pending = [...findings].filter(([, finding]) => blocking.has(finding.severity));
  const covered = new Set();
  for (let previous = -1; covered.size !== previous;) {
    previous = covered.size;
    for (const [name, finding] of pending) {
      const causes = finding.via.filter(
        (cause) =>
          !nonblocking.has(
            typeof cause === 'string' ? findings.get(cause)?.severity : cause?.severity,
          ),
      );
      if (
        finding.severity === 'high' &&
        causes.length &&
        causes.every((cause) =>
          typeof cause === 'string'
            ? covered.has(cause)
            : name === 'picomatch' &&
              cause?.name === 'picomatch' &&
              cause.dependency === 'picomatch' &&
              cause.severity === 'high' &&
              cause.url === advisoryUrl,
        )
      )
        covered.add(name);
    }
  }
  return covered.has('picomatch') && covered.size === pending.length;
}

function runAudit() {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run the release audit with npm run audit:release');
  const result = spawnSync(
    process.execPath,
    [
      npm,
      'audit',
      '--package-lock-only',
      '--audit-level=moderate',
      '--json',
      '--include=dev',
      '--include=optional',
      '--include=peer',
    ],
    { cwd: repository, encoding: 'utf8', windowsHide: true },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status !== 1) return;

  const report = JSON.parse(result.stdout);
  if (report?.auditReportVersion !== 2 || report.error) return;
  const lock = JSON.parse(readFileSync(path.join(repository, 'package-lock.json'), 'utf8'));
  if (allowsPicomatchException(readAppVersion(), report, lock.packages)) {
    console.warn(
      `Release v${exceptionVersion} accepts ${advisoryId} for development-only picomatch@4.0.7`,
    );
    process.exitCode = 0;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runAudit();
