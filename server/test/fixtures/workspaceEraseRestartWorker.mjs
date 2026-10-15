import { randomUUID } from 'node:crypto';
import { loadServerConfig } from '../../dist/config.js';
import { startApplicationHost } from '../../dist/applicationHost.js';
import { createInitialWorkspaceState } from '../../dist/sharedControllerNode.mjs';
import { createProductionApplicationRuntimeFactory } from '../../dist/applicationHost.node.mjs';

const [origin, dataDirectory, vaultKeyFile, staticRoot] = process.argv.slice(2);
if (!origin || !dataDirectory || !vaultKeyFile || !staticRoot) throw new Error('restart fixture arguments required');
const config = loadServerConfig({ STILL_ORIGIN: origin, STILL_DATA_DIR: dataDirectory, STILL_VAULT_KEY_FILE: vaultKeyFile,
  STILL_GOOGLE_CLIENT_ID: 'google-client', STILL_GOOGLE_CLIENT_SECRET: 'synthetic-google-secret' }, { staticRoot, allowLocalHttp: true });
const parsedOrigin = new URL(origin);
const host = await startApplicationHost({ config, port: Number(parsedOrigin.port),
  foundation: { initialWorkspaceSnapshot: () => createInitialWorkspaceState(randomUUID) },
  createRuntime: createProductionApplicationRuntimeFactory(config) });
process.stdout.write('READY\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (input) => {
  if (input.includes('stop')) { await host.close(); process.exit(0); }
});
