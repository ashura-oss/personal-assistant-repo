import { runPaidReplyFixture } from '../helpers/backgroundPaidWorkFixture.mjs';

const [directory, crashPoint = 'paid_claim', advanceClockText = '61000'] = process.argv.slice(2);
if (!directory || !['paid_claim', 'preparing', 'submitting', 'submission_unknown'].includes(crashPoint) || !/^\d{1,8}$/.test(advanceClockText)) {
  throw new Error('fixture_resume_crash_mode_invalid');
}
await runPaidReplyFixture({ directoryPath: directory, resumeExisting: true, advanceAfterRecoveryMs: Number(advanceClockText),
  ...(crashPoint === 'paid_claim' ? { crashAfterPaidClaim: true } : {
    crashAfterSavedJobStatus: crashPoint, ...(crashPoint === 'submission_unknown' ? { lostProviderAck: true } : {}) }) });
throw new Error('fixture_resume_crash_point_not_reached');
