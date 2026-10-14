import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..');
const serverPackage = resolve(repositoryRoot, 'server/package.json');
const requireFromServer = createRequire(pathToFileURL(serverPackage));
const esbuild = requireFromServer('esbuild');
const outputDirectory = resolve(repositoryRoot, '.expo/runtime-boundary');
const outputFile = resolve(outputDirectory, 'openRouterSpeechAdapter-node.mjs');

await mkdir(outputDirectory, { recursive: true });
await esbuild.build({
  entryPoints: [resolve(repositoryRoot, 'src/services/openRouterSpeechAdapter.shared.ts')],
  outfile: outputFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  plugins: [{
    name: 'deny-native-runtime-imports',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (/^(?:expo(?:$|[-/])|react-native(?:$|\/))/.test(args.path)) {
          return { errors: [{ text: `Node speech adapter import boundary rejected ${args.path} (imported by ${args.importer})` }] };
        }
        return undefined;
      });
    },
  }],
});

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
try {
  const { SharedOpenRouterSpeechAdapter } = await import(`${pathToFileURL(outputFile).href}?run=${Date.now()}`);
  assert.equal(typeof SharedOpenRouterSpeechAdapter, 'function', 'shared adapter exports from the Node bundle');

  const audioBytes = new Uint8Array([1, 2, 3, 4]);
  const leaseId = '11111111-1111-4111-8111-111111111111';
  const audio = {
    async prepare(_note, options) {
      assert.equal(options.leaseId, leaseId);
      return {
        leaseId, platform: 'web', format: 'm4a', mimeType: 'audio/mp4', byteLength: audioBytes.byteLength,
        sha256: createHash('sha256').update(audioBytes).digest('hex'), durationSeconds: 2,
        upload: { blob: new Blob([audioBytes], { type: 'audio/mp4' }), fileName: 'clip.m4a' },
      };
    },
    async verify() {},
    async release(id) { assert.equal(id, leaseId); },
  };
  let mockProviderCalls = 0;
  const client = {
    async transcribe(call) {
      await call.onBeforeDispatch();
      call.assertBeforeStart();
      mockProviderCalls += 1;
      return { kind: 'transcript', transcript: 'Node transcript' };
    },
    async retryPendingCleanup() {},
  };
  const sha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');
  const adapter = new SharedOpenRouterSpeechAdapter({ audio, client, sha256 });
  const note = { id: '22222222-2222-4222-8222-222222222222', title: 'Fixture', transcript: '', audioUri: 'fixture:audio', durationSeconds: 2,
    createdAt: '2026-10-14T00:00:00.000Z', status: 'recorded', revision: 1 };
  const settings = { speechProvider: 'openrouter', speechEnabled: true, maxAudioSeconds: 600 };
  const result = await adapter.transcribe(note, settings, undefined, async () => {}, () => {}, () => {}, leaseId);
  await result.cleanupPromise;
  assert.deepEqual({ outcome: result.outcome, transcript: result.transcript, unknownCharge: result.unknownCharge }, {
    outcome: 'completed', transcript: 'Node transcript', unknownCharge: true,
  });
  assert.equal(mockProviderCalls, 1, 'only the injected mock provider ran');
  adapter.disposeMemory();
} finally {
  if (originalCryptoDescriptor) Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
  else delete globalThis.crypto;
}

const output = await readFile(outputFile, 'utf8');
assert.doesNotMatch(output, /(?:from|import\()\s*['"](?:expo(?:[-/]|['"] )|react-native)/);
console.log('Node speech adapter boundary passed: bundled, imported, and executed with injected ports, no Expo or global crypto.');
