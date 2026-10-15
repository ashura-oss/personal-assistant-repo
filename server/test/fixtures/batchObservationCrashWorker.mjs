import { randomUUID } from 'node:crypto';
import { createInitialWorkspaceState } from '../../dist/sharedControllerNode.mjs';
import { join } from 'node:path';
import { loadServerConfig } from '../../dist/config.js';
import { openServerFoundationInternal } from '../../dist/bootstrap.js';
import { recoverInterruptedBatchObservations } from '../../dist/batchObservationIndex.js';
import { ProcessWorkspaceActors } from '../../dist/runtimeActors.js';
import { createProductionApplicationRuntimeFactory } from '../../dist/applicationHost.node.mjs';

const directory = process.argv[2];
const mode = process.argv[3] ?? 'settled';
if (!directory) process.exit(70);
const config = loadServerConfig({ STILL_ORIGIN: 'http://127.0.0.1:3000', STILL_DATA_DIR: join(directory, 'private', 'data'),
  STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key') }, { staticRoot: join(directory, 'public'), allowLocalHttp: true });
const opened = openServerFoundationInternal(config);
const { kernel, vault, startup } = opened.privateContext;
startup.beginRecovery();
recoverInterruptedBatchObservations(kernel, startup.capability);
startup.seal();
const actors = new ProcessWorkspaceActors(kernel);
const runtime = await createProductionApplicationRuntimeFactory(config, { fetcher: async (_input, init = {}) => {
  if ((init.method ?? 'GET') !== 'GET') process.exit(71);
  if (mode === 'dispatched') {
    const admitted = kernel.withTrustedDatabaseTransaction((db) => {
      const attempt = db.prepare(`SELECT status FROM batch_observation_attempts ORDER BY created_at DESC LIMIT 1`).get();
      const command = db.prepare(`SELECT status FROM async_command_journal WHERE command_kind='assistant.batch.check' ORDER BY created_at DESC LIMIT 1`).get();
      return attempt?.status === 'dispatched' && Boolean(command);
    });
    process.exit(admitted ? 73 : 74);
  }
  return new Response('<html>temporarily unavailable</html>', { status: 429,
    headers: { 'content-type': 'text/html', 'retry-after': '7200' } });
} })({ kernel, vault, auth: opened.foundation.auth,
  runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
  listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit),
  processInstanceId: opened.privateContext.processInstanceId, createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID) });

const deadline = Date.now() + 12_000;
while (Date.now() < deadline) {
  const settled = kernel.withTrustedDatabaseTransaction((db) => {
    const command = db.prepare(`SELECT status FROM async_command_journal WHERE command_kind='assistant.batch.check' ORDER BY created_at DESC LIMIT 1`).get();
    const attempt = db.prepare(`SELECT status,result_code FROM batch_observation_attempts ORDER BY created_at DESC LIMIT 1`).get();
    return command?.status === 'inspect_required' && attempt?.status === 'deferred' && attempt?.result_code === 'provider_get_retry';
  });
  if (settled) process.exit(73);
  await new Promise((resolve) => setTimeout(resolve, 10));
}
// This deliberate nonzero exit is the test's crash boundary; no runtime/foundation close is called.
process.exit(72);
