import test from 'node:test';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('submitting checkpoint rejects changed saved guidance before provider POST', async () => {
  await runPaidReplyFixture({ snapshotMutation: { stage: 'submitting', apply(state) {
    const rules = state.documents.find((item) => item.path === 'memory/RULES.md');
    rules.content += '\nA new instruction appeared after consent.';
    rules.revision += 1;
  } } });
});
