import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundScheduler, BACKGROUND_SCHEDULER_MAX_TIMER_MS, BACKGROUND_SCHEDULER_RECONCILE_MS } from '../dist/backgroundScheduler.js';

const LANES = ['account_sync', 'period_summary', 'proactive_draft', 'approved_reminder_delivery', 'batch_observation'];

class FakeClock {
  nowValue;
  nextId = 0;
  timers = new Map();
  constructor(now = 1_800_000_000_000) { this.nowValue = now; }
  now = () => this.nowValue;
  random = () => 0.5;
  setTimeout = (callback, delayMs) => {
    const id = ++this.nextId;
    this.timers.set(id, { id, at: this.nowValue + delayMs, callback });
    return id;
  };
  clearTimeout = (id) => { this.timers.delete(id); };
  get nextTimerAt() { return [...this.timers.values()].sort((a, b) => a.at - b.at)[0]?.at; }
  async advanceTo(target) {
    let iterations = 0;
    while (true) {
      const next = [...this.timers.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next || next.at > target) break;
      if (++iterations > 1000) throw new Error('fake_clock_loop');
      this.nowValue = next.at;
      this.timers.delete(next.id);
      next.callback();
      await flush();
    }
    this.nowValue = target;
    await flush();
  }
}
async function flush() { for (let index = 0; index < 24; index += 1) await Promise.resolve(); }
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function createPorts(clock, initial = []) {
  const work = initial.map((item) => ({ ...item, state: 'pending' }));
  const log = [];
  let executeCount = 0;
  let claimCount = 0;
  let activeExecutions = 0;
  let maxActiveExecutions = 0;
  let executeOverride;
  let claimOverride;
  let readOverride;
  let recordFailures = 0;
  let recordCalls = 0;
  let reconcileCalls = 0;
  const find = (workspaceId, workId) => work.find((item) => item.workspaceId === workspaceId && item.workId === workId);
  const ports = {
    async readNextDueAt({ now }) {
      if (readOverride) return readOverride({ now });
      const due = work.filter((item) => item.state === 'pending').map((item) => item.dueAt);
      return due.length ? Math.min(...due) : null;
    },
    async listDueWorkspaces({ now, afterWorkspaceId, limit }) {
      return [...new Set(work.filter((item) => item.state === 'pending' && item.dueAt <= now).map((item) => item.workspaceId))]
        .sort().filter((id) => afterWorkspaceId === undefined || id > afterWorkspaceId).slice(0, limit);
    },
    async listDueLanes({ workspaceId, now }) {
      return [...new Set(work.filter((item) => item.workspaceId === workspaceId && item.state === 'pending' && item.dueAt <= now).map((item) => item.lane))]
        .sort((a, b) => LANES.indexOf(a) - LANES.indexOf(b));
    },
    async listDueOccurrences({ workspaceId, lane, now, afterWorkId, limit }) {
      return work.filter((item) => item.workspaceId === workspaceId && item.lane === lane && item.state === 'pending' && item.dueAt <= now &&
        (afterWorkId === undefined || item.workId > afterWorkId)).sort((a, b) => a.workId.localeCompare(b.workId)).slice(0, limit)
        .map(({ workspaceId: id, workId, lane: kind, dueAt }) => ({ workspaceId: id, workId, lane: kind, dueAt }));
    },
    async claimOccurrence({ work: descriptor }) {
      claimCount += 1;
      if (claimOverride) return claimOverride(descriptor);
      const item = find(descriptor.workspaceId, descriptor.workId);
      if (!item || item.state !== 'pending' || item.dueAt > clock.now()) return undefined;
      item.state = 'claimed';
      return Object.freeze({ claimId: `${item.workspaceId}/${item.workId}` });
    },
    async executeClaim(claim) {
      executeCount += 1;
      activeExecutions += 1;
      maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
      try {
        if (executeOverride) return await executeOverride(claim);
        return { kind: 'terminal', code: 'settled' };
      } finally { activeExecutions -= 1; }
    },
    async recordOutcome(claim, outcome) {
      recordCalls += 1;
      if (recordFailures > 0) { recordFailures -= 1; throw new Error('synthetic_persistence_failure'); }
      const [, workId] = claim.claimId.split('/');
      const item = work.find((candidate) => candidate.workId === workId);
      assert.ok(item);
      if (outcome.kind === 'deferred') { item.state = 'pending'; item.dueAt = outcome.nextDueAt; }
      else item.state = outcome.kind === 'held' ? 'held' : outcome.kind;
      log.push({ workspaceId: item.workspaceId, workId, lane: item.lane, outcome });
    },
    async reconcileAmbiguousClaim(claim, reason) {
      reconcileCalls += 1;
      const [, workId] = claim.claimId.split('/');
      const item = work.find((candidate) => candidate.workId === workId);
      assert.ok(item);
      item.state = 'held';
      log.push({ workId, reason });
    },
    async reconcileUnacknowledgedClaim(descriptor, reason) {
      reconcileCalls += 1;
      const item = find(descriptor.workspaceId, descriptor.workId);
      if (item) item.state = 'held';
      log.push({ workId: descriptor.workId, reason });
    },
  };
  return {
    ports, work, log,
    get executeCount() { return executeCount; },
    get claimCount() { return claimCount; },
    get maxActiveExecutions() { return maxActiveExecutions; },
    get recordCalls() { return recordCalls; },
    get reconcileCalls() { return reconcileCalls; },
    failNextRecords(count) { recordFailures = count; },
    setExecute(fn) { executeOverride = fn; },
    setClaim(fn) { claimOverride = fn; },
    setRead(fn) { readOverride = fn; },
  };
}
function descriptor(workspaceId, workId, lane = 'account_sync', dueAt = 1_800_000_000_000) {
  return { workspaceId, workId, lane, dueAt };
}
function scheduler(clock, ports, options = {}) {
  return new BackgroundScheduler({ ports, clock, minimumPacingMs: 1_000, reconciliationIntervalMs: BACKGROUND_SCHEDULER_RECONCILE_MS,
    pageSize: 10, ...options });
}

