import test from 'node:test';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('unlinked not-submitted job cannot be turned into a queued provider job', async () => {
  await runPaidReplyFixture({ missingOpenRouterCredential: true, snapshotMutation: { stage: 'failed', apply() {},
    followupStatus: 'failed', followup(_state, job) {
      job.status = 'queued';
      job.failureCode = undefined;
      job.batchId = 'forged-batch-id';
      job.unknownCharge = true;
    } } });
});
