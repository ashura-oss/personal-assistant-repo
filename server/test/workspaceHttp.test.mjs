import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';
import { AuthService } from '../dist/auth.js';
import { createDurableKernel } from '../dist/kernel.js';
import { createStillHttpServer } from '../dist/http.js';
import { RUNTIME_ACTOR_EXPIRES_AT } from '../dist/runtimeActors.js';
import { OwnedWorkspaceRuntime } from '../dist/ownedWorkspaceRuntime.node.mjs';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { createWorkspaceHttpApi } from '../dist/workspaceHttp.node.mjs';
import { PrivateAudioRepository } from '../dist/privateAudioRepository.js';

const authSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 61));
const AUDIO_PROCESS_ID = randomUUID();

async function freePort() {
  const blockedPorts = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
    101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 138, 139, 143, 161, 179, 389, 427, 465,
    512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
    1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6697, 10080]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = createNetServer();
    await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
    const port = probe.address().port;
    await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    if (!blockedPorts.has(port) && !(port >= 6665 && port <= 6669)) return port;
  }
  throw new Error('unable_to_allocate_fetch_compatible_port');
}

async function fixture({ withWorkspaceApi = true, wrapWorkspaceApi, withAudioApi = false, exposeAudioHistory = false, gateAudioSource = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'still-workspace-http-'));
  const staticRoot = join(directory, 'public');
  mkdirSync(join(staticRoot, 'assets'), { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body><div id="root"></div></body></html>');
  writeFileSync(join(staticRoot, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(staticRoot, 'sw.js'), '');
  writeFileSync(join(staticRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  const port = await freePort();
  const canonicalOrigin = `http://127.0.0.1:${port}`;
  let now = 1_800_000_000_000;
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'), now: () => now,
    validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const state = createInitialWorkspaceState(randomUUID);
  state.tasks.push({ id: 'legacy opaque task', title: 'Inbox task', body: '', status: 'open', createdAt: '2026-10-14T00:00:00.000Z',
    importOrigin: { kind: 'backup_import', archiveId: randomUUID(), sourceTaskId: 'legacy opaque task' } });
  const auth = new AuthService(kernel, { canonicalOrigin, allowLocalHttp: true, authSecret, now: () => now });
  const enrolled = await auth.enrollOwner('correct horse battery staple', state);
  const runtimeSession = kernel.createSession(enrolled.workspaceId, enrolled.ownerId, RUNTIME_ACTOR_EXPIRES_AT);
  const unavailable = async () => 'unavailable';
  let runtime;
  let attachedMedia;
  let audioUploadId;
  const audioSourceStarted = deferred();
  const releaseAudioSource = deferred();
  const audioRepository = withAudioApi ? new PrivateAudioRepository({ kernel, actorSessionToken: runtimeSession,
    privateRoot: join(directory, 'private-audio'), processId: AUDIO_PROCESS_ID,
    resolveAttachedMedia: ({ noteId, noteRevision }) => attachedMedia?.noteId === noteId && attachedMedia.noteRevision === noteRevision
      ? attachedMedia : undefined }) : undefined;
  const projectAudioReceipt = (receipt) => ({ schemaVersion: 1, uploadId: receipt.uploadId, status: receipt.status,
    capture: receipt.capture, ...(receipt.consumption ? { consumption: receipt.consumption } : {}), ...(receipt.media ? { media: receipt.media } : {}) });
  const directAudioApi = audioRepository ? Object.freeze({
    async upload(admission, input) {
      let source = input.source;
      if (gateAudioSource) source = (async function* () {
        let didPause = false;
        for await (const chunk of input.source) {
          yield chunk;
          if (!didPause) { didPause = true; audioSourceStarted.resolve(); await releaseAudioSource.promise; }
        }
      })();
      const receipt = await audioRepository.uploadCapture(source, { uploadId: input.uploadId, captureId: input.capture.id,
        capturedAt: input.capture.capturedAt, timeZone: input.capture.timeZone, mimeType: input.mimeType,
        ...(input.expectedByteLength === undefined ? {} : { expectedByteLength: input.expectedByteLength }) });
      audioUploadId = input.uploadId;
      return projectAudioReceipt(receipt);
    },
    async inspectUpload(_admission, uploadId) { return projectAudioReceipt(audioRepository.inspectCaptureUpload(uploadId)); },
    async openMedia(admission, mediaId, input) {
      if (!audioUploadId) throw new Error('audio_unavailable');
      const receipt = audioRepository.inspectCaptureUpload(audioUploadId);
      const noteId = receipt.status === 'consumed' && receipt.consumption?.noteId;
      const noteRevision = receipt.status === 'consumed' && receipt.consumption?.noteRevision;
      if (!receipt.media || receipt.media.mediaId.slice('still-media:'.length) !== mediaId || !noteId || !noteRevision) throw new Error('audio_unavailable');
      const record = audioRepository.getRecord(mediaId);
      if (record.status !== 'ready') throw new Error('audio_unavailable');
      attachedMedia = { mediaId, noteId, noteRevision, sha256: record.sha256, byteLength: record.byteLength };
      return audioRepository.openAttachedMedia({ noteId, noteRevision, method: input.method,
        ...(input.range ? { range: input.range } : {}), ...(input.signal ? { signal: input.signal } : {}) });
    },
  }) : undefined;
  const pendingCapture = audioRepository ? Object.freeze({
    async getStatus() { return Object.freeze({ kind: 'empty' }); },
    async inspect() { return Object.freeze({ kind: 'empty' }); },
    async export() { throw new Error('unsupported'); },
    async discard() { throw new Error('unsupported'); },
    async retryPendingCaptureSourceRelease() { return Object.freeze({ kind: 'empty' }); },
    async readForAdoption({ id, revision }) {
      const receipt = audioRepository.readCaptureForAdoption(id, revision);
      if (!receipt.media) throw new Error('capture media missing');
      return Object.freeze({ kind: 'server', uri: receipt.media.mediaId, capture: Object.freeze({
        id, revision, capturedAt: receipt.capture.capturedAt, captureTimeZone: receipt.capture.timeZone,
        durationSeconds: receipt.media.durationSeconds, media: Object.freeze({ uploadId: receipt.uploadId,
          mediaId: receipt.media.mediaId.slice('still-media:'.length), sha256: receipt.media.sha256,
          byteLength: receipt.media.byteLength, format: receipt.media.format, mimeType: receipt.media.mimeType }) }) });
    },
    async readConsumedEvidence(id) { return audioRepository.readConsumedCaptureEvidence(id); },
  }) : undefined;
  runtime = new OwnedWorkspaceRuntime({ kernel, runtimeSessionFor: () => runtimeSession,
    crypto: { randomUUID, async sha256(value) { return createHash('sha256').update(value).digest('hex'); } },
    providers: { speech: { async transcribe() { throw new Error('unexpected provider call'); }, async releaseUploadLease() {}, disposeMemory() {} },
      openAi: { async prepare() { throw new Error('unexpected provider call'); }, async analyze() { throw new Error('unexpected provider call'); },
        async generateReply() { throw new Error('unexpected provider call'); } } },
    integration: {
      reminderBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
        async listPending() { return []; }, async schedule() {}, async cancel() {}, async cancelLegacy() {}, async installForegroundHandler() {} },
      mailAlertBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable,
        async present() { return 'unavailable'; }, async cancel() { return 'cancellation_unknown'; } },
      deviceCalendarBackend: { platform: 'web', getPermission: unavailable, requestFullPermission: unavailable,
        async listCalendars() { return []; }, async getCalendar() { return undefined; }, async readEvents() { return []; },
        async createApprovedEvent() { throw new Error('unsupported'); }, async lookupRecord() { return undefined; } },
      async writeDocument() {}, async removeAudio() {},
      async loadRecordingRecovery() { return { async pickAndStage() { return null; }, async inspect() { throw new Error('unsupported'); }, async remove() {} }; },
      bindRecordingRecovery(service) { return service; },
    }, ...(directAudioApi ? { audioHttpApi: directAudioApi, pendingCapture,
      mediaResolver: { resolveMediaId(_note, uri) {
        const match = /^still-media:([0-9a-f-]{36})$/i.exec(uri);
        if (!match) return undefined;
        return audioRepository.getRecord(match[1]).status === 'ready' ? match[1] : undefined;
      } } } : {}) });
  const actualWorkspaceApi = withWorkspaceApi ? createWorkspaceHttpApi(runtime) : undefined;
  const workspaceApi = actualWorkspaceApi ? (wrapWorkspaceApi ? wrapWorkspaceApi(actualWorkspaceApi) : actualWorkspaceApi) : undefined;
  const server = createStillHttpServer({ auth, canonicalOrigin, allowLocalHttp: true, staticRoot,
    ...(workspaceApi ? { workspaceApi } : {}), ...(withAudioApi || exposeAudioHistory ? { audioApi: runtime.createAudioHttpApi() } : {}) });
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const request = (path, init = {}) => fetch(`${canonicalOrigin}${path}`, init);
  return { directory, canonicalOrigin, enrolled, kernel, auth, runtime, server, request, workspaceApi, audioRepository,
    audioSourceStarted: audioSourceStarted.promise, releaseAudioSource: () => releaseAudioSource.resolve(),
    setTime(value) { now = value; },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      await runtime.closeAfterDrain(); auth.close(); kernel.close();
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } };
}

function cookieValue(response, name) {
  const values = response.headers.getSetCookie?.() ?? [];
  return values.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1).split(';', 1)[0] ?? '';
}