test('one timer tracks earliest due and periodic metadata reconciliation while idle', async () => {
  const clock = new FakeClock();
  const dueAt = clock.now() + 4_000;
  const h = createPorts(clock, [descriptor('workspace-a', 'work-a', 'account_sync', dueAt)]);
  const engine = scheduler(clock, h.ports);
  engine.start();
  assert.equal(clock.timers.size, 1);
  await clock.advanceTo(clock.now());
  assert.equal(clock.nextTimerAt, dueAt);
  await clock.advanceTo(dueAt - 1);
  assert.equal(h.executeCount, 0);
  await clock.advanceTo(dueAt);
  assert.equal(h.executeCount, 1);
  assert.equal(clock.timers.size, 1);
  assert.equal(clock.nextTimerAt, dueAt + BACKGROUND_SCHEDULER_RECONCILE_MS);
  await clock.advanceTo(clock.nextTimerAt);
  assert.equal(h.executeCount, 1, 'an idle reconciliation scan does not run provider or model work');
  await engine.drainAndDispose();
  assert.equal(engine.lifecycle, 'drained');
});

test('serial work rotates fairly across workspaces and closed lanes', async () => {
  const clock = new FakeClock();
  const h = createPorts(clock, [
    descriptor('workspace-a', 'a-sync', 'account_sync'), descriptor('workspace-a', 'a-summary', 'period_summary'),
    descriptor('workspace-b', 'b-sync', 'account_sync'), descriptor('workspace-b', 'b-summary', 'period_summary'),
  ]);
  const engine = scheduler(clock, h.ports);
  engine.start();
  await clock.advanceTo(clock.now());
  for (let index = 0; index < 3; index += 1) await clock.advanceTo(clock.now() + 1_000);
  assert.deepEqual(h.log.map(({ workspaceId, lane }) => `${workspaceId}:${lane}`), [
    'workspace-a:account_sync', 'workspace-b:account_sync', 'workspace-a:period_summary', 'workspace-b:period_summary',
  ]);
  assert.equal(h.maxActiveExecutions, 1);
  await engine.drainAndDispose();
});

test('wakes coalesce during a slow dispatch and never overlap execution', async () => {
  const clock = new FakeClock();
  const h = createPorts(clock, [descriptor('workspace-a', 'work-a')]);
  const gate = deferred();
  h.setExecute(() => gate.promise);
  const engine = scheduler(clock, h.ports);
  engine.start();
  await clock.advanceTo(clock.now());
  assert.equal(h.executeCount, 1);
  engine.wake(); engine.wake(); engine.wake();
  assert.equal(clock.timers.size, 0);
  gate.resolve({ kind: 'terminal', code: 'settled' });
  await flush();
  assert.equal(h.maxActiveExecutions, 1);
  assert.equal(clock.timers.size, 1);
  await clock.advanceTo(clock.now());
  assert.equal(h.executeCount, 1, 'settled work is not resubmitted after a coalesced wake');
  await engine.drainAndDispose();
});

