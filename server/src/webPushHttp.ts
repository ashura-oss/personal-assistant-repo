import type { DurableKernel } from './kernel.js';
import type { SecretVault } from './vault.js';
import type { WorkspaceHttpAdmission } from './workspaceHttp.js';
import { WebPushSubscriptions } from './webPushSubscriptions.js';

export interface WebPushSafeStatus {
  readonly schemaVersion: 1;
  readonly privacyEpoch: number;
  readonly provisioned: boolean;
  readonly activeKey?: Readonly<{ keyId: string; publicKey: string; createdAt: string }>;
  readonly subscriptionCount: number;
}

export interface WebPushSubscriptionPage {
  readonly schemaVersion: 1;
  readonly privacyEpoch: number;
  readonly subscriptions: readonly Readonly<{ deviceId: string; generation: number; status: 'active' | 'revoked';
    keyId: string; updatedAt: string }>[];
  readonly nextCursor?: string;
}

export type WebPushSubscriptionReconciliation = Readonly<{ schemaVersion: 1; privacyEpoch: number; deviceId: string; status: 'missing' }> |
  Readonly<{ schemaVersion: 1; privacyEpoch: number; deviceId: string; status: 'revoked'; generation: number; keyId: string }> |
  Readonly<{ schemaVersion: 1; privacyEpoch: number; deviceId: string; status: 'matched' | 'unmatched'; generation: number;
    keyId: string; publicKey: string }>;

export type WebPushCommandReceipt = Readonly<{
  schemaVersion: 1;
  commandId: string;
  operation: 'provision' | 'rotate';
  result: Readonly<{ keyId: string; publicKey: string; createdAt: string }>;
  createdAt: string;
}> | Readonly<{
  schemaVersion: 1;
  commandId: string;
  operation: 'register' | 'revoke';
  result: Readonly<{ deviceId: string; generation: number; status: 'active' | 'revoked'; keyId: string; updatedAt: string }>;
  createdAt: string;
}>;

export interface WebPushHttpApi {
  getStatus(admission: WorkspaceHttpAdmission): WebPushSafeStatus;
  getPublicKey(admission: WorkspaceHttpAdmission): Readonly<{ schemaVersion: 1; privacyEpoch: number; provisioned: boolean;
    keyId?: string; publicKey?: string; createdAt?: string }>;
  listSubscriptions(admission: WorkspaceHttpAdmission, cursor?: string): WebPushSubscriptionPage;
  reconcileSubscription(admission: WorkspaceHttpAdmission, input: unknown): WebPushSubscriptionReconciliation;
  provision(admission: WorkspaceHttpAdmission, input: unknown): WebPushCommandReceipt;
  rotate(admission: WorkspaceHttpAdmission, input: unknown): WebPushCommandReceipt;
  register(admission: WorkspaceHttpAdmission, input: unknown): WebPushCommandReceipt;
  revoke(admission: WorkspaceHttpAdmission, input: unknown): WebPushCommandReceipt;
  inspectCommand(admission: WorkspaceHttpAdmission, commandId: string): WebPushCommandReceipt | undefined;
}

/** Concrete production adapter; key generation and registry changes remain in the owned service transaction. */
export function createWebPushHttpApi(kernel: DurableKernel, vault: SecretVault,
  assertWorkspaceAdmission: (admission: WorkspaceHttpAdmission) => void): WebPushSubscriptions {
  return new WebPushSubscriptions(kernel, vault, assertWorkspaceAdmission);
}
