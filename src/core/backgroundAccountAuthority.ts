import type { Account, AccountAuthStatus, AccountCapability } from './index';
import { isValidAccountId } from './accountIds';

const providers = new Set(['google', 'microsoft', 'local']);
const authStatuses = new Set<AccountAuthStatus>(['configured', 'connected', 'reauth_required', 'revoked']);
const capabilities = new Set<AccountCapability>(['mail.read', 'mail.draft', 'mail.send', 'calendar.read', 'calendar.write']);
const identityKeys = new Set(['providerNamespace', 'clientId', 'subject', 'issuer', 'tenantId', 'resourceUserId']);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return false;
      bytes += 4;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    else bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    if (bytes > maxBytes) return false;
  }
  return true;
}

function optionalStrings(value: unknown, allowed?: ReadonlySet<string>, maxBytes = 4096): value is string[] | undefined {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((item) => cleanString(item, maxBytes) &&
    (!allowed || allowed.has(item))) && new Set(value).size === value.length;
}

export type BackgroundAuthorityAccount = Omit<Pick<Account, 'id' | 'provider' | 'displayName' | 'connected' | 'authStatus' | 'identity' | 'tokenRef' |
  'grantedScopes' | 'capabilities' | 'capabilityLimits' | 'connectionGeneration'>, 'grantedScopes' | 'capabilities' | 'capabilityLimits'> & {
    readonly grantedScopes?: readonly string[]; readonly capabilities?: readonly AccountCapability[];
    readonly capabilityLimits?: readonly AccountCapability[];
  };

function validIdentity(value: unknown, provider: unknown, connected: boolean): Account['identity'] | undefined | false {
  if (value === undefined) return connected ? false : undefined;
  if (!record(value) || Object.keys(value).some((key) => !identityKeys.has(key))) return false;
  for (const key of Object.keys(value)) if (!cleanString(value[key], key === 'subject' || key === 'resourceUserId' ? 4096 : 2048)) return false;
  if (value.providerNamespace !== undefined && value.providerNamespace !== 'google' && value.providerNamespace !== 'microsoft') return false;
  if (typeof value.subject !== 'string' || !value.subject) return false;
  if (connected && ((provider !== 'google' && provider !== 'microsoft') || value.providerNamespace !== provider ||
      !cleanString(value.clientId, 2048) || !cleanString(value.subject, 4096) ||
      (provider === 'microsoft' && !cleanString(value.resourceUserId, 4096)))) return false;
  return Object.freeze({ ...(value.providerNamespace === undefined ? {} : { providerNamespace: value.providerNamespace as 'google' | 'microsoft' }),
    ...(value.clientId === undefined ? {} : { clientId: value.clientId as string }), subject: value.subject,
    ...(value.issuer === undefined ? {} : { issuer: value.issuer as string }),
    ...(value.tenantId === undefined ? {} : { tenantId: value.tenantId as string }),
    ...(value.resourceUserId === undefined ? {} : { resourceUserId: value.resourceUserId as string }) });
}

/** Strictly projects only fields that can authorize account_sync. It does not normalize or mutate snapshot data. */
export function projectBackgroundAuthorityAccounts(value: unknown): readonly BackgroundAuthorityAccount[] {
  if (!record(value) || !Array.isArray(value.accounts)) throw new TypeError('background_snapshot_invalid');
  const seen = new Set<string>();
  const result: BackgroundAuthorityAccount[] = [];
  for (const raw of value.accounts) {
    const identity = record(raw) ? validIdentity(raw.identity, raw.provider, raw.connected === true) : false;
    if (!record(raw) || !isValidAccountId(raw.id) || seen.has(raw.id) || typeof raw.provider !== 'string' || !providers.has(raw.provider) ||
        typeof raw.connected !== 'boolean' || !authStatuses.has(raw.authStatus as AccountAuthStatus) ||
        typeof raw.displayName !== 'string' || typeof raw.email !== 'string' ||
        (raw.verifiedEmail !== undefined && typeof raw.verifiedEmail !== 'string') ||
        (raw.tokenRef !== undefined && !cleanString(raw.tokenRef, 2048)) ||
        (raw.connectionGeneration !== undefined && (!Number.isSafeInteger(raw.connectionGeneration) || (raw.connectionGeneration as number) < 0)) ||
        !optionalStrings(raw.grantedScopes) || !optionalStrings(raw.capabilities, capabilities) ||
        !optionalStrings(raw.capabilityLimits, capabilities) || identity === false) {
      throw new TypeError('background_snapshot_invalid');
    }
    seen.add(raw.id);
    result.push(Object.freeze({ id: raw.id, provider: raw.provider as Account['provider'], displayName: raw.displayName,
      connected: raw.connected, authStatus: raw.authStatus as AccountAuthStatus, ...(identity === undefined ? {} : { identity }),
      ...(raw.tokenRef === undefined ? {} : { tokenRef: raw.tokenRef }),
      ...(raw.grantedScopes === undefined ? {} : { grantedScopes: Object.freeze([...(raw.grantedScopes as string[])]) }),
      ...(raw.capabilities === undefined ? {} : { capabilities: Object.freeze([...(raw.capabilities as AccountCapability[])]) }),
      ...(raw.capabilityLimits === undefined ? {} : { capabilityLimits: Object.freeze([...(raw.capabilityLimits as AccountCapability[])]) }),
      ...(raw.connectionGeneration === undefined ? {} : { connectionGeneration: raw.connectionGeneration as number }) }));
  }
  return Object.freeze(result);
}
