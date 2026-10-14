import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..');
const serverPackage = resolve(repositoryRoot, 'server/package.json');
const requireFromServer = createRequire(pathToFileURL(serverPackage));
const esbuild = requireFromServer('esbuild');
const outputDirectory = resolve(repositoryRoot, '.expo/runtime-boundary');
const outputFile = resolve(outputDirectory, 'azureSpeech-node.mjs');
await mkdir(outputDirectory, { recursive: true });
await esbuild.build({
  entryPoints: [resolve(repositoryRoot, 'src/services/azureSpeech.shared.ts')],
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
          return { errors: [{ text: `Node Azure Speech import boundary rejected ${args.path} (imported by ${args.importer})` }] };
        }
        return undefined;
      });
    },
  }],
});

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
try {
  const { SharedAzureSpeechClient, SpeechCredentialChangedError } = await import(`${pathToFileURL(outputFile).href}?run=${Date.now()}`);
  assert.equal(typeof SharedAzureSpeechClient, 'function');
  assert.equal(typeof SpeechCredentialChangedError, 'function');
  const leaseId = '11111111-1111-4111-8111-111111111111';
  const note = { id: '22222222-2222-4222-8222-222222222222', title: 'fixture', transcript: '', audioUri: 'fixture:audio',
    durationSeconds: 2, createdAt: '2026-10-14T00:00:00.000Z', status: 'recorded', revision: 1 };
  const settings = { speechEnabled: true, speechEndpoint: 'https://example.cognitiveservices.azure.com', maxAudioSeconds: 600 };
  const audioCalls = { prepare: 0, verify: 0, release: [] };
  const audio = {
    async prepare(_note, options) {
      audioCalls.prepare += 1;
      const bytes = new Uint8Array([1, 2, 3, 4]);
      return { leaseId: options.leaseId, platform: 'web', format: 'm4a', mimeType: 'audio/mp4', byteLength: bytes.length,
        sha256: 'a'.repeat(64), durationSeconds: 2, upload: { blob: new Blob([bytes], { type: 'audio/mp4' }), fileName: 'clip.m4a' } };
    },
    async verify() { audioCalls.verify += 1; },
    async release(id) { audioCalls.release.push(id); },
  };
  const basePorts = (fetcher, overrides = {}) => ({
    fetcher,
    audio,
    readKeySnapshot: async () => ({ key: 'synthetic-key', generation: 3 }),
    currentCredentialGeneration: () => 3,
    assertCredentialGeneration(value) { if (value !== 3) throw new Error('stale generation'); },
    randomUUID: () => leaseId,
    withRequestOwnership: async (actualRequest) => actualRequest(),
    withResponseLifetime: async (input, init, consume, _retryCancel, beforeStart) => {
      beforeStart?.();
      return consume(await fetcher(input, init));
    },
    ...overrides,
  });
  let fetchCount = 0;
  const successFetcher = async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ durationMilliseconds: 2000, combinedPhrases: [{ text: 'Node transcript' }] }),
      { headers: { 'Content-Type': 'application/json' } });
  };
  const success = new SharedAzureSpeechClient(basePorts(successFetcher));
  const result = await success.transcribe(note, settings);
  await result.cleanupPromise;
  assert.equal(result.transcript, 'Node transcript');
  assert.equal(fetchCount, 1, 'successful transcription performs one request');
  assert.deepEqual(audioCalls.release, [leaseId]);

  let preflightCalls = 0;
  const preflight = new SharedAzureSpeechClient(basePorts(async () => { preflightCalls += 1; throw new Error('must not fetch'); }));
  await assert.rejects(preflight.transcribe(note, settings, undefined, undefined, () => { throw new Error('stale source'); }),
    (error) => error.code === 'pre_dispatch' && error.dispatched === false);
  assert.equal(preflightCalls, 0, 'source preflight failure happens before fetch');

  let missingLifetimeFetches = 0;
  const missingLifetime = new SharedAzureSpeechClient(basePorts(async () => {
    missingLifetimeFetches += 1;
    throw new Error('must not fetch without lifetime owner');
  }, { withResponseLifetime: undefined }));
  await assert.rejects(missingLifetime.transcribe(note, settings), (error) => error.code === 'pre_dispatch' && error.dispatched === false);
  assert.equal(missingLifetimeFetches, 0, 'missing required response lifetime cannot fall back to raw fetch');

  let credentialFetches = 0;
  const staleCredential = new SharedAzureSpeechClient(basePorts(async () => { credentialFetches += 1; throw new Error('must not fetch'); }, {
    async readKeySnapshot() { throw new SpeechCredentialChangedError(); },
  }));
  await assert.rejects(staleCredential.transcribe(note, settings), (error) => error.code === 'stale_credential' && error.dispatched === false);
  assert.equal(credentialFetches, 0, 'credential changes fail before fetch');

  let malformedFetches = 0;
  const malformed = new SharedAzureSpeechClient(basePorts(async () => {
    malformedFetches += 1;
    return new Response('{', { headers: { 'Content-Type': 'application/json' } });
  }));
  await assert.rejects(malformed.transcribe(note, settings), (error) => error.code === 'invalid_response' && error.dispatched === true);
  assert.equal(malformedFetches, 1, 'malformed provider response never retries');

  let resolveRaw;
  let rawFetchCount = 0;
  let rawStarted;
  const started = new Promise((resolve) => { rawStarted = resolve; });
  const rawFetcher = () => {
    rawFetchCount += 1;
    rawStarted();
    return new Promise((resolve) => { resolveRaw = resolve; });
  };
  const pendingAudio = { ...audio, release: async (id) => audioCalls.release.push(id) };
  const pending = new SharedAzureSpeechClient(basePorts(rawFetcher, { audio: pendingAudio, deadlineMs: 10 }));
  let timeout;
  try { await pending.transcribe(note, settings); } catch (error) { timeout = error; }
  assert.equal(timeout.code, 'timeout');
  await started;
  let cleanupFinished = false;
  const cleanup = timeout.cleanupPromise.then(() => { cleanupFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cleanupFinished, false, 'caller deadline does not claim the underlying request or lease cleanup settled');
  await assert.rejects(pending.transcribe(note, settings), (error) => error.code === 'pre_dispatch');
  assert.equal(rawFetchCount, 1, 'the blocked overlapping call did not dispatch another request');
  resolveRaw(new Response(JSON.stringify({ durationMilliseconds: 2000, combinedPhrases: [{ text: 'late' }] })));
  await cleanup;
  assert.equal(cleanupFinished, true);

  success.disposeMemory();
  preflight.disposeMemory();
  missingLifetime.disposeMemory();
  staleCredential.disposeMemory();
  malformed.disposeMemory();
  pending.disposeMemory();
} finally {
  if (originalCryptoDescriptor) Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
  else delete globalThis.crypto;
}

const bundle = await readFile(outputFile, 'utf8');
assert.doesNotMatch(bundle, /(?:from|import\()\s*['"](?:expo(?:[-/]|['"])|react-native)/);
console.log('Node Azure Speech boundary passed: injected ports, actual response parsing, no Expo/global crypto, and pending raw-request ownership.');
