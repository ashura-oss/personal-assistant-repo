import { runPaidReplyFixture } from '../helpers/backgroundPaidWorkFixture.mjs';

const [directory, mode] = process.argv.slice(2);
if (!directory || !['each-a', 'each-b', 'each-repeat-b', 'first-a', 'mode-switch'].includes(mode)) {
  throw new Error('source_version_worker_mode_invalid');
}
if (mode === 'each-a') {
  await runPaidReplyFixture({ directoryPath: directory, sourceChangePolicy: 'each_changed_source', pauseAfterProvider: false });
} else if (mode === 'each-b') {
  await runPaidReplyFixture({ directoryPath: directory, resumeExisting: true, sourceChangePolicy: 'each_changed_source',
    expectedExistingLinkCount: 2, pauseAfterProvider: false,
    changeExistingSourceTo: { subject: 'A changed question', snippet: 'The question has changed.', text: 'Please review the revised project overview.' } });
} else if (mode === 'each-repeat-b') {
  await runPaidReplyFixture({ directoryPath: directory, resumeExisting: true, expectNoAdditionalProviderPost: true,
    expectedExistingLinkCount: 2, expectedNoPostPreflightStatus: 'complete' });
} else if (mode === 'first-a') {
  await runPaidReplyFixture({ directoryPath: directory, pauseAfterProvider: true });
} else {
  await runPaidReplyFixture({ directoryPath: directory, resumeExisting: true, reauthorizeExisting: true,
    sourceChangePolicy: 'each_changed_source', changeExistingSourceTo: { subject: 'A changed question',
      snippet: 'The question has changed.', text: 'Please review the revised project overview.' },
    expectNoAdditionalProviderPost: true, expectedExistingLinkCount: 1, expectedNoPostPreflightStatus: 'inspect_required' });
}
