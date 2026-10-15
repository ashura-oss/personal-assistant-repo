import test from 'node:test';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('submitting checkpoint rejects arbitrary guidance paths in the frozen request', async () => {
  await runPaidReplyFixture({ snapshotMutation: { stage: 'submitting', apply(_state, job) {
    job.mailReplyBinding.policy[0].path = 'private/other-workspace.md';
  } } });
});
