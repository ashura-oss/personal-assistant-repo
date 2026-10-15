import type { Account, AccountCapability } from '../core';

export type OAuthInstallLifecycleState = Readonly<{
  accountId: string;
  connectionGeneration: number;
  tokenRef?: string;
  connected: boolean;
  authStatus: Account['authStatus'];
  identity?: NonNullable<Account['identity']>;
}>;

/** Safe facts prepared from a server-owned OAuth stage; this type never carries token material. */
export type PreparedOAuthInstallFacts = Readonly<{
  stageId: string;
  stagePayloadGeneration: number;
  provider: 'google' | 'microsoft';
  identity: NonNullable<Account['identity']>;
  requestedCapabilities: readonly AccountCapability[];
  capabilities: readonly AccountCapability[];
  grantedScopes: readonly string[];
  displayName: string;
  email?: string;
  expiresAt: number;
  expectedLifecycle?: OAuthInstallLifecycleState;
}>;

export interface OAuthInstallLifecycle {
  prepare(stageId: string): Promise<PreparedOAuthInstallFacts>;
}

/** Atomic account-install checkpoint consumed with the app-state save. */
export type OAuthInstallCheckpoint = Readonly<{
  stageId: string;
  stagePayloadGeneration: number;
  accountId: string;
  accountGeneration: number;
  tokenRef: string;
}>;
