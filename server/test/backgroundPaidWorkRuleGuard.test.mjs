import test from 'node:test';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('submitting checkpoint rejects a changed saved proactive rule before provider POST', async () => {
  await runPaidReplyFixture({ snapshotMutation: { stage: 'submitting', apply(state) {
    state.proactive.rules[0].revision += 1;
  } } });
});