test('metadata reads honor Retry-After and exponential backoff even when wakes arrive', async () => {
  const clock = new FakeClock();
  const h = createPorts(clock);
  let reads = 0;
  h.setRead(({ now }) => {
    reads += 1;
    if (reads === 1) throw Object.assign(new Error('read unavailable'), { retryAfterMs: 5_000 });
    return null;
  });
  const engine = scheduler(clock, h.ports);
  engine.start();
  await clock.advanceTo(clock.now());
  assert.equal(reads, 1);
  const retryAt = clock.now() + 5_000;
  engine.wake(); engine.wake();
  assert.equal(clock.nextTimerAt, retryAt);
  await clock.advanceTo(retryAt - 1);
  assert.equal(reads, 1);
  await clock.advanceTo(retryAt);
  assert.equal(reads, 2);
  assert.equal(clock.nextTimerAt, retryAt + BACKGROUND_SCHEDULER_RECONCILE_MS);
  await engine.drainAndDispose();
});

test('long Retry-After is preserved across bounded timer chunks', async () => {
  const clock = new FakeClock();
  const h = createPorts(clock);
  let reads = 0;
  h.setRead(() => {
    reads += 1;
    if (reads === 1) throw Object.assign(new Error('read unavailable'), { retryAfterMs: BACKGROUND_SCHEDULER_MAX_TIMER_MS + 6_000 });
    return null;
  });
  const engine = scheduler(clock, h.ports);
  engine.start();
  await clock.advanceTo(clock.now());
  const retryAt = clock.now() + BACKGROUND_SCHEDULER_MAX_TIMER_MS + 6_000;
  assert.equal(clock.nextTimerAt, clock.now() + BACKGROUND_SCHEDULER_MAX_TIMER_MS);
  await clock.advanceTo(clock.now() + BACKGROUND_SCHEDULER_MAX_TIMER_MS);
  assert.equal(reads, 1, 'a timer chunk does not bypass the complete Retry-After interval');
  assert.equal(clock.nextTimerAt, clock.now() + 6_000);
  await clock.advanceTo(retryAt);
  assert.equal(reads, 2);
  await engine.drainAndDispose();
});

test('wall-clock rollback never passes a monotonic maximum to due admission', async () => {
  const clock = new FakeClock();
  const originalNow = clock.now();
  const h = createPorts(clock);
  const engine = scheduler(clock, h.ports);
  engine.start();
  await clock.advanceTo(originalNow);

  clock.nowValue = originalNow - 60 * 60_000;
  const rawNow = clock.now();
  const dueAt = rawNow + 30_000;
  assert.ok(dueAt < originalNow, 'fixture due time falls between rolled-back and prior wall time');
  h.work.push({ ...descriptor('workspace-new', 'future-work', 'account_sync', dueAt), state: 'pending' });
  engine.wake();
  await clock.advanceTo(rawNow);
  assert.equal(h.claimCount, 0);
  assert.equal(h.executeCount, 0);
  assert.equal(clock.nextTimerAt, dueAt);
  await clock.advanceTo(dueAt - 1);
  assert.equal(h.claimCount, 0);
  assert.equal(h.executeCount, 0);
  await clock.advanceTo(dueAt);
  assert.equal(h.claimCount, 1);
  assert.equal(h.executeCount, 1);
  await engine.drainAndDispose();
});

test('fresh wall time is rechecked immediately before claim after awaited metadata', async () => {
  const clock = new FakeClock(10_000);
  const h = createPorts(clock, [descriptor('workspace-a', 'future-work', 'account_sync', 9_000)]);
  const listWorkspaces = h.ports.listDueWorkspaces;
  const metadataGate = deferred();
  let metadataStarted = false;
  h.ports.listDueWorkspaces = async (input) => {
    if (!metadataStarted) { metadataStarted = true; await metadataGate.promise; }
    return listWorkspaces(input);
  };
  const engine = scheduler(clock, h.ports);
  engine.start();
  await clock.advanceTo(10_000);
  assert.equal(metadataStarted, true);
  clock.nowValue = 5_000;
  metadataGate.resolve();
  await flush();
  assert.equal(h.claimCount, 0);
  assert.equal(h.executeCount, 0);
  assert.equal(clock.nextTimerAt, 9_000);
  await clock.advanceTo(8_999);
  assert.equal(h.claimCount, 0);
  await clock.advanceTo(9_000);
  assert.equal(h.claimCount, 1);
  assert.equal(h.executeCount, 1);
  await engine.drainAndDispose();
});

test('clock rollback while claim is awaited holds the claim before dispatch', async () => {
  const clock = new FakeClock(10_000);
  const h = createPorts(clock, [descriptor('workspace-a', 'claimed-work', 'account_sync', 9_000)]);
  h.setClaim(async () => {
    clock.nowValue = 5_000;
    return Object.freeze({ claimId: 'workspace-a/claimed-work' });
  });
  const engine = scheduler(clock, h.ports);
  engine.start();
  await clock.advanceTo(10_000);
  assert.equal(h.claimCount, 1);
  assert.equal(h.executeCount, 0);
  assert.deepEqual(h.log[0].outcome, { kind: 'held', reason: 'clock_rollback_before_dispatch' });
  await engine.drainAndDispose();
});

