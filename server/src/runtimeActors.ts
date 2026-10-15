import { createHash } from 'node:crypto';
import type { DurableKernel, OwnedWorkspaceIdentity } from './kernel.js';

export const RUNTIME_ACTOR_EXPIRES_AT = 253_402_300_799_000;

export class RuntimeActorError extends Error {
  constructor(readonly code: 'invalid_identity' | 'workspace_binding_rejected' | 'stale_actor' | 'resolver_closed') {
    super(code);
    this.name = 'RuntimeActorError';
  }
}

interface ActorBinding {
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly privacyEpoch: number;
}

interface ActorEntry extends ActorBinding {
  readonly token: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bindingFrom(identity: OwnedWorkspaceIdentity): ActorBinding {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity) ||
    Object.getPrototypeOf(identity) !== Object.prototype && Object.getPrototypeOf(identity) !== null ||
    !UUID_V4.test(identity.workspaceId) || !UUID_V4.test(identity.ownerId) ||
    !Number.isSafeInteger(identity.privacyEpoch) || identity.privacyEpoch < 0) {
    throw new RuntimeActorError('invalid_identity');
  }
  return Object.freeze({ workspaceId: identity.workspaceId, ownerId: identity.ownerId, privacyEpoch: identity.privacyEpoch });
}

function bindingKey(binding: ActorBinding): string {
  return `${binding.workspaceId}\0${binding.ownerId}\0${binding.privacyEpoch}`;
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Owns long-lived, private kernel sessions used only by the trusted Node workspace runtime.
 * Callers must pass kernel-issued identity metadata, never request fields.
 */
export class ProcessWorkspaceActors {
  private readonly actors = new Map<string, ActorEntry>();
  private accepting = true;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly kernel: DurableKernel) {
    if (typeof kernel.assertRuntimeStartupSealed === 'function') kernel.assertRuntimeStartupSealed();
  }

  /** Resolver callback intended only for the trusted WorkspaceRegistry composition. */
  sessionForRegistry(identity: OwnedWorkspaceIdentity): string {
    if (!this.accepting) throw new RuntimeActorError('resolver_closed');
    const binding = bindingFrom(identity);
    const key = bindingKey(binding);
    const cached = this.actors.get(key);
    if (cached) {
      const current = this.kernel.getOwnedIdentity(cached.token);
      if (current.workspaceId !== cached.workspaceId || current.ownerId !== cached.ownerId || current.privacyEpoch !== cached.privacyEpoch) {
        throw new RuntimeActorError('stale_actor');
      }
      return cached.token;
    }

    const token = this.kernel.withTrustedDatabaseTransaction((db) => {
      const workspace = db.prepare('SELECT owner_id,privacy_epoch FROM workspaces WHERE id=?').get(binding.workspaceId) as
        { owner_id: string; privacy_epoch: number } | undefined;
      if (!workspace || workspace.owner_id !== binding.ownerId || workspace.privacy_epoch !== binding.privacyEpoch) {
        throw new RuntimeActorError('workspace_binding_rejected');
      }
      // The immediate transaction keeps the checked workspace epoch stable through session issuance.
      return this.kernel.createSession(binding.workspaceId, binding.ownerId, RUNTIME_ACTOR_EXPIRES_AT);
    });
    // Publish the token to the private cache only after the validating transaction commits.
    this.actors.set(key, Object.freeze({ ...binding, token }));
    return token;
  }

  /** Stops new lookups immediately, drains owned runtimes, then revokes every cached actor. */
  closeAfterDrain(drain: () => Promise<void>): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.accepting = false;
    const attempt = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      // A rejected provider/runtime drain does not prove that work has stopped.
      // Keep every actor usable by the in-flight work and require an explicit retry.
      await drain();
      for (const [key, actor] of this.actors) {
        try {
          this.kernel.revokeSession(actor.token);
          this.actors.delete(key);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'unauthenticated') {
            try {
              if (this.wasPrivacyRevoked(actor)) {
                this.actors.delete(key);
                continue;
              }
            } catch (verificationError) {
              failures.push(verificationError);
              continue;
            }
          }
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Runtime actor shutdown did not complete cleanly.');
    });
    this.closePromise = attempt;
    // Clear only this failed attempt so an explicit later call can retry with a fresh drain.
    void attempt.catch(() => {
      if (this.closePromise === attempt) this.closePromise = undefined;
    });
    return attempt;
  }

  private wasPrivacyRevoked(actor: ActorEntry): boolean {
    const row = this.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`
      SELECT s.owner_id,s.workspace_id,s.privacy_epoch,s.revoked_at,w.owner_id AS current_owner_id,
        w.privacy_epoch AS current_privacy_epoch
      FROM sessions s LEFT JOIN workspaces w ON w.id=s.workspace_id WHERE s.token_hash=?
    `).get(tokenDigest(actor.token)) as { owner_id: string; workspace_id: string; privacy_epoch: number; revoked_at: number | null;
      current_owner_id: string | null; current_privacy_epoch: number | null } | undefined);
    return Boolean(row && row.owner_id === actor.ownerId && row.workspace_id === actor.workspaceId &&
      row.privacy_epoch === actor.privacyEpoch && row.revoked_at !== null && row.current_owner_id === actor.ownerId &&
      row.current_privacy_epoch !== null && row.current_privacy_epoch > actor.privacyEpoch);
  }
}
