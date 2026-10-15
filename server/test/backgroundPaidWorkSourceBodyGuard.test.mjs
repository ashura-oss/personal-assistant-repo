import test from 'node:test';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('submitting checkpoint rejects a changed selected mail body before provider POST', async () => {
  await runPaidReplyFixture({ snapshotMutation: { stage: 'submitting', apply(state) {
    state.selectedMailTexts[0].text = 'changed after consent';
  } } });
});