async function login(f) {
  const guest = await f.request('/auth/session');
  const preauth = cookieValue(guest, '__Host-still_preauth');
  const guestDto = await guest.json();
  const response = await f.request('/auth/login', { method: 'POST', headers: {
    Origin: f.canonicalOrigin, Cookie: `__Host-still_preauth=${preauth}`, 'X-Still-CSRF': guestDto.csrfToken,
    'Content-Type': 'application/json',
  }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  assert.equal(response.status, 200);
  const session = cookieValue(response, '__Host-still_session');
  const dto = await response.json();
  assert.equal(JSON.stringify(dto).includes(session), false);
  return { cookie: `__Host-still_session=${session}`, csrf: dto.csrfToken };
}

function mutationHeaders(f, auth, { origin = f.canonicalOrigin, csrf = auth.csrf } = {}) {
  return { Origin: origin, Cookie: auth.cookie, 'X-Still-CSRF': csrf, 'Content-Type': 'application/json' };
}

function wavFixture() {
  const sampleRate = 8000;
  const data = Buffer.alloc(1600, 128);
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write('RIFF', 0, 'ascii'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii'); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate, 28);
  bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34); bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(data.length, 40); data.copy(bytes, 44);
  return bytes;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('authenticated workspace snapshot, refresh, command dispatch, and receipt inspection use the real safe adapter', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/api/workspace/snapshot')).status, 401);
    const auth = await login(f);
    const initialResponse = await f.request('/api/workspace/snapshot', { headers: { Cookie: auth.cookie } });
    assert.equal(initialResponse.status, 200);
    assert.equal(initialResponse.headers.get('cache-control'), 'no-store');
    const initial = await initialResponse.json();
    assert.equal(initial.workspaceId, f.enrolled.workspaceId);
    assert.ok(Number.isSafeInteger(initial.revision) && initial.revision >= 0);
    assert.deepEqual(initial.state.tasks.map((task) => task.id), ['legacy opaque task']);
    assert.equal('sessionToken' in initial, false);
    assert.equal('ticket' in initial, false);

    const commandId = randomUUID();
    const command = { schemaVersion: 1, commandId, expectedRevision: initial.revision, expectedPrivacyEpoch: initial.privacyEpoch,
      command: { kind: 'tasks.complete', taskId: 'legacy opaque task' } };
    const headers = { ...mutationHeaders(f, auth), 'X-Still-Command': commandId };
    const completedResponse = await f.request('/api/workspace/commands', { method: 'POST', headers, body: JSON.stringify(command) });
    assert.equal(completedResponse.status, 200);
    assert.equal(completedResponse.headers.get('cache-control'), 'no-store');
    const completed = await completedResponse.json();
    assert.equal(completed.status, 'finished');
    assert.deepEqual(completed.receipt, { schemaVersion: 1, commandId, kind: 'tasks.complete', objectId: 'legacy opaque task' });
    assert.equal(completed.snapshot.state.tasks[0].status, 'completed');
    assert.equal('admission' in completed, false);
    assert.equal('ticket' in completed, false);

    const replay = await f.request('/api/workspace/commands', { method: 'POST', headers, body: JSON.stringify(command) });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).snapshot.state.activity.filter((entry) => entry.message === 'Task completed: Inbox task.').length, 1);

    const inspectedResponse = await f.request(`/api/workspace/commands/${commandId}`, { headers: { Cookie: auth.cookie } });
    assert.equal(inspectedResponse.status, 200);
    const inspected = await inspectedResponse.json();
    assert.deepEqual(Object.keys(inspected).sort(), ['commandId', 'receipt', 'schemaVersion', 'status']);
    assert.equal(inspected.status, 'finished');
    assert.deepEqual(inspected.receipt, completed.receipt);

    const refreshedResponse = await f.request('/api/workspace/refresh', { method: 'POST', headers: mutationHeaders(f, auth), body: '{}' });
    assert.equal(refreshedResponse.status, 200);
    assert.equal((await refreshedResponse.json()).state.tasks[0].status, 'completed');
  } finally { await f.close(); }
});

