import { runPaidReplyFixture } from '../helpers/backgroundPaidWorkFixture.mjs';

const [directory, advanceClockText = '61000', scenario = 'normal'] = process.argv.slice(2);
if (!directory || !/^\d{1,8}$/.test(advanceClockText) || !['normal', 'changed_body', 'no_post'].includes(scenario)) {
  throw new Error('fixture_resume_mode_invalid');
}
await runPaidReplyFixture({ directoryPath: directory, resumeExisting: true, advanceAfterRecoveryMs: Number(advanceClockText),
  ...(scenario === 'no_post' ? { expectNoProviderPost: true } : {}),
  ...(scenario === 'changed_body' ? { snapshotMutation: { stage: 'submitting', apply(state) {
    state.selectedMailTexts[0].text = 'source changed after certified recovery';
  } } } : {}) });
