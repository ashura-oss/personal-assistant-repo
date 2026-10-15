import test from 'node:test';
import { createHash } from 'node:crypto';
import { runPaidReplyFixture } from './helpers/backgroundPaidWorkFixture.mjs';

test('submitting checkpoint rejects new unapproved guidance in the frozen request', async () => {
  await runPaidReplyFixture({ snapshotMutation: { stage: 'submitting', apply(_state, job) {
    const content = '# Unapproved guidance';
    job.mailReplyBinding.policy.push({ path: 'memory/EXTRA.md', revision: 1, content,
      sha256: createHash('sha256').update(content).digest('hex') });
  } } });
});
