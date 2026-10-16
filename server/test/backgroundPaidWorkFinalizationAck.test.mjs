import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundProactiveCandidateIndex } from '../dist/backgroundProactiveCandidates.js';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('proactive preflight settlement retries the exact committed finalization after ACK loss', async () => {
  const observation = { expectedStatus: 'deferred' };
  const calls = [];
  const settle = BackgroundProactiveCandidateIndex.prototype.settleWithinTransaction;
  BackgroundProactiveCandidateIndex.prototype.settleWithinTransaction = function (context, claim, outcome, now) {
    if (outcome.status === 'deferred') calls.push({ outcome: structuredClone(outcome), now });
    return settle.call(this, context, claim, outcome, now);
  };
  try {
    await runPaidReplyFixture({ losePreflightFinalizationAck: observation, stopAfterPreflightClaim: true });
    assert.equal(observation.committedThenThrown, true, 'the first finalization committed before its ACK was lost');
    assert.equal(observation.replayMatched, true, 'drain replayed the committed outcome');
    assert.equal(observation.drainCompleted, true, 'exact finalization replay lets owned shutdown drain complete');
    assert.ok(calls.length >= 2, 'the scheduler retried the committed preflight outcome');
    assert.deepEqual(calls[1], calls[0], 'the retry reuses the exact outcome and settlement timestamp');
  } finally {
    BackgroundProactiveCandidateIndex.prototype.settleWithinTransaction = settle;
  }
});