test('late metadata-stage failures keep exponential read backoff', async () => {
  const clock = new FakeClock();
  const h = createPorts(clock, [descriptor('workspace-a', 'work-a', 'account_sync', clock.now())]);
  let workspaceReads = 0;
  h.ports.listDueWorkspaces = async () => {
    workspaceReads += 1;
    throw new Error('workspace metadata unavailable');
  };
  const engine = scheduler(clock, h.ports);
  engine.start();
  await clock.advanceTo(clock.now());
  const firstRetryAt = clock.now() + 1_000;
  assert.equal(clock.nextTimerAt, firstRetryAt);
  await clock.advanceTo(firstRetryAt);
  assert.equal(workspaceReads, 2);
  assert.equal(clock.nextTimerAt, firstRetryAt + 2_000);
  await engine.drainAndDispose();
});

test('deferred batch observation waits for durable nextDueAt and never enters a paid lane', async () => {
  const clock = new FakeClock();
  const h = createPorts(clock, [descriptor('workspace-a', 'batch-work', 'batch_observation')]);
  let executions = 0;
  h.setExecute(async () => {
    executions += 1;
    return executions === 1 ? { kind: 'deferred', code: 'batch_still_running', nextDueAt: clock.now() + 4_000 }
      : { kind: 'terminal', code: 'batch_settled' };
  });
  const engine = scheduler(clock, h.ports);
  engine.start();
  await clock.advanceTo(clock.now());
  const checkAt = clock.now() + 4_000;
  assert.equal(clock.nextTimerAt, checkAt);
  await clock.advanceTo(checkAt - 1);
  assert.equal(executions, 1);
  await clock.advanceTo(checkAt);
  assert.equal(executions, 2);
  assert.equal(h.log.every((item) => item.lane === 'batch_observation'), true);
  await engine.drainAndDispose();
});

test('stop during an awaited claim fences dispatch and shared drain waits for exact held outcome', async () => {
  const clock = new FakeClock();
  const h = createPorts(clock, [descriptor('workspace-a', 'work-a')]);
  const gate = deferred();
  h.setClaim(async () => gate.promise);
  const engine = scheduler(clock, h.ports);
  engine.start();
  await clock.advanceTo(clock.now());
  assert.equal(h.executeCount, 0);
  engine.stopAdmission();
  h.work[0].state = 'claimed';
  const claim = Object.freeze({ claimId: 'workspace-a/work-a' });
  gate.resolve(claim);
  await flush();
  assert.equal(h.executeCount, 0);
  const firstDrain = engine.drainAndDispose();
  const secondDrain = engine.drainAndDispose();
  assert.equal(firstDrain, secondDrain);
  await firstDrain;
  assert.equal(engine.lifecycle, 'drained');
  assert.deepEqual(h.log[0].outcome, { kind: 'held', reason: 'stopped_before_dispatch' });
});

test('failed outcome persistence remains owned and drain retries only that exact outcome', async () => {
  const clock = new FakeClock();
  const h = createPorts(clock, [descriptor('workspace-a', 'work-a')]);
  h.failNextRecords(2);
  const engine = scheduler(clock, h.ports);
  engine.start();
  await clock.advanceTo(clock.now());
  assert.equal(h.executeCount, 1);
  assert.equal(h.recordCalls, 1);
  engine.stopAdmission();
  await assert.rejects(engine.drainAndDispose(), /background_scheduler_drain_incomplete/);
  assert.equal(engine.lifecycle, 'stopping');
  await engine.drainAndDispose();
  assert.equal(engine.lifecycle, 'drained');
  assert.equal(h.executeCount, 1, 'drain never repeats an execution after finalization failed');
  assert.equal(h.recordCalls, 3);
});

test('ambiguous execution is reconciled once and never automatically resubmitted', async () => {
  const clock = new FakeClock();
  const h = createPorts(clock, [descriptor('workspace-a', 'work-a')]);
  h.setExecute(async () => { throw new Error('ambiguous dispatch'); });
  const engine = scheduler(clock, h.ports);
  engine.start();
  await clock.advanceTo(clock.now());
  assert.equal(h.executeCount, 1);
  assert.equal(h.reconcileCalls, 1);
  assert.equal(h.log[0].reason, 'execution_outcome_unknown');
  await clock.advanceTo(clock.now() + BACKGROUND_SCHEDULER_RECONCILE_MS);
  assert.equal(h.executeCount, 1);
  await engine.drainAndDispose();
});
