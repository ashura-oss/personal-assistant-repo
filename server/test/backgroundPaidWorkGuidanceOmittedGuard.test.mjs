import test from 'node:test';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('submitting checkpoint rejects omitted guidance from the frozen request', async () => {
  await runPaidReplyFixture({ snapshotMutation: { stage: 'submitting', apply(_state, job) {
    job.mailReplyBinding.policy.pop();
  } } });
});
