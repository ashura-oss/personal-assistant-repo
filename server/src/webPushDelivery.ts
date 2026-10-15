import type { OwnedTransactionContext } from './kernel.js';
import { randomUUID } from 'node:crypto';
import { type WebPushDeliveryMaterial, type WebPushSubscriptions } from './webPushSubscriptions.js';
import { createWebPushTransport, type WebPushNotificationKind, type WebPushTransportInput, type WebPushTransportResult } from './webPushTransport.js';

export interface WebPushAttemptClaim {
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly privacyEpoch: number;
  readonly deviceId: string;
  readonly generation: number;
  readonly keyId: string;
  readonly kind: WebPushNotificationKind;
}

export type WebPushAttemptRecord =
  | Readonly<{ state: 'ready' }>
  | Readonly<{ state: 'dispatch_admitted'; admissionId: string }>
  | Readonly<{ state: 'settled'; outcome: WebPushTransportResult }>;

export interface WebPushDeliveryAttemptOwner {
  withOwnedAttemptTransaction<T>(claim: WebPushAttemptClaim, callback: (context: OwnedTransactionContext) => T): T;
  assertAttemptCurrentWithinTransaction(context: OwnedTransactionContext, claim: WebPushAttemptClaim): void;
  readAttemptWithinTransaction(context: OwnedTransactionContext, claim: WebPushAttemptClaim): WebPushAttemptRecord;
  /** Must atomically recheck claim, consent, source, and exact attempt ownership before persisting dispatch admission. */
  admitDispatchWithinTransaction(context: OwnedTransactionContext, claim: WebPushAttemptClaim,
    binding: Readonly<{ deviceId: string; generation: number; keyId: string; admissionId: string }>): void;
  settleWithinTransaction(context: OwnedTransactionContext, claim: WebPushAttemptClaim, outcome: WebPushTransportResult,
    binding: Readonly<{ admissionId?: string }>): void;
}

export type WebPushDeliveryResult = WebPushTransportResult | Readonly<{ kind: 'already_settled'; outcome: WebPushTransportResult }>;

export interface WebPushDeliveryDispatcher {
  dispatchClaimedNotification(input: unknown): Promise<WebPushDeliveryResult>;
  stopAdmission(): void;
  drain(): Promise<void>;
}

interface CapturedClaim extends WebPushAttemptClaim {
  readonly signal?: AbortSignal;
}

function closedRecord(value: unknown, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) throw new Error('invalid');
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid');
      result[key] = descriptor.value;
    }
    if (required.some((key) => !Object.hasOwn(result, key))) throw new Error('invalid');
    return result;
  } catch { throw new Error('web_push_delivery_invalid_input'); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function captureClaim(value: unknown): CapturedClaim {
  const input = closedRecord(value, ['attemptId', 'workspaceId', 'ownerId', 'privacyEpoch', 'deviceId', 'generation', 'keyId', 'kind', 'signal'],
    ['attemptId', 'workspaceId', 'ownerId', 'privacyEpoch', 'deviceId', 'generation', 'keyId', 'kind']);
  for (const key of ['attemptId', 'workspaceId', 'ownerId', 'deviceId', 'keyId']) {
    if (typeof input[key] !== 'string' || !UUID.test(input[key])) throw new Error('web_push_delivery_invalid_input');
  }
  if (typeof input.privacyEpoch !== 'number' || !Number.isSafeInteger(input.privacyEpoch) || input.privacyEpoch < 0 ||
      typeof input.generation !== 'number' || !Number.isSafeInteger(input.generation) || input.generation < 1 ||
      (input.kind !== 'reminder' && input.kind !== 'mail_alert' && input.kind !== 'draft_ready') ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))) throw new Error('web_push_delivery_invalid_input');
  return Object.freeze({ attemptId: (input.attemptId as string).toLowerCase(), workspaceId: (input.workspaceId as string).toLowerCase(),
    ownerId: (input.ownerId as string).toLowerCase(), privacyEpoch: input.privacyEpoch, deviceId: (input.deviceId as string).toLowerCase(),
    generation: input.generation, keyId: (input.keyId as string).toLowerCase(), kind: input.kind,
    ...(input.signal ? { signal: input.signal as AbortSignal } : {}) });
}

function safeOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) throw new TypeError('web_push_delivery_origin_invalid');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new TypeError('web_push_delivery_origin_invalid'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError('web_push_delivery_origin_invalid');
  }
  return parsed.origin;
}

function assertClaimScope(context: OwnedTransactionContext, claim: WebPushAttemptClaim): void {
  if (context.workspaceId !== claim.workspaceId || context.ownerId !== claim.ownerId || context.privacyEpoch !== claim.privacyEpoch) {
    throw new Error('web_push_delivery_scope_changed');
  }
}

