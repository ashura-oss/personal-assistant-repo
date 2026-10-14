import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..');
const serverPackage = resolve(repositoryRoot, 'server/package.json');
const requireFromServer = createRequire(pathToFileURL(serverPackage));
const esbuild = requireFromServer('esbuild');
const outputDirectory = resolve(repositoryRoot, '.expo/runtime-boundary');
const outputFile = resolve(outputDirectory, 'controller-node.mjs');

await mkdir(outputDirectory, { recursive: true });
await esbuild.build({
  entryPoints: [resolve(repositoryRoot, 'src/services/controller.shared.ts')],
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
          return { errors: [{ text: `Node controller import boundary rejected ${args.path} (imported by ${args.importer})` }] };
        }
        return undefined;
      });
    },
  }],
});

const { AppControllerImpl } = await import(`${pathToFileURL(outputFile).href}?run=${Date.now()}`);
assert.equal(typeof AppControllerImpl, 'function', 'shared controller class exports from Node bundle');

let savedState;
const trustedStore = {
  async load() { return savedState && structuredClone(savedState); },
  async save(state) { savedState = structuredClone(state); },
  async clear() { savedState = undefined; },
  async assertCurrent() {},
};
let providerCalls = 0;
let byteHashCalls = 0;
let batchDispatches = 0;
const unavailable = async () => 'unavailable';
const notificationBackend = {
  platform: 'web', getPermission: unavailable, requestPermission: unavailable,
  async listPending() { return []; }, async schedule() { throw new Error('notifications unsupported'); },
  async cancel() { throw new Error('notifications unsupported'); }, async cancelLegacy() { throw new Error('notifications unsupported'); },
  async installForegroundHandler() {},
};
const mailAlertBackend = {
  platform: 'web', getPermission: unavailable, requestPermission: unavailable,
  async present() { return 'unavailable'; }, async cancel() { return 'cancellation_unknown'; },
};
const deviceCalendarBackend = {
  platform: 'web', getPermission: unavailable, requestFullPermission: unavailable,
  async listCalendars() { throw new Error('device calendars unsupported'); },
  async getCalendar() { throw new Error('device calendars unsupported'); },
  async readEvents() { throw new Error('device calendars unsupported'); },
  async createApprovedEvent() { throw new Error('device calendars unsupported'); },
  async lookupRecord() { throw new Error('device calendars unsupported'); },
};
const cryptoPort = {
  randomUUID,
  async sha256(value) {
    if (value instanceof Uint8Array) byteHashCalls += 1;
    return createHash('sha256').update(value).digest('hex');
  },
};
const deniedProvider = {
  async prepare() { providerCalls += 1; throw new Error('provider denied by Node boundary fixture'); },
  async analyze() { providerCalls += 1; throw new Error('provider denied by Node boundary fixture'); },
  async generateReply() { providerCalls += 1; throw new Error('provider denied by Node boundary fixture'); },
};
const localBatchFixture = {
  async submit(_input, beforeDispatch, assertBeforeStart) {
    await beforeDispatch();
    assertBeforeStart();
    batchDispatches += 1;
    return { batchId: 'node-boundary-fixture', status: 'validating', endpoint: '/v1/chat/completions',
      model: 'openai/gpt-6-luna', completionWindow: '24h', total: 1, completed: 0, failed: 0 };
  },
};
const controller = new AppControllerImpl({
  store: trustedStore,
  crypto: cryptoPort,
  providers: { speech: { disposeMemory() {} }, openAi: deniedProvider },
  integration: {
    reminderBackend: notificationBackend,
    mailAlertBackend,
    deviceCalendarBackend,
    openRouterBatchClient: localBatchFixture,
    async writeDocument() {},
    async removeAudio() { throw new Error('audio unsupported'); },
    async loadRecordingRecovery() { throw new Error('recording recovery unsupported'); },
    bindRecordingRecovery(service) { return service; },
  },
});

await controller.load();
const note = await controller.saveNote({ transcript: 'Node boundary local note', capturedAt: '2026-10-14T00:00:00.000Z' });
assert.equal(note.transcript, 'Node boundary local note');
assert.equal(controller.getSnapshot().notes[0]?.id, note.id);
assert.equal(savedState.notes[0]?.id, note.id, 'trusted store received the saved note');
assert.equal(await cryptoPort.sha256('golden'), createHash('sha256').update('golden', 'utf8').digest('hex'));
assert.equal(providerCalls, 0, 'loading and saving local data does not contact a provider');

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
try {
  await controller.saveSettings({ mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
  await controller.submitNoteBatch(note.id, { intent: 'answer', question: 'What should happen next?' });
} finally {
  if (originalCryptoDescriptor) Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
  else delete globalThis.crypto;
}
assert.ok(byteHashCalls > 0, 'shared Batch request preparation hashes source bytes through the explicit runtime port');
assert.equal(batchDispatches, 1, 'Batch submission uses only the local no-network fixture');
assert.equal(providerCalls, 0, 'Batch preparation does not call a paid text provider');

// Inspect emitted bytes as a second guard against native imports hidden behind an unusual resolver.
const output = await readFile(outputFile, 'utf8');
assert.doesNotMatch(output, /(?:from|import\()\s*['"](?:expo(?:[-/]|['"] )|react-native)/);
console.log('Node controller boundary passed: bundled, imported, constructed, loaded, and saved without Expo or React Native.');
