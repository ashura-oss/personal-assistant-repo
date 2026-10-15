import { createHash } from 'node:crypto';
import { canonicalVerifiedProviderIdentity, projectBackgroundAuthorityAccounts, type BackgroundAuthorityAccount } from '../core';
import { scopeGrantsCapability } from '../connectors/oauth';
import type { BackgroundBindingResolver, ResolvedBackgroundBinding } from '../../server/src/backgroundPolicies.js';
import type { BackgroundPolicySpecification } from '../../server/src/backgroundContracts.js';
import type { DurableKernel, OwnedTransactionContext } from '../../server/src/kernel.js';

function fail(code: string): never { throw new Error(code); }
function sha256(text: string): string { return createHash('sha256').update(text, 'utf8').digest('hex'); }

/** Resolves account_sync consent against the exact canonical DB snapshot in the same owned transaction. */
export class ProductionBackgroundBindingResolver implements BackgroundBindingResolver {
  constructor(private readonly kernel: DurableKernel) {
    if (!kernel) throw new TypeError('background_binding_kernel_required');
  }

  resolve(context: OwnedTransactionContext, specification: BackgroundPolicySpecification): ResolvedBackgroundBinding {
    if (specification.kind !== 'account_sync') throw new Error('background_policy_kind_unavailable');
    const canonical = this.kernel.readOwnedSnapshotWithinTransaction(context).snapshot;
    let projectedAccounts: readonly BackgroundAuthorityAccount[];
    try { projectedAccounts = projectBackgroundAuthorityAccounts(canonical); }
    catch { return fail('background_snapshot_invalid'); }
    const accounts = new Map<string, BackgroundAuthorityAccount>();
    for (const value of projectedAccounts) {
      accounts.set(value.id, value);
    }
    const bound = specification.accounts.map((selection) => {
      const account = accounts.get(selection.accountId);
      if (!account || !account.connected || account.authStatus !== 'connected' || !account.tokenRef ||
          account.connectionGeneration !== selection.expectedConnectionGeneration ||
          (account.provider !== 'google' && account.provider !== 'microsoft') ||
          !Array.isArray(account.capabilities) || !Array.isArray(account.grantedScopes)) return fail('background_binding_changed');
      const identity = canonicalVerifiedProviderIdentity(account);
      const required = specification.resources.map((resource) => resource === 'mail' ? 'mail.read' : 'calendar.read');
      if (required.some((capability) => !account.capabilities!.includes(capability) ||
          !scopeGrantsCapability(account.provider as 'google' | 'microsoft', [...account.grantedScopes!], capability) ||
          (account.capabilityLimits !== undefined && !account.capabilityLimits.includes(capability)))) {
        return fail('background_binding_changed');
      }
      return Object.freeze({ accountId: account.id, provider: account.provider as 'google' | 'microsoft',
        identityKey: sha256(identity), connectionGeneration: account.connectionGeneration,
        label: account.displayName, connected: account.connected });
    });
    return Object.freeze({ accounts: Object.freeze(bound) });
  }
}