function requireSynchronous<T>(value: T, code: string): T {
  let then: unknown;
  try { then = value && (value as { then?: unknown }).then; } catch { throw new Error(code); }
  if (typeof then === 'function') {
    Promise.resolve(value).catch(() => {});
    throw new Error(code);
  }
  return value;
}

function ownedTransaction<T>(owner: WebPushDeliveryAttemptOwner, claim: WebPushAttemptClaim,
  callback: (context: OwnedTransactionContext) => T): T {
  return requireSynchronous(owner.withOwnedAttemptTransaction(claim, callback), 'web_push_delivery_async_transaction');
}

function copyAttemptRecord(value: unknown): WebPushAttemptRecord {
  const fields = closedRecord(value, ['state', 'admissionId', 'outcome'], ['state']);
  if (fields.state === 'ready') {
    if (Reflect.ownKeys(fields).length !== 1) throw new Error('web_push_delivery_attempt_corrupt');
    return Object.freeze({ state: 'ready' });
  }
  if (fields.state === 'dispatch_admitted') {
    if (Reflect.ownKeys(fields).length !== 2 || !Object.hasOwn(fields, 'admissionId') || Object.hasOwn(fields, 'outcome') ||
        typeof fields.admissionId !== 'string' || !UUID.test(fields.admissionId)) {
      throw new Error('web_push_delivery_attempt_corrupt');
    }
    return Object.freeze({ state: 'dispatch_admitted', admissionId: fields.admissionId.toLowerCase() });
  }
  if (fields.state === 'settled') {
    if (!Object.hasOwn(fields, 'outcome') || Reflect.ownKeys(fields).length !== 2) throw new Error('web_push_delivery_attempt_corrupt');
    const outcome = closedRecord(fields.outcome, ['kind', 'statusCode', 'reason'], ['kind']);
    if (outcome.kind === 'accepted' && Reflect.ownKeys(outcome).length === 1) return Object.freeze({ state: 'settled', outcome: Object.freeze({ kind: 'accepted' }) });
    if (outcome.kind === 'expired' && Reflect.ownKeys(outcome).length === 2 && (outcome.statusCode === 404 || outcome.statusCode === 410)) {
      return Object.freeze({ state: 'settled', outcome: Object.freeze({ kind: 'expired', statusCode: outcome.statusCode }) });
    }
    if (outcome.kind === 'rejected' && Reflect.ownKeys(outcome).length === 2 && typeof outcome.statusCode === 'number' && Number.isSafeInteger(outcome.statusCode) && outcome.statusCode >= 100 && outcome.statusCode <= 599) {
      return Object.freeze({ state: 'settled', outcome: Object.freeze({ kind: 'rejected', statusCode: outcome.statusCode }) });
    }
    if (outcome.kind === 'not_started' && Reflect.ownKeys(outcome).length === 2 && ['stopping', 'invalid_request', 'invalid_endpoint', 'unsafe_destination', 'dns_failure',
      'tls_failure', 'authorization_changed', 'cancelled', 'timeout', 'transport_failure'].includes(String(outcome.reason))) {
      return Object.freeze({ state: 'settled', outcome: Object.freeze({ kind: 'not_started', reason: outcome.reason as Extract<WebPushTransportResult, { kind: 'not_started' }>['reason'] }) });
    }
    if (outcome.kind === 'ambiguous' && Reflect.ownKeys(outcome).length === 2 && ['cancelled', 'timeout', 'transport_failure'].includes(String(outcome.reason))) {
      return Object.freeze({ state: 'settled', outcome: Object.freeze({ kind: 'ambiguous', reason: outcome.reason as Extract<WebPushTransportResult, { kind: 'ambiguous' }>['reason'] }) });
    }
  }
  throw new Error('web_push_delivery_attempt_corrupt');
}

function zeroMaterial(material: WebPushDeliveryMaterial): void {
  material.subscription.endpoint.fill(0);
  material.subscription.keys.p256dh.fill(0);
  material.subscription.keys.auth.fill(0);
  material.vapid.privateKey.fill(0);
}

