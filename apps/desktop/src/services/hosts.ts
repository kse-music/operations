import { invoke } from '@tauri-apps/api/core';
import { ensureDesktop } from './ipc';
import type {
  Catalog,
  Credential,
  CredentialInput,
  Host,
  HostAuthenticationInput,
  HostKeyFingerprint,
  HostTestResult,
  HostGroup,
  HostInput,
  ImportPreview,
  Mutation,
  SecureStatus,
} from '../types/hosts';
function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  ensureDesktop();
  return invoke<T>(command, args);
}
export const hostsApi = {
  list: () => call<Catalog>('host_list'),
  test: (
    input: HostInput,
    authentication?: HostAuthenticationInput,
    confirmed?: HostKeyFingerprint,
    hostId?: string,
  ) => call<HostTestResult>('host_test', { input, authentication, confirmed, hostId }),
  create: (input: HostInput, authentication: HostAuthenticationInput | undefined, testId: string) =>
    call<Host>('host_create_tested', { input, authentication, testId }),
  update: (id: string, input: HostInput, authentication?: HostAuthenticationInput) =>
    call<Host>('host_update', { id, input, authentication }),
  updateTested: (
    id: string,
    input: HostInput,
    authentication: HostAuthenticationInput | undefined,
    testId: string,
  ) => call<Host>('host_update_tested', { id, input, authentication, testId }),
  remove: (id: string) => call<void>('host_delete', { id }),
  copy: (id: string) => call<Host>('host_copy', { id }),
  groupSave: (
    id: string | null,
    input: { name: string; sortOrder: number; parentId: string | null },
  ) => call<HostGroup>('group_save', { id, input }),
  groupRemove: (id: string) => call<void>('group_delete', { id }),
  credentialSave: (id: string | null, expectedRevision: number | null, input: CredentialInput) =>
    call<Mutation<Credential>>('credential_save', { id, expectedRevision, input }),
  cleanup: () => call<Mutation<void>>('credential_cleanup'),
  status: () => call<SecureStatus>('credential_status'),
  preview: (text: string) => call<ImportPreview>('hosts_import_preview', { text }),
  import: (text: string, selected: string[], groupId: string | null) =>
    call<Mutation<Host[]>>('hosts_import', { text, selected, groupId }),
};
