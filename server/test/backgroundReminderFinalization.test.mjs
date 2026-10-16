import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundReminderFinalization } from '../dist/backgroundReminderFinalization.js';

test('held reminder finalization replays the committed deadline after a lost acknowledgement and clock advance', () => {
  const finalizer = new BackgroundReminderFinalization();
  const claim = Object.freeze({});
  let now = 1_800_000_000_000;
  let persisted;
  let writes = 0;
  const write = (finalization) => {
    writes += 1;
    if (persisted) assert.deepEqual(finalization, persisted, 'retry must reuse the exact persisted outcome');
    persisted = finalization;
    if (writes === 1) throw new Error('lost_commit_ack');
  };

  assert.throws(() => finalizer.persist(claim, 'stopped_before_dispatch', now, write), /lost_commit_ack/);
  const committed = persisted;
  assert.deepEqual(committed, { reason: 'stopped_before_dispatch', nextDueAt: now + 60_000 });

  now += 5 * 60_000;
  assert.equal(finalizer.persist(claim, 'stopped_before_dispatch', now, write), committed);
  assert.equal(writes, 2);
  assert.equal(persisted.nextDueAt, 1_800_000_060_000);
  assert.throws(() => finalizer.persist(claim, 'clock_rollback_before_dispatch', now, write), /finalization_conflict/);
});
