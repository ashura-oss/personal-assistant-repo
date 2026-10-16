import test from 'node:test';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('standing consent keeps its explicit model and effort when global chat settings change', async () => {
  await runPaidReplyFixture({ snapshotMutation: { stage: 'submitting', apply(state) {
    state.settings.openRouterModel = 'openai/other-model';
  } }, expectedAuthorizedRequest: { model: 'openai/gpt-6-luna', effort: 'none' } });
});
