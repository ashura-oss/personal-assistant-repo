import { runPaidReplyFixture } from '../helpers/backgroundPaidWorkFixture.mjs';

const [directory, mode] = process.argv.slice(2);
if (!directory || !['missing', 'key-only', 'resume'].includes(mode)) throw new Error('credential_recovery_mode_invalid');
if (mode === 'missing') {
  await runPaidReplyFixture({ directoryPath: directory, missingOpenRouterCredential: true });
} else if (mode === 'key-only') {
  await runPaidReplyFixture({ directoryPath: directory, resumeExisting: true, configureOpenRouterKey: true, expectCredentialSetupOnly: true });
} else {
  await runPaidReplyFixture({ directoryPath: directory, resumeExisting: true, configureOpenRouterKey: true, reauthorizeExisting: true });
}
