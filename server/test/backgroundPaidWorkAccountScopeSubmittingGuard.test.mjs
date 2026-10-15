import test from 'node:test';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('submitting checkpoint rechecks effective scopes in the candidate snapshot', async () => {
  await runPaidReplyFixture({ snapshotMutation: { stage: 'submitting', apply(state) {
    const account = state.accounts.find((item) => item.id === 'google:paid-reply-fixture');
    account.grantedScopes = ['openid'];
  } } });
});
