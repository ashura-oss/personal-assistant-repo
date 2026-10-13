import type { MailAlertObserved } from './types';

export interface MailAlertTapKey {
  readonly installationId: string;
  readonly receiptId: string;
}

export type MailAlertTapResolution =
  | { kind: 'ignored' }
  | { kind: 'blocked' }
  | { kind: 'status'; receiptId: string; ruleId?: string; observed?: MailAlertObserved; reason: 'revoked' | 'changed' | 'source_unavailable' | 'refresh_required' }
  | { kind: 'mail'; receiptId: string; ruleId: string; messageId: string; sourceVersion: string; subject: string; senderLabel?: string; snippet?: string; accountLabel: string; receivedAt: string; checkedAt: string };

export interface MailAlertTapSubscription { remove(): void }

export interface MailAlertTapBackend {
  subscribe(installationId: string, listener: (key: MailAlertTapKey) => void): Promise<MailAlertTapSubscription>;
  getLastResponse(installationId: string): Promise<MailAlertTapKey | undefined>;
}

export interface MailAlertTapCoordinator {
  start(input: {
    installationId: string;
    isReady: boolean;
    resolve: (key: MailAlertTapKey) => Promise<MailAlertTapResolution>;
    onResolution: (key: MailAlertTapKey, resolution: MailAlertTapResolution) => void;
    onPendingChange?: (pending: boolean) => void;
  }): Promise<void>;
  setReady(isReady: boolean): void;
  retryPending(): void;
  hasPending(): boolean;
  dispose(): void;
}

function keyId(key: MailAlertTapKey): string { return `${key.installationId}:${key.receiptId}`; }

/** One latest in-memory tap; it never persists a route or response payload. */
export function createMailAlertTapCoordinator(backend: MailAlertTapBackend): MailAlertTapCoordinator {
  let active = true;
  let started = false;
  let initializationComplete = false;
  let ready = false;
  let installationId = '';
  let resolveTap: ((key: MailAlertTapKey) => Promise<MailAlertTapResolution>) | undefined;
  let onResolution: ((key: MailAlertTapKey, resolution: MailAlertTapResolution) => void) | undefined;
  let onPendingChange: ((pending: boolean) => void) | undefined;
  let subscription: MailAlertTapSubscription | undefined;
  let pending: MailAlertTapKey | undefined;
  const handled = new Set<string>();
  let generation = 0;
  let requestToken = 0;
  let arrivalVersion = 0;
  let resolutionRunning = false;
  let liveEventDuringLastRead = false;
  const notifyPending = (value: boolean) => { try { onPendingChange?.(value); } catch { /* UI observers do not own routing state. */ } };

  const runPending = () => {
    if (!active || !initializationComplete || !ready || !pending || !resolveTap || resolutionRunning) return;
    const current = pending;
    const currentGeneration = generation;
    const currentRequest = requestToken;
    resolutionRunning = true;
    void Promise.resolve().then(() => resolveTap!(current)).then((resolution) => {
      if (!active || !ready || currentGeneration !== generation || !pending || keyId(pending) !== keyId(current)) return;
      if (resolution.kind !== 'blocked') {
        if (resolution.kind !== 'ignored') {
          try { onResolution?.(current, resolution); }
          catch { return; }
        } else {
          try { onResolution?.(current, resolution); } catch { /* Unknown candidates are safe to consume. */ }
        }
        handled.add(keyId(current));
        if (handled.size > 64) handled.delete(handled.values().next().value as string);
        pending = undefined;
        notifyPending(false);
      }
    }, () => {
      if (active && currentGeneration === generation && pending && keyId(pending) === keyId(current)) {
        // A failed local read is retryable, but this does not schedule another attempt.
      }
    }).finally(() => {
      resolutionRunning = false;
      if (active && ready && pending && requestToken !== currentRequest) runPending();
    });
  };

  const accept = (key: MailAlertTapKey, isLive = false) => {
    if (!active || key.installationId !== installationId) return;
    if (isLive) { liveEventDuringLastRead = true; arrivalVersion += 1; }
    const id = keyId(key);
    if (handled.has(id) || pending && keyId(pending) === id) return;
    pending = Object.freeze({ installationId: key.installationId, receiptId: key.receiptId });
    notifyPending(true);
    generation += 1;
    requestToken += 1;
    runPending();
  };

  return Object.freeze({
    async start(input: Parameters<MailAlertTapCoordinator['start']>[0]) {
      if (!active || started) return;
      started = true;
      installationId = input.installationId;
      ready = input.isReady;
      resolveTap = input.resolve;
      onResolution = input.onResolution;
      onPendingChange = input.onPendingChange;
      liveEventDuringLastRead = false;
      const startArrivalVersion = arrivalVersion;
      try {
        const created = await backend.subscribe(installationId, (key) => accept(key, true));
        if (!active) { created.remove(); return; }
        subscription = created;
      } catch { /* Cached-response lookup below remains a one-shot fallback. */ }
      if (!active) return;
      try {
        const cached = await backend.getLastResponse(installationId);
        if (active && !liveEventDuringLastRead && arrivalVersion === startArrivalVersion && cached) accept(cached);
      } catch { /* Future taps still arrive through the installed listener. */ }
      if (active) {
        initializationComplete = true;
        runPending();
      }
    },
    setReady(value: boolean) {
      if (!active) return;
      const changed = ready !== value;
      ready = value;
      if (changed) generation += 1;
      if (changed && ready) { requestToken += 1; runPending(); }
    },
    retryPending() { if (pending) { generation += 1; requestToken += 1; runPending(); } },
    hasPending() { return Boolean(active && pending); },
    dispose() {
      if (!active) return;
      active = false;
      generation += 1;
      pending = undefined;
      resolveTap = undefined;
      onResolution = undefined;
      onPendingChange = undefined;
      const current = subscription;
      subscription = undefined;
      current?.remove();
    },
  });
}
