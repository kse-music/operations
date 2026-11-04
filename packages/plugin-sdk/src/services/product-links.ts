import type { HostInput } from '../types/hosts';
// ss output only: do not infer a process from a port number or a command name.
export function pidPorts(rows: Record<string, unknown>[], pid: number): Record<string, unknown>[] {
  if (!Number.isSafeInteger(pid) || pid < 1) return [];
  const pattern = new RegExp(`\\bpid=${pid}(?=[,)\\s]|$)`);
  return rows.filter((r) => typeof r.process === 'string' && pattern.test(r.process));
}

export function sameHostConnection(a: HostInput, b: HostInput): boolean {
  return (
    a.hostname === b.hostname &&
    a.port === b.port &&
    a.username === b.username &&
    a.authType === b.authType &&
    a.credentialId === b.credentialId &&
    JSON.stringify(a.ssh) === JSON.stringify(b.ssh)
  );
}