export function createWebPushDeliveryDispatcher(options: Readonly<{
  canonicalOrigin: string;
  subscriptions: WebPushSubscriptions;
  owner: WebPushDeliveryAttemptOwner;
  transport?: ReturnType<typeof createWebPushTransport>;
}>): WebPushDeliveryDispatcher {
  const captured = closedRecord(options, ['canonicalOrigin', 'subscriptions', 'owner', 'transport'], ['canonicalOrigin', 'subscriptions', 'owner']);
  const canonicalOrigin = safeOrigin(captured.canonicalOrigin);
  const subscriptions = captured.subscriptions as WebPushSubscriptions;
  const owner = captured.owner as WebPushDeliveryAttemptOwner;
  const transport = (captured.transport ?? createWebPushTransport()) as ReturnType<typeof createWebPushTransport>;
  if (!subscriptions || typeof subscriptions.readDeliveryMaterialWithinTransaction !== 'function' ||
      typeof subscriptions.expireDeliveryGenerationWithinTransaction !== 'function' || !owner ||
      ['withOwnedAttemptTransaction', 'assertAttemptCurrentWithinTransaction', 'readAttemptWithinTransaction',
        'admitDispatchWithinTransaction', 'settleWithinTransaction'].some((key) => typeof (owner as unknown as Record<string, unknown>)[key] !== 'function') ||
      !transport || typeof transport.send !== 'function' || typeof transport.stopAdmission !== 'function' || typeof transport.drain !== 'function') {
    throw new TypeError('web_push_delivery_ports_invalid');
  }
  let accepting = true;
  const active = new Set<Promise<WebPushDeliveryResult>>();

  const run = async (claim: CapturedClaim): Promise<WebPushDeliveryResult> => {
    let material: WebPushDeliveryMaterial | undefined;
    let admissionCommitted = false;
    let fenceEntered = false;
    let admissionId: string | undefined;
    let result: WebPushTransportResult = Object.freeze({ kind: 'not_started', reason: 'authorization_changed' });
    try {
      {
        const initial = ownedTransaction(owner, claim, (context) => {
          assertClaimScope(context, claim);
          const attempt = copyAttemptRecord(requireSynchronous(owner.readAttemptWithinTransaction(context, claim), 'web_push_delivery_async_attempt_read'));
          if (attempt.state !== 'ready') return attempt;
          if (claim.signal?.aborted) return attempt;
          requireSynchronous(owner.assertAttemptCurrentWithinTransaction(context, claim), 'web_push_delivery_async_authority');
          const read = requireSynchronous(subscriptions.readDeliveryMaterialWithinTransaction(context,
            { deviceId: claim.deviceId, generation: claim.generation }), 'web_push_delivery_async_material_read');
          if (!read) return attempt;
          if (read.keyId !== claim.keyId) { zeroMaterial(read); return attempt; }
          material = read;
          return attempt;
        });
        if (initial.state === 'settled') return Object.freeze({ kind: 'already_settled', outcome: initial.outcome });
        if (initial.state === 'dispatch_admitted') return Object.freeze({ kind: 'ambiguous', reason: 'transport_failure' });
        if (claim.signal?.aborted) result = Object.freeze({ kind: 'not_started', reason: 'cancelled' });
        else if (!material) result = Object.freeze({ kind: 'not_started', reason: 'authorization_changed' });
        else {
          const endpoint = material.subscription.endpoint.toString('utf8');
          const p256dh = material.subscription.keys.p256dh.toString('base64url');
          const auth = material.subscription.keys.auth.toString('base64url');
          const privateKey = material.vapid.privateKey.toString('base64url');
          const binding = Object.freeze({ deviceId: claim.deviceId, generation: claim.generation, keyId: claim.keyId });
          admissionId = randomUUID();
          const sendInput: WebPushTransportInput = Object.freeze({ kind: claim.kind,
            subscription: Object.freeze({ endpoint, expirationTime: null, keys: Object.freeze({ p256dh, auth }) }),
            vapidDetails: Object.freeze({ subject: canonicalOrigin, publicKey: material.vapid.publicKey, privateKey }),
            ...(claim.signal ? { signal: claim.signal } : {}),
            assertBeforeDispatch: () => {
              fenceEntered = true;
              if (claim.signal?.aborted) throw new Error('web_push_delivery_cancelled');
              ownedTransaction(owner, claim, (context) => {
                assertClaimScope(context, claim);
                requireSynchronous(owner.assertAttemptCurrentWithinTransaction(context, claim), 'web_push_delivery_async_authority');
                const current = requireSynchronous(subscriptions.readDeliveryMaterialWithinTransaction(context,
                  { deviceId: claim.deviceId, generation: claim.generation }), 'web_push_delivery_async_material_read');
                if (!current) throw new Error('web_push_delivery_generation_changed');
                try {
                  if (current.keyId !== claim.keyId) throw new Error('web_push_delivery_key_changed');
                  requireSynchronous(owner.admitDispatchWithinTransaction(context, claim, Object.freeze({ ...binding, admissionId: admissionId! })),
                    'web_push_delivery_async_admission');
                  const admitted = copyAttemptRecord(requireSynchronous(owner.readAttemptWithinTransaction(context, claim),
                    'web_push_delivery_async_attempt_read'));
                  if (admitted.state !== 'dispatch_admitted' || admitted.admissionId !== admissionId) throw new Error('web_push_delivery_admission_missing');
                } finally { zeroMaterial(current); }
              });
              admissionCommitted = true;
              if (claim.signal?.aborted) throw new Error('web_push_delivery_cancelled');
            } });
          zeroMaterial(material);
          material = undefined;
          result = await transport.send(sendInput);
          if (fenceEntered && !admissionCommitted) {
            const observed = thisReadAttempt(owner, claim);
            if (observed.state === 'dispatch_admitted') {
              if (observed.admissionId !== admissionId) return Object.freeze({ kind: 'ambiguous', reason: 'transport_failure' });
              admissionCommitted = true;
            }
            else if (observed.state === 'settled') return Object.freeze({ kind: 'already_settled', outcome: observed.outcome });
          }
          if (admissionCommitted && result.kind === 'not_started') {
            result = Object.freeze({ kind: 'ambiguous', reason: result.reason === 'cancelled' ? 'cancelled' :
              result.reason === 'timeout' ? 'timeout' : 'transport_failure' });
          }
        }
      }
    } catch {
      if (fenceEntered && !admissionCommitted) {
        try {
          const observed = thisReadAttempt(owner, claim);
          if (observed.state === 'dispatch_admitted') {
            if (!admissionId || observed.admissionId !== admissionId) return Object.freeze({ kind: 'ambiguous', reason: 'transport_failure' });
            admissionCommitted = true;
          }
          if (observed.state === 'settled') return Object.freeze({ kind: 'already_settled', outcome: observed.outcome });
        } catch { admissionCommitted = true; }
      }
      result = admissionCommitted ? Object.freeze({ kind: 'ambiguous', reason: 'transport_failure' }) :
        Object.freeze({ kind: 'not_started', reason: claim.signal?.aborted ? 'cancelled' : 'authorization_changed' });
    } finally { if (material) zeroMaterial(material); }

    try {
      ownedTransaction(owner, claim, (context) => {
        assertClaimScope(context, claim);
        if (result.kind === 'expired') subscriptions.expireDeliveryGenerationWithinTransaction(context,
          { deviceId: claim.deviceId, generation: claim.generation, keyId: claim.keyId });
        requireSynchronous(owner.settleWithinTransaction(context, claim, result,
          Object.freeze(admissionCommitted && admissionId ? { admissionId } : {})), 'web_push_delivery_async_settlement');
        const settled = copyAttemptRecord(requireSynchronous(owner.readAttemptWithinTransaction(context, claim),
          'web_push_delivery_async_attempt_read'));
        if (settled.state !== 'settled' || JSON.stringify(settled.outcome) !== JSON.stringify(result)) throw new Error('web_push_delivery_settlement_missing');
      });
      return result;
    } catch {
      try {
        const retained = thisReadAttempt(owner, claim);
        if (retained.state === 'settled') return Object.freeze({ kind: 'already_settled', outcome: retained.outcome });
        if (retained.state === 'dispatch_admitted') return Object.freeze({ kind: 'ambiguous', reason: 'transport_failure' });
      } catch { /* A failed inspection cannot authorize retry or claim a settled result. */ }
      return admissionCommitted ? Object.freeze({ kind: 'ambiguous', reason: 'transport_failure' }) :
        Object.freeze({ kind: 'not_started', reason: 'authorization_changed' });
    }
  };

  const dispatchClaimedNotification = (input: unknown): Promise<WebPushDeliveryResult> => {
    let claim: CapturedClaim;
    try { claim = captureClaim(input); } catch { return Promise.resolve(Object.freeze({ kind: 'not_started', reason: 'invalid_request' })); }
    if (!accepting) return Promise.resolve(Object.freeze({ kind: 'not_started', reason: 'stopping' }));
    const task = run(claim).catch(() => Object.freeze({ kind: 'not_started', reason: 'authorization_changed' }) as WebPushDeliveryResult);
    active.add(task);
    return task.finally(() => { active.delete(task); });
  };
  const stopAdmission = (): void => { accepting = false; transport.stopAdmission(); };
  const drain = async (): Promise<void> => {
    stopAdmission();
    while (active.size > 0) await Promise.all([...active]);
    await transport.drain();
  };
  return Object.freeze({ dispatchClaimedNotification, stopAdmission, drain });
}

function thisReadAttempt(owner: WebPushDeliveryAttemptOwner, claim: WebPushAttemptClaim): WebPushAttemptRecord {
  return copyAttemptRecord(ownedTransaction(owner, claim, (context) => {
    assertClaimScope(context, claim);
    return requireSynchronous(owner.readAttemptWithinTransaction(context, claim), 'web_push_delivery_async_attempt_read');
  }));
}
