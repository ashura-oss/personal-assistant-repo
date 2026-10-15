import { describe, expect, it } from 'vitest';
import { projectBackgroundAuthorityAccounts } from '../src/core/backgroundAccountAuthority';
import { ProductionBackgroundBindingResolver } from '../src/cloud/backgroundBindingResolver.node';

const connected = () => ({ id: 'google:one', provider: 'google', displayName: 'Gmail', email: 'a@example.test', connected: true,
  authStatus: 'connected', tokenRef: 'credential-ref-1', connectionGeneration: 2,
  identity: { providerNamespace: 'google', clientId: 'client', subject: 'subject', issuer: 'https://accounts.example' },
  grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'], capabilities: ['mail.read'], capabilityLimits: ['mail.read'] });

describe('background account authority projection', () => {
  it('preserves legacy disconnected rows and accepts a fully typed connected identity without normalization', () => {
    const disconnected = { id: 'legacy', provider: 'local', displayName: '', email: '', connected: false,
      authStatus: 'configured', connectionGeneration: 0 };
    const accounts = projectBackgroundAuthorityAccounts({ accounts: [disconnected, connected()] });
    expect(accounts).toHaveLength(2);
    expect(accounts[0]?.connectionGeneration).toBe(0);
    expect(accounts[1]?.identity?.issuer).toBe('https://accounts.example');
    expect(accounts[1]?.tokenRef).toBe('credential-ref-1');
  });

  it('rejects duplicate IDs, non-string provider values, malformed identities, and invalid authority collections', () => {
    const valid = connected();
    expect(() => projectBackgroundAuthorityAccounts({ accounts: [valid, { ...valid }] })).toThrow('background_snapshot_invalid');
    expect(() => projectBackgroundAuthorityAccounts({ accounts: [{ ...valid, provider: { toString: () => 'google' } }] }))
      .toThrow('background_snapshot_invalid');
    expect(() => projectBackgroundAuthorityAccounts({ accounts: [{ ...valid, identity: { ...valid.identity, issuer: '\ud800' } }] }))
      .toThrow('background_snapshot_invalid');
    expect(() => projectBackgroundAuthorityAccounts({ accounts: [{ ...valid, capabilityLimits: ['mail.send'] }] }))
      .not.toThrow();
    expect(() => projectBackgroundAuthorityAccounts({ accounts: [{ ...valid, grantedScopes: [4] }] })).toThrow('background_snapshot_invalid');
    expect(() => projectBackgroundAuthorityAccounts({ accounts: 'not an array' })).toThrow('background_snapshot_invalid');
  });

  it('requires the selected live token, matching identity and both the grant and user capability limit', () => {
    let snapshot: unknown = { accounts: [connected()] };
    const resolver = new ProductionBackgroundBindingResolver({
      readOwnedSnapshotWithinTransaction: () => ({ snapshot }),
    } as never);
    const context = {} as never;
    const specification = { kind: 'account_sync' as const, accounts: [{ accountId: 'google:one', expectedConnectionGeneration: 2 }],
      resources: ['mail'] as const, intervalMinutes: 5 };
    expect(resolver.resolve(context, specification).accounts?.[0]?.connected).toBe(true);
    snapshot = { accounts: [{ ...connected(), tokenRef: undefined }] };
    expect(() => resolver.resolve(context, specification)).toThrow('background_binding_changed');
    snapshot = { accounts: [{ ...connected(), capabilityLimits: [] }] };
    expect(() => resolver.resolve(context, specification)).toThrow('background_binding_changed');
    snapshot = { accounts: [{ ...connected(), identity: { ...connected().identity, providerNamespace: 'microsoft' } }] };
    expect(() => resolver.resolve(context, specification)).toThrow('background_snapshot_invalid');
  });

  it('hashes the full verified provider identity while excluding local row IDs and display labels', () => {
    let snapshot: unknown = { accounts: [connected()] };
    const resolver = new ProductionBackgroundBindingResolver({ readOwnedSnapshotWithinTransaction: () => ({ snapshot }) } as never);
    const context = {} as never;
    const bindingFor = (accountId = 'google:one') => resolver.resolve(context, { kind: 'account_sync',
      accounts: [{ accountId, expectedConnectionGeneration: 2 }], resources: ['mail'], intervalMinutes: 5 }).accounts?.[0]?.identityKey;
    const baseline = bindingFor();
    snapshot = { accounts: [{ ...connected(), id: 'google:renamed-row', displayName: 'A different label' }] };
    expect(bindingFor('google:renamed-row')).toBe(baseline);
    for (const change of [
      { clientId: 'another-client' }, { subject: 'another-subject' }, { issuer: 'https://issuer-two.example' },
      { tenantId: 'tenant-two' }, { resourceUserId: 'resource-two' },
    ]) {
      snapshot = { accounts: [{ ...connected(), identity: { ...connected().identity, ...change } }] };
      expect(bindingFor()).not.toBe(baseline);
    }
  });
});
