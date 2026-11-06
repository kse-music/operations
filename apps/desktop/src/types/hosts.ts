export * from '@serverdeck/plugin-sdk/types/hosts';

export type HostAuthenticationInput =
  | { kind: 'password'; password: string }
  | { kind: 'private_key'; keyData: string; passphrase: string | null };

export interface HostKeyFingerprint {
  hostname: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}

export type HostTestResult =
  | { status: 'trust_required'; key: HostKeyFingerprint }
  | { status: 'connected'; testId: string; expiresInSeconds: number };
