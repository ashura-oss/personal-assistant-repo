import { runPaidReplyFixture } from '../helpers/backgroundPaidWorkFixture.mjs';

const [directory, crashAfterSavedJobStatus = 'preparing', lostProviderAck = 'false'] = process.argv.slice(2);
if (!directory) throw new Error('fixture_directory_required');
if (!['preparing', 'submitting', 'submission_unknown'].includes(crashAfterSavedJobStatus) ||
    !['true', 'false'].includes(lostProviderAck) || crashAfterSavedJobStatus === 'submission_unknown' && lostProviderAck !== 'true') {
  throw new Error('fixture_crash_mode_invalid');
}
await runPaidReplyFixture({ directoryPath: directory, crashAfterSavedJobStatus,
  ...(lostProviderAck === 'true' ? { lostProviderAck: true } : {}) });
throw new Error('preparing_job_crash_point_not_reached');
