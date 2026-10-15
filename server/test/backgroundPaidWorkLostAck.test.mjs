import test from 'node:test';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('real production snapshot participant preserves unknown admission without automatic POST replay', async () => {
  await runPaidReplyFixture({ lostProviderAck: true });
});
