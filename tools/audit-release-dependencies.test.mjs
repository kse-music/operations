import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowsPicomatchException } from './audit-release-dependencies.mjs';

const packagePath = 'node_modules/picomatch';
const packages = { [packagePath]: { version: '4.0.7', dev: true } };
const advisory = {
  name: 'picomatch',
  dependency: 'picomatch',
  severity: 'high',
  url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
};

function auditReport(extraFindings = {}) {
  const vulnerabilities = {
    vite: { name: 'vite', severity: 'high', via: ['tinyglobby', 'picomatch'] },
    tinyglobby: { name: 'tinyglobby', severity: 'high', via: ['picomatch'] },
    picomatch: { name: 'picomatch', severity: 'high', via: [advisory], nodes: [packagePath] },
    ...extraFindings,
  };
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: { total: Object.keys(vulnerabilities).length } },
  };
}

test('allows the v0.9.6 dev advisory and its dependent findings', () => {
  const report = auditReport({
    other: { name: 'other', severity: 'low', via: [{ severity: 'low' }] },
  });
  report.vulnerabilities.vite.via.push('other');
  assert.equal(allowsPicomatchException('0.9.6', report, packages), true);
});

test('still blocks a new moderate advisory or another advisory for picomatch itself', () => {
  const other = { severity: 'moderate', url: 'https://example.invalid/advisories/other' };
  assert.equal(
    allowsPicomatchException(
      '0.9.6',
      auditReport({
        other: { name: 'other', severity: 'moderate', via: [other] },
      }),
      packages,
    ),
    false,
  );
  const report = auditReport();
  report.vulnerabilities.picomatch.via.push(other);
  assert.equal(allowsPicomatchException('0.9.6', report, packages), false);
});

test('expires on a version bump and rejects a different or production picomatch copy', () => {
  const report = auditReport();
  assert.equal(allowsPicomatchException('0.9.7', report, packages), false);
  assert.equal(
    allowsPicomatchException('0.9.6', report, { [packagePath]: { version: '4.0.7' } }),
    false,
  );
  assert.equal(
    allowsPicomatchException('0.9.6', report, {
      [packagePath]: { version: '4.0.6', dev: true },
    }),
    false,
  );
  assert.equal(
    allowsPicomatchException('0.9.6', report, {
      ...packages,
      'node_modules/plugin/node_modules/other-name': { name: 'picomatch', version: '4.0.7' },
    }),
    false,
  );
});

test('blocks registry errors, incomplete reports, and findings without a path to the advisory', () => {
  const report = auditReport();
  assert.equal(
    allowsPicomatchException('0.9.6', { ...report, error: { code: 'E503' } }, packages),
    false,
  );
  assert.equal(allowsPicomatchException('0.9.6', { ...report, metadata: {} }, packages), false);
  report.vulnerabilities.vite.via.push('unknown');
  assert.equal(allowsPicomatchException('0.9.6', report, packages), false);
  report.vulnerabilities.vite.via = ['vite'];
  assert.equal(allowsPicomatchException('0.9.6', report, packages), false);
});
