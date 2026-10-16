import { runPaidReplyFixture } from '../helpers/backgroundPaidWorkFixture.mjs';

const [directory] = process.argv.slice(2);
if (!directory) throw new Error('fixture_directory_required');
await runPaidReplyFixture({ directoryPath: directory, crashAfterPaidClaim: true });
throw new Error('paid_claim_crash_point_not_reached');
