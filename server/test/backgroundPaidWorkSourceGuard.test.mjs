import test from 'node:test';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('submitting checkpoint rejects changed current source metadata before provider POST', async () => {
  await runPaidReplyFixture({ snapshotMutation: { stage: 'submitting', apply(state) {
    state.mailbox[0].snippet = 'source changed after consent';
  } } });
});
