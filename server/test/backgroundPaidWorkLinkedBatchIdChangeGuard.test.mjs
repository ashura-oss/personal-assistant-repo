import test from 'node:test';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('linked settlement rejects changing a committed provider batch ID', async () => {
  await runPaidReplyFixture({ snapshotMutation: { stage: 'queued', apply() {}, followupStatus: 'queued', followup(_state, job) {
    job.batchId = 'forged-different-batch-id';
  } } });
});
