export type ReminderHeldFinalizationReason = 'stopped_before_dispatch' | 'stale_scan_before_dispatch' | 'clock_rollback_before_dispatch';

export interface ReminderHeldFinalization {
  readonly reason: ReminderHeldFinalizationReason;
  readonly nextDueAt: number;
}

/** Reuses one persisted retry timestamp when the store commits but its acknowledgement is lost. */
export class BackgroundReminderFinalization {
  readonly #pending = new WeakMap<object, ReminderHeldFinalization>();

  persist(claim: object, reason: ReminderHeldFinalizationReason, now: number,
    write: (finalization: ReminderHeldFinalization) => void): ReminderHeldFinalization {
    if (!claim || typeof claim !== 'object' || !Number.isSafeInteger(now) || now < 0 || typeof write !== 'function') {
      throw new TypeError('background_reminder_finalization_invalid');
    }
    let finalization = this.#pending.get(claim);
    if (!finalization) {
      finalization = Object.freeze({ reason, nextDueAt: now + 60_000 });
      if (!Number.isSafeInteger(finalization.nextDueAt)) throw new TypeError('background_reminder_finalization_invalid');
      this.#pending.set(claim, finalization);
    } else if (finalization.reason !== reason) {
      throw new Error('background_reminder_finalization_conflict');
    }
    const result = write(finalization) as unknown;
    let then: unknown;
    try { then = result && (typeof result === 'object' || typeof result === 'function') ? (result as { then?: unknown }).then : undefined; }
    catch { throw new TypeError('background_reminder_finalization_async_write'); }
    if (typeof then === 'function') {
      Promise.resolve(result).catch(() => undefined);
      throw new TypeError('background_reminder_finalization_async_write');
    }
    return finalization;
  }
}
