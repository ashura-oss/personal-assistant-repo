export interface OAuthConnectionIntentSnapshot {
  readonly workspaceGeneration: number;
  readonly controller: object;
  readonly resources: object;
  readonly privacy: object;
  readonly sessionEpoch: string;
  readonly sessionRuntimeId: string;
  readonly provider: 'google' | 'microsoft';
  readonly accountId?: string;
  readonly accountLifecycle: string;
  readonly platform: string;
  readonly clientId: string;
  readonly nativeRedirectUri: string;
  readonly webRedirectUri: string;
  readonly authority?: string;
  readonly redirectUri: string;
  readonly capabilities: readonly string[];
  readonly scopes: readonly string[];
}

export interface OAuthConnectionIntentOwner {
  readonly generation: number;
  readonly snapshot: OAuthConnectionIntentSnapshot;
}

export class OAuthConnectionIntentChangedError extends Error {
  constructor() {
    super('Sign-in was cancelled because the workspace or account connection changed. Start again from Settings.');
    this.name = 'OAuthConnectionIntentChangedError';
  }
}

/** Preserve typed privacy failures instead of replacing them with cleanup UI text. */
export function oauthInstallFailureWithCleanupContext(
  error: unknown,
  pendingCleanupCount: number,
  isPrivacyBootstrapError: (candidate: unknown) => boolean,
): unknown {
  if (isPrivacyBootstrapError(error) || pendingCleanupCount <= 0) return error;
  return new Error(`The account was not connected. Credential cleanup is pending for ${pendingCleanupCount} item${pendingCleanupCount === 1 ? '' : 's'}; retry below.`);
}

function freezeSnapshot(snapshot: OAuthConnectionIntentSnapshot): OAuthConnectionIntentSnapshot {
  return Object.freeze({
    ...snapshot,
    capabilities: Object.freeze([...snapshot.capabilities]),
    scopes: Object.freeze([...snapshot.scopes]),
  });
}

function sameSnapshot(a: OAuthConnectionIntentSnapshot, b: OAuthConnectionIntentSnapshot): boolean {
  return a.workspaceGeneration === b.workspaceGeneration && a.controller === b.controller &&
    a.resources === b.resources && a.privacy === b.privacy && a.sessionEpoch === b.sessionEpoch &&
    a.sessionRuntimeId === b.sessionRuntimeId && a.provider === b.provider && a.accountId === b.accountId &&
    a.accountLifecycle === b.accountLifecycle && a.platform === b.platform && a.clientId === b.clientId &&
    a.nativeRedirectUri === b.nativeRedirectUri && a.webRedirectUri === b.webRedirectUri &&
    a.authority === b.authority && a.redirectUri === b.redirectUri &&
    a.capabilities.length === b.capabilities.length && a.capabilities.every((value, index) => value === b.capabilities[index]) &&
    a.scopes.length === b.scopes.length && a.scopes.every((value, index) => value === b.scopes[index]);
}

/** A synchronous one-owner fence for OAuth work spanning the system-browser handoff. */
export class OAuthConnectionIntentOwnership {
  private nextGeneration = 0;
  private active?: OAuthConnectionIntentOwner;

  begin(snapshot: OAuthConnectionIntentSnapshot): OAuthConnectionIntentOwner {
    const owner = Object.freeze({ generation: ++this.nextGeneration, snapshot: freezeSnapshot(snapshot) });
    this.active = owner;
    return owner;
  }

  isCurrent(owner: OAuthConnectionIntentOwner): boolean {
    return this.active === owner;
  }

  assertOwnerCurrent(owner: OAuthConnectionIntentOwner): void {
    if (this.active !== owner) throw new OAuthConnectionIntentChangedError();
  }

  assertCurrent(owner: OAuthConnectionIntentOwner, current: OAuthConnectionIntentSnapshot): void {
    if (this.active !== owner || !sameSnapshot(owner.snapshot, current)) throw new OAuthConnectionIntentChangedError();
  }

  invalidate(owner?: OAuthConnectionIntentOwner): void {
    if (owner && this.active !== owner) return;
    this.active = undefined;
    this.nextGeneration += 1;
  }
}

/** Runs the real App OAuth sequence with a fence after browser return and at install completion. */
export async function runOwnedOAuthConnection<THandoff, TResult>(input: {
  assertCurrent: () => void;
  assertWorkspaceCurrent?: () => void;
  authorize: () => Promise<THandoff>;
  validateHandoff: (handoff: THandoff) => void;
  exchange: (handoff: THandoff, beforeStart: () => void) => Promise<TResult>;
  install: (result: TResult, assertCurrent: () => void) => Promise<void>;
}): Promise<{ result: TResult; canPublish: boolean }> {
  input.assertCurrent();
  const handoff = await input.authorize();
  input.assertCurrent();
  input.validateHandoff(handoff);
  input.assertCurrent();
  const result = await input.exchange(handoff, input.assertCurrent);
  input.assertCurrent();
  await input.install(result, input.assertCurrent);
  let canPublish = false;
  if (input.assertWorkspaceCurrent) {
    try {
      input.assertWorkspaceCurrent();
      canPublish = true;
    } catch {
      // Installation already committed; stale UI ownership only suppresses publication.
    }
  }
  return { result, canPublish };
}