test('transcription cancellation is an authenticated, exact empty-body signal route', async () => {
  const f = await fixture();
  try {
    const auth = await login(f);
    const commandId = randomUUID();
    const path = `/api/workspace/commands/${commandId}/cancel-transcription`;
    assert.equal((await f.request(path, { method: 'POST', headers: { Cookie: auth.cookie, Origin: f.canonicalOrigin,
      'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await f.request(`${path}?retry=1`, { method: 'POST', headers: mutationHeaders(f, auth), body: '{}' })).status, 400);
    assert.equal((await f.request(path, { method: 'POST', headers: mutationHeaders(f, auth), body: '{"cancel":true}' })).status, 400);
    assert.equal((await f.request(path, { method: 'GET', headers: { Cookie: auth.cookie } })).status, 405);
    const response = await f.request(path, { method: 'POST', headers: mutationHeaders(f, auth), body: '{}' });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { schemaVersion: 1, commandId, status: 'not_running' });
  } finally { await f.close(); }
});

test('authenticated raw audio upload, inspect, adoption and range playback use the runtime HTTP bridge', async () => {
  const f = await fixture({ withAudioApi: true });
  try {
    const bytes = wavFixture();
    const uploadId = randomUUID();
    const captureId = randomUUID();
    const capture = { id: captureId, capturedAt: '2026-10-15T00:00:00.000Z', timeZone: 'Asia/Singapore' };
    assert.equal((await f.request('/api/audio/uploads', { method: 'POST', headers: {
      Origin: f.canonicalOrigin, 'X-Still-Upload-ID': uploadId, 'X-Still-Capture': JSON.stringify(capture), 'Content-Type': 'audio/wav',
    }, body: bytes })).status, 401, 'raw upload is behind session authentication and CSRF admission');

    const auth = await login(f);
    const uploadResponse = await f.request('/api/audio/uploads', { method: 'POST', headers: {
      ...mutationHeaders(f, auth), 'X-Still-Upload-ID': uploadId, 'X-Still-Capture': JSON.stringify(capture), 'Content-Type': 'audio/wav',
    }, body: bytes });
    assert.equal(uploadResponse.status, 201, await uploadResponse.clone().text());
    assert.equal(uploadResponse.headers.get('cache-control'), 'no-store');
    const uploaded = await uploadResponse.json();
    assert.equal(uploaded.status, 'ready');
    assert.equal(uploaded.capture.id, captureId);
    assert.equal(uploaded.media.byteLength, bytes.length);
    assert.equal('privateRoot' in uploaded, false);

    const historyResponse = await f.request('/api/audio/upload-history', { headers: { Cookie: auth.cookie } });
    assert.equal(historyResponse.status, 200, await historyResponse.clone().text());
    assert.equal(historyResponse.headers.get('cache-control'), 'no-store');
    const history = await historyResponse.json();
    assert.equal(history.entries.length, 1);
    assert.deepEqual(history.entries[0], { uploadId, capture: uploaded.capture, status: 'ready',
      createdAt: history.entries[0].createdAt, updatedAt: history.entries[0].updatedAt });
    assert.deepEqual(Object.keys(history.entries[0]).sort(), ['capture', 'createdAt', 'status', 'updatedAt', 'uploadId']);
    assert.equal('media' in history.entries[0], false);
    assert.equal('sha256' in history.entries[0], false);

    const inspection = await f.request(`/api/audio/uploads/${uploadId}`, { headers: { Cookie: auth.cookie } });
    assert.equal(inspection.status, 200);
    assert.equal((await inspection.json()).media.sha256, uploaded.media.sha256);

    const snapshot = await (await f.request('/api/workspace/snapshot', { headers: { Cookie: auth.cookie } })).json();
    const commandId = randomUUID();
    const command = { schemaVersion: 1, commandId, expectedRevision: snapshot.revision, expectedPrivacyEpoch: snapshot.privacyEpoch,
      command: { kind: 'notes.capture.adopt', captureId, captureRevision: uploaded.capture.revision } };
    const adoptedResponse = await f.request('/api/workspace/commands', { method: 'POST', headers: mutationHeaders(f, auth), body: JSON.stringify(command) });
    assert.equal(adoptedResponse.status, 200);
    const adopted = await adoptedResponse.json();
    assert.equal(adopted.status, 'finished');
    assert.equal(adopted.receipt.captureId, captureId);
    const note = adopted.snapshot.state.notes.find((item) => item.id === captureId);
    assert.equal(note.audio.available, true);
    assert.equal(note.audio.mediaId, uploaded.media.mediaId.slice('still-media:'.length));
    const duplicate = await f.request('/api/workspace/commands', { method: 'POST', headers: mutationHeaders(f, auth), body: JSON.stringify(command) });
    assert.equal(duplicate.status, 200);
    assert.deepEqual((await duplicate.json()).receipt, adopted.receipt);
    const consumedInspection = await f.request(`/api/audio/uploads/${uploadId}`, { headers: { Cookie: auth.cookie } });
    assert.equal(consumedInspection.status, 200);
    const consumedReceipt = await consumedInspection.json();
    assert.equal(consumedReceipt.status, 'consumed');
    assert.deepEqual(consumedReceipt.consumption, { commandId, noteId: captureId, noteRevision: 1 });
    const consumedHistory = await (await f.request('/api/audio/upload-history', { headers: { Cookie: auth.cookie } })).json();
    assert.equal(consumedHistory.entries[0].status, 'consumed');
    assert.deepEqual(Object.keys(consumedHistory.entries[0]).sort(), ['capture', 'createdAt', 'status', 'updatedAt', 'uploadId']);

    const rawMediaId = uploaded.media.mediaId.slice('still-media:'.length);
    const mediaResponse = await f.request(`/api/audio/${rawMediaId}`, { headers: { Cookie: auth.cookie, Range: 'bytes=0-15' } });
    assert.equal(mediaResponse.status, 206, await mediaResponse.clone().text());
    assert.equal(mediaResponse.headers.get('content-range'), `bytes 0-15/${bytes.length}`);
    assert.deepEqual(Buffer.from(await mediaResponse.arrayBuffer()), bytes.subarray(0, 16));
    const head = await f.request(`/api/audio/${rawMediaId}`, { method: 'HEAD', headers: { Cookie: auth.cookie, Range: 'bytes=4-7' } });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-length'), '4');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await f.request(`/api/audio/${rawMediaId}`)).status, 401);
  } finally { await f.close(); }
});

test('audio upload history validates its sole cursor query and uses authenticated read admission', async () => {
  const f = await fixture({ withAudioApi: true });
  try {
    assert.equal((await f.request('/api/audio/upload-history')).status, 401);
    const auth = await login(f);
    assert.equal((await f.request('/api/audio/upload-history?cursor=', { headers: { Cookie: auth.cookie } })).status, 400);
    assert.equal((await f.request('/api/audio/upload-history?cursor=abc', { headers: { Cookie: auth.cookie } })).status, 400,
      'well-formed query text that is not a valid scoped history cursor is a client error');
    assert.equal((await f.request('/api/audio/upload-history?cursor=abc&cursor=def', { headers: { Cookie: auth.cookie } })).status, 400);
    assert.equal((await f.request('/api/audio/upload-history?other=x', { headers: { Cookie: auth.cookie } })).status, 400);
    assert.equal((await f.request('/api/audio/upload-history?cursor=%61bc', { headers: { Cookie: auth.cookie } })).status, 400);
    assert.equal((await f.request('/api/audio/upload-history?cursor=abc=', { headers: { Cookie: auth.cookie } })).status, 400);
    const wrongOrigin = await f.request('/api/audio/upload-history', { headers: { Cookie: auth.cookie, Origin: 'https://elsewhere.test',
      'X-Still-CSRF': 'wrong-token' } });
    assert.equal(wrongOrigin.status, 403, 'the shared same-origin gate rejects cross-origin requests');
    const wrongCsrf = await f.request('/api/audio/upload-history', { headers: { Cookie: auth.cookie, Origin: f.canonicalOrigin,
      'X-Still-CSRF': 'wrong-token' } });
    assert.equal(wrongCsrf.status, 200, 'safe GET history does not require a mutation CSRF token');
    const rawSession = auth.cookie.slice('__Host-still_session='.length);
    f.auth.logout(rawSession, f.canonicalOrigin, auth.csrf);
    assert.equal((await f.request('/api/audio/upload-history', { headers: { Cookie: auth.cookie } })).status, 401,
      'the same session cannot read history after it has been revoked');
    const wrongMethod = await f.request('/api/audio/upload-history', { method: 'POST', headers: { Cookie: auth.cookie } });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET');
  } finally { await f.close(); }
});

test('history reads a durable receiving upload while the upload owner is busy without registry or database writes', async () => {
  const f = await fixture({ withAudioApi: true, gateAudioSource: true });
  try {
    const auth = await login(f);
    f.kernel.withTrustedDatabaseTransaction((db) => db.exec(`CREATE TABLE audio_history_read_audit (event TEXT NOT NULL) STRICT;
      CREATE TRIGGER audio_history_read_insert AFTER INSERT ON private_audio_capture_uploads BEGIN INSERT INTO audio_history_read_audit VALUES ('insert'); END;
      CREATE TRIGGER audio_history_read_update AFTER UPDATE ON private_audio_capture_uploads BEGIN INSERT INTO audio_history_read_audit VALUES ('update'); END;
      CREATE TRIGGER audio_history_read_delete AFTER DELETE ON private_audio_capture_uploads BEGIN INSERT INTO audio_history_read_audit VALUES ('delete'); END;`));
    const registry = f.runtime.registry;
    const originalGet = registry.get.bind(registry);
    let registryCalls = 0;
    registry.get = (...args) => { registryCalls += 1; return originalGet(...args); };
    const uploadId = randomUUID();
    const upload = f.request('/api/audio/uploads', { method: 'POST', headers: {
      ...mutationHeaders(f, auth), 'X-Still-Upload-ID': uploadId,
      'X-Still-Capture': JSON.stringify({ id: randomUUID(), capturedAt: '2026-10-15T00:00:00.000Z', timeZone: 'Asia/Singapore' }),
      'Content-Type': 'audio/wav',
    }, body: wavFixture() });
    await f.audioSourceStarted;
    assert.equal(registryCalls, 1, 'the active upload has entered its per-workspace owner');
    const before = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS count FROM audio_history_read_audit').get().count);
    assert.ok(before > 0);
    const historyResponse = await f.request('/api/audio/upload-history', { headers: { Cookie: auth.cookie } });
    assert.equal(historyResponse.status, 200, await historyResponse.clone().text());
    const history = await historyResponse.json();
    assert.equal(history.entries[0].uploadId, uploadId);
    assert.equal(history.entries[0].status, 'receiving');
    assert.equal(registryCalls, 1, 'history bypasses registry access even while the upload has it busy');
    assert.equal(f.kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS count FROM audio_history_read_audit').get().count), before);
    f.releaseAudioSource();
    assert.equal((await upload).status, 201);
  } finally { f.releaseAudioSource(); await f.close(); }
});

test('fresh authenticated history returns empty without initializing private audio schema, directories, or a controller', async () => {
  const f = await fixture({ exposeAudioHistory: true });
  try {
    const auth = await login(f);
    const registry = f.runtime.registry;
    const originalGet = registry.get.bind(registry);
    let registryCalls = 0;
    registry.get = (...args) => { registryCalls += 1; return originalGet(...args); };
    const before = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'private_audio_%'").get().count);
    const response = await f.request('/api/audio/upload-history', { headers: { Cookie: auth.cookie } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { schemaVersion: 1, entries: [] });
    const after = f.kernel.withTrustedDatabaseTransaction((db) => db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name LIKE 'private_audio_%'").get().count);
    assert.equal(after, before);
    assert.equal(registryCalls, 0);
    assert.equal(existsSync(join(f.directory, 'private-audio')), false);
  } finally { await f.close(); }
});

test('workspace command route accepts text payloads above the ordinary 16 KiB body limit', async () => {
  const f = await fixture();
  try {
    const auth = await login(f);
    const snapshot = await (await f.request('/api/workspace/snapshot', { headers: { Cookie: auth.cookie } })).json();
    const commandId = randomUUID();
    const transcript = '😀\\\n漢'.repeat(2_500);
    const command = { schemaVersion: 1, commandId, expectedRevision: snapshot.revision, expectedPrivacyEpoch: snapshot.privacyEpoch,
      command: { kind: 'notes.save', transcript } };
    const response = await f.request('/api/workspace/commands', { method: 'POST', headers: mutationHeaders(f, auth), body: JSON.stringify(command) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 'finished');
    assert.equal(result.receipt.kind, 'notes.save');
    assert.equal(result.snapshot.state.notes.find((note) => note.id === result.receipt.objectId).transcript, transcript);

    const oversized = { ...command, commandId: randomUUID(), command: { kind: 'notes.save', transcript: 'x'.repeat(1024 * 1024) } };
    const tooLarge = await f.request('/api/workspace/commands', { method: 'POST', headers: mutationHeaders(f, auth), body: JSON.stringify(oversized) });
    assert.equal(tooLarge.status, 413, 'the widened text-command allowance still has a strict 1 MiB envelope ceiling');
    assert.match(await tooLarge.text(), /request_too_large/i, 'consume the complete rejection body before reusing the keep-alive connection');

    const malformedKind = { ...command, commandId: randomUUID(), command: { kind: ['chat.submit'], text: 'x'.repeat(17 * 1024) } };
    const malformedLarge = await f.request('/api/workspace/commands', { method: 'POST', headers: mutationHeaders(f, auth), body: JSON.stringify(malformedKind) });
    assert.equal(malformedLarge.status, 413, 'a non-string kind cannot opt malformed input into the text-command body allowance');
    assert.match(await malformedLarge.text(), /request_too_large/i);
  } finally { await f.close(); }
});

test('workspace commands require same-origin CSRF, strict paths, and a live session after body parsing', async () => {
  const f = await fixture();
  try {
    const auth = await login(f);
    const initial = await (await f.request('/api/workspace/snapshot', { headers: { Cookie: auth.cookie } })).json();
    const commandId = randomUUID();
    const command = { schemaVersion: 1, commandId, expectedRevision: initial.revision, expectedPrivacyEpoch: initial.privacyEpoch,
      command: { kind: 'tasks.complete', taskId: 'legacy opaque task' } };
    const body = JSON.stringify(command);
    const noCsrf = await f.request('/api/workspace/commands', { method: 'POST', headers: {
      Origin: f.canonicalOrigin, Cookie: auth.cookie, 'Content-Type': 'application/json' }, body });
    assert.equal(noCsrf.status, 403);
    const wrongOrigin = await f.request('/api/workspace/refresh', { method: 'POST', headers: mutationHeaders(f, auth, { origin: 'https://attacker.invalid' }), body: '{}' });
    assert.equal(wrongOrigin.status, 403);
    const query = await f.request('/api/workspace/snapshot?debug=1', { headers: { Cookie: auth.cookie } });
    assert.equal(query.status, 400);
    const invalidId = await f.request('/api/workspace/commands/not-a-uuid', { headers: { Cookie: auth.cookie } });
    assert.equal(invalidId.status, 400);
    const malformed = await f.request('/api/workspace/commands', { method: 'POST', headers: mutationHeaders(f, auth), body: '{' });
    assert.equal(malformed.status, 400);
    const wrongEncoding = await f.request('/api/workspace/commands', { method: 'POST', headers: {
      ...mutationHeaders(f, auth), 'Content-Encoding': 'gzip' }, body });
    assert.equal(wrongEncoding.status, 415);
    const oversized = await f.request('/api/workspace/commands', { method: 'POST', headers: mutationHeaders(f, auth),
      body: JSON.stringify({ padding: 'x'.repeat(17 * 1024) }) });
    assert.equal(oversized.status, 413);

    const originalAssert = f.auth.assertMutation.bind(f.auth);
    let checks = 0;
    f.auth.assertMutation = (token, origin, csrf) => {
      checks += 1;
      if (checks === 2) f.kernel.revokeSession(token);
      return originalAssert(token, origin, csrf);
    };
    const revokedDuringBody = await f.request('/api/workspace/commands', { method: 'POST', headers: mutationHeaders(f, auth), body });
    assert.equal(revokedDuringBody.status, 401);
    const verificationSession = f.kernel.createSession(f.enrolled.workspaceId, f.enrolled.ownerId, 2_000_000_000_000);
    const current = await f.runtime.getSnapshot({ sessionToken: verificationSession,
      assertCurrent() { f.kernel.getOwnedIdentity(verificationSession); } });
    assert.equal(current.state.tasks[0].status, 'open', 'the command was not admitted after body parsing revoked its session');
  } finally { await f.close(); }
});

test('workspace routes return unavailable when no trusted workspace adapter is mounted', async () => {
  const f = await fixture({ withWorkspaceApi: false });
  try {
    const auth = await login(f);
    const response = await f.request('/api/workspace/snapshot', { headers: { Cookie: auth.cookie } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'service_unavailable' });
  } finally { await f.close(); }
});

test('workspace HTTP rechecks authorization after an awaited read and after a committed command', async () => {
  const readStarted = deferred();
  const releaseRead = deferred();
  const committed = deferred();
  const releaseResponse = deferred();
  const f = await fixture({ wrapWorkspaceApi(api) {
    return { ...api, async getSnapshot(admission) {
      const snapshot = await api.getSnapshot(admission);
      readStarted.resolve();
      await releaseRead.promise;
      return snapshot;
    }, async dispatchCommand(admission, envelope) {
      const result = await api.dispatchCommand(admission, envelope);
      committed.resolve();
      await releaseResponse.promise;
      return result;
    } };
  } });
  try {
    const firstAuth = await login(f);
    const readRequest = f.request('/api/workspace/snapshot', { headers: { Cookie: firstAuth.cookie } });
    await readStarted.promise;
    f.kernel.revokeSession(firstAuth.cookie.split('=')[1]);
    releaseRead.resolve();
    assert.equal((await readRequest).status, 401, 'a snapshot completed during an authorization change is not returned');

    const currentToken = f.kernel.createSession(f.enrolled.workspaceId, f.enrolled.ownerId, 2_000_000_000_000);
    const currentSession = { sessionToken: currentToken, assertCurrent() { f.kernel.getOwnedIdentity(currentToken); } };
    const initial = await f.runtime.getSnapshot(currentSession);
    const loginChallenge = f.auth.createLoginChallenge(f.canonicalOrigin);
    // A second authenticated browser session supplies the command response fence.
    const loginResponse = await f.request('/auth/login', { method: 'POST', headers: { Origin: f.canonicalOrigin,
      Cookie: `__Host-still_preauth=${loginChallenge.preAuthToken}`, 'X-Still-CSRF': loginChallenge.csrfToken,
      'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
    assert.equal(loginResponse.status, 200);
    const token = cookieValue(loginResponse, '__Host-still_session');
    const loginDto = await loginResponse.json();
    const commandId = randomUUID();
    const command = { schemaVersion: 1, commandId, expectedRevision: initial.revision, expectedPrivacyEpoch: initial.privacyEpoch,
      command: { kind: 'tasks.complete', taskId: 'legacy opaque task' } };
    const commandResponsePromise = f.request('/api/workspace/commands', { method: 'POST', headers: {
      Origin: f.canonicalOrigin, Cookie: `__Host-still_session=${token}`, 'X-Still-CSRF': loginDto.csrfToken,
      'X-Still-Command': commandId, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    await committed.promise;
    f.kernel.revokeSession(token);
    releaseResponse.resolve();
    assert.equal((await commandResponsePromise).status, 401, 'committed work receives no response after session revocation');

    const inspectionToken = f.kernel.createSession(f.enrolled.workspaceId, f.enrolled.ownerId, 2_000_000_000_000);
    const inspected = f.workspaceApi.inspectCommand({ sessionToken: inspectionToken,
      assertCurrent() { f.kernel.getOwnedIdentity(inspectionToken); } }, commandId);
    assert.equal(inspected.status, 'finished', 'the committed receipt remains available to a newly authorized session');
  } finally { await f.close(); }
});

test('unexpected adapter failures return a fixed error without disclosing exception details', async () => {
  const f = await fixture({ wrapWorkspaceApi(api) {
    return { ...api, async dispatchCommand() { throw new Error('private token and SQL location'); } };
  } });
  try {
    const auth = await login(f);
    const snapshot = await (await f.request('/api/workspace/snapshot', { headers: { Cookie: auth.cookie } })).json();
    const commandId = randomUUID();
    const body = JSON.stringify({ schemaVersion: 1, commandId, expectedRevision: snapshot.revision,
      expectedPrivacyEpoch: snapshot.privacyEpoch, command: { kind: 'tasks.complete', taskId: 'legacy opaque task' } });
    const response = await f.request('/api/workspace/commands', { method: 'POST', headers: {
      ...mutationHeaders(f, auth), 'X-Still-Command': commandId }, body });
    assert.equal(response.status, 503);
    const responseText = await response.text();
    assert.equal(responseText, '{"error":"service_unavailable"}');
    assert.doesNotMatch(responseText, /private token|SQL location/);
  } finally { await f.close(); }
});
