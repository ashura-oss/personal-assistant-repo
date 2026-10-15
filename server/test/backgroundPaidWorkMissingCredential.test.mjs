import test from 'node:test';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('real production snapshot participant records missing credentials as not_submitted without provider I/O or a Batch link', async () => {
  await runPaidReplyFixture({ missingOpenRouterCredential: true });
});
