import test from 'node:test';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('preparing checkpoint rejects a candidate that revokes the selected account mail.read scope', async () => {
  await runPaidReplyFixture({ snapshotMutation: { stage: 'preparing', apply(state) {
    const account = state.accounts.find((item) => item.id === 'google:paid-reply-fixture');
    account.grantedScopes = ['openid'];
  } } });
});
