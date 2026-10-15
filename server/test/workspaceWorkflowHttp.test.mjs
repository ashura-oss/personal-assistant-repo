import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import test from 'node:test';
import { AuthService } from '../dist/auth.js';
import { createStillHttpServer } from '../dist/http.js';
import { createDurableKernel } from '../dist/kernel.js';

const authSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 31));

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-workflow-http-'));
  const staticRoot = join(directory, 'public');
  mkdirSync(join(staticRoot, '_expo', 'static', 'js', 'web'), { recursive: true });
  mkdirSync(join(staticRoot, 'assets'), { recursive: true });
  mkdirSync(join(staticRoot, 'assets', 'node_modules', '@expo', 'vector-icons', 'Fonts'), { recursive: true });
  mkdirSync(join(staticRoot, 'assets', 'oauth'), { recursive: true });
  const bundle = '/_expo/static/js/web/index-abcdef0123456789.js';
  const registration = '/pwa-register-0123456789abcdef.js';
  writeFileSync(join(staticRoot, 'index.html'), `<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/assets/still-icon.png"><script src="${registration}" defer></script></head><body><div id="root"></div><script src="${bundle}" defer></script></body></html>`);
  writeFileSync(join(staticRoot, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(staticRoot, 'sw.js'), 'self.addEventListener("fetch",()=>{});');
  writeFileSync(join(staticRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(staticRoot, 'assets', 'node_modules', '@expo', 'vector-icons', 'Fonts', 'icons.abcdef0123456789.ttf'), Buffer.from([0, 1, 2]));
  writeFileSync(join(staticRoot, 'assets', 'oauth', 'private.abcdef0123456789.ttf'), Buffer.from([0, 1, 2]));
  writeFileSync(join(staticRoot, registration.slice(1)), '/* registration */');
  writeFileSync(join(staticRoot, bundle.slice(1)), '/* public app bundle */');
  const port = await freePort();
  const canonicalOrigin = `http://127.0.0.1:${port}`;
  const kernel = createDurableKernel({ databasePath: join(directory, 'still.sqlite'), validateSnapshot: (value) => assert.ok(value && typeof value === 'object') });
  const auth = new AuthService(kernel, { canonicalOrigin, allowLocalHttp: true, authSecret });
  let received;
  const response = { schemaVersion: 1, status: 'current' };
  const workspaceApi = {
    async getSnapshot() { return {}; }, async refreshSnapshot() { return {}; }, async dispatchCommand() { return {}; },
    inspectCommand() { return {}; }, listCommandHistory() { return {}; }, cancelTranscription() { return {}; },
    async readMailReplySource(_admission, input) { received = ['source', input]; return response; },
    async readMailReplyText(_admission, input) { received = ['source-text', input]; return response; },
    async readProposalReview(_admission, input) { received = ['proposal', input]; return response; },
    async readDispatchReview(_admission, input) { received = ['dispatch', input]; return response; },
    async readMailReplyBatchReview(_admission, input) { received = ['batch', input]; return response; },
    async readPeriodSummaryResult(_admission, input) { received = ['period-summary', input]; return { ...response, review: { jobId: input.jobId, markdown: '# Inert' } }; },
  };
  const server = createStillHttpServer({ auth, canonicalOrigin, allowLocalHttp: true, staticRoot, workspaceApi });
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  await auth.enrollOwner('correct horse battery staple', { version: 1 });
  const challenge = auth.createLoginChallenge(canonicalOrigin);
  const login = await auth.login({ password: 'correct horse battery staple', origin: canonicalOrigin,
    preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken });
  return { directory, auth, kernel, server, canonicalOrigin, received: () => received, login,
    request: (path, init = {}) => fetch(`${canonicalOrigin}${path}`, { ...init, headers: { Cookie: `__Host-still_session=${login.sessionToken}`, ...(init.headers ?? {}) } }),
    close: async () => { auth.close(); kernel.close(); await new Promise((resolve) => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); } };
}

test('workflow reads accept decoded singleton opaque IDs and enforce closed query/revision fences', async () => {
  const f = await fixture();
  try {
    const opaque = 'saved/mail:Ω/part';
    const query = (key, id, extras = '') => `?${key}=${encodeURIComponent(id)}&expectedRevision=7&expectedPrivacyEpoch=3${extras}`;
    const source = await f.request(`/api/workspace/mail/source${query('messageId', opaque)}`);
    assert.equal(source.status, 200);
    assert.equal(source.headers.get('cache-control'), 'no-store');
    assert.deepEqual(f.received(), ['source', { messageId: opaque, expectedRevision: 7, expectedPrivacyEpoch: 3 }]);
    assert.equal((await f.request(`/api/workspace/mail/source${query('messageId', 'Ω'.repeat(513))}`)).status, 400,
      'opaque IDs use the 1024-byte UTF-8 bound, not the UTF-16 character count');
    const body = await f.request(`/api/workspace/mail/source-text${query('messageId', opaque)}`);
    assert.equal(body.status, 200);
    assert.equal(f.received()[0], 'source-text');
    const proposal = await f.request(`/api/workspace/proposals/review${query('proposalId', opaque)}`);
    assert.equal(proposal.status, 200);
    assert.equal(f.received()[0], 'proposal');
    const dispatch = await f.request(`/api/workspace/dispatch/review${query('recordId', opaque)}`);
    assert.equal(dispatch.status, 200);
    assert.equal(f.received()[0], 'dispatch');
    const batch = await f.request(`/api/workspace/mail/reply-batch/review?planId=${encodeURIComponent(opaque)}&jobId=${encodeURIComponent('job:Ω')}&accountId=${encodeURIComponent('acct/Ω')}&expectedConnectionGeneration=4&expectedRevision=7&expectedPrivacyEpoch=3`);
    assert.equal(batch.status, 200);
    assert.deepEqual(f.received(), ['batch', { planId: opaque, jobId: 'job:Ω', accountId: 'acct/Ω', expectedConnectionGeneration: 4, expectedRevision: 7, expectedPrivacyEpoch: 3 }]);
    const summary = await f.request(`/api/workspace/assistant/period-summary/result?jobId=${encodeURIComponent('30000000-0000-4000-8000-000000000001')}&expectedRevision=7&expectedPrivacyEpoch=3`);
    assert.equal(summary.status, 200);
    assert.deepEqual(f.received(), ['period-summary', { jobId: '30000000-0000-4000-8000-000000000001', expectedRevision: 7, expectedPrivacyEpoch: 3 }]);
    for (const invalid of [
      `/api/workspace/mail/source${query('messageId', opaque, '&messageId=again')}`,
      `/api/workspace/mail/source${query('messageId', opaque, '&other=x')}`,
      '/api/workspace/assistant/period-summary/result?jobId=30000000-0000-4000-8000-000000000001&expectedRevision=7&expectedPrivacyEpoch=3&extra=x',
      '/api/workspace/mail/source?messageId=%ZZ&expectedRevision=7&expectedPrivacyEpoch=3',
      '/api/workspace/mail/source?messageId=x&expectedRevision=-1&expectedPrivacyEpoch=3',
      '/api/workspace/mail/source?messageId=x&expectedRevision=7&expectedPrivacyEpoch=3&',
    ]) assert.equal((await f.request(invalid)).status, 400);
    assert.equal((await f.request(`/api/workspace/mail/source${query('messageId', opaque)}`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${f.canonicalOrigin}/api/workspace/mail/source${query('messageId', opaque)}`)).status, 401);
  } finally { await f.close(); }
});
