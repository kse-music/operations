import type { HostInput } from '../types/hosts';
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
