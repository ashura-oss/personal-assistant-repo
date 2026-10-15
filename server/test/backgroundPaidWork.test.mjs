import test from 'node:test';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('real production snapshot participant links one proactive occurrence to the exact journaled mail reply Batch', async () => {
  await runPaidReplyFixture();
});
