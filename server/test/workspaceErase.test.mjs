import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { AuthService } from '../dist/auth.js';
import { createDurableKernel } from '../dist/kernel.js';
import { SecretVault } from '../dist/vault.js';
import { WorkspaceEraseService } from '../dist/workspaceErase.js';
import { DocumentLineage } from '../dist/documentLineage.js';
import { PeriodSummaryApplicationRuntime } from '../dist/periodSummaryApplication.js';

const ORIGIN = 'http://127.0.0.1:43210';
const SECRET = Buffer.alloc(32, 0x5a);
const EMPTY = Object.freeze({ accounts: [], documents: [], tasks: [], notes: [], proposals: [], backgroundPolicies: [] });

async function setup(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'still-workspace-erase-'));
  const privateDocumentsRoot = options.privateDocumentsRoot === true ? join(directory, 'private-documents') : options.privateDocumentsRoot;
  let now = 1_800_000_000_000;
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'), now: () => now,
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  const auth = new AuthService(kernel, { canonicalOrigin: ORIGIN, allowLocalHttp: true, authSecret: SECRET, now: () => now });
  const initialSnapshot = options.initialSnapshot ?? EMPTY;
  const enrolled = await auth.enrollOwner('correct horse battery staple', initialSnapshot);
  const vault = new SecretVault(kernel, randomBytes(32));
  const service = new WorkspaceEraseService({ kernel, auth, vault, createEmptySnapshot: () => EMPTY, now: () => now,
    ...(privateDocumentsRoot ? { privateDocumentsRoot } : {}),
    ...(options.beforePhysicalCleanupForTesting ? { beforePhysicalCleanupForTesting: options.beforePhysicalCleanupForTesting } : {}) });
  async function login() {
    const challenge = auth.createLoginChallenge(ORIGIN);
    return auth.login({ password: 'correct horse battery staple', origin: ORIGIN,
      preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken });
  }
  function admission(result) {
    return { sessionToken: result.sessionToken, assertCurrent() {
      const status = auth.getSession(result.sessionToken);
      assert.equal(status.authenticated, true);
    } };
  }
  return { directory, privateDocumentsRoot, kernel, auth, vault, service, enrolled,
    get now() { return now; }, set now(value) { now = value; }, login, admission,
    async close() { vault.close(); auth.close(); kernel.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5 }); } };
}

test('erase status survives refresh and a fresh owner can cancel an expired review idempotently', async () => {
  const f = await setup();
  const commandId = randomUUID();
  let hold;
  try {
    const firstLogin = await f.login();
    const firstAdmission = f.admission(firstLogin);
    const identity = f.kernel.getOwnedIdentity(firstLogin.sessionToken);
    hold = Object.freeze({ identity, commandId, assertHeld() {}, releaseAfterCleanup() {}, releaseAfterCancellation() {} });
    const reserve = async (_admission, requestedCommandId) => { assert.equal(requestedCommandId, commandId); return hold; };
    const verify = (actual, requestedCommandId) => { assert.equal(actual, hold); assert.equal(requestedCommandId, commandId); };
    const plan = await f.service.prepare(firstAdmission, { commandId, expectedRevision: identity.revision,
      expectedPrivacyEpoch: identity.privacyEpoch }, reserve, verify);
    assert.equal(plan.status, 'prepared');
    assert.deepEqual(plan.counts, { notes: 0, documents: 0, accounts: 0, proposals: 0, audioUploads: 0, backgroundPolicies: 0 });
    assert.equal((await f.service.inspectStatus(firstAdmission)).plan.commandId, commandId);

    f.now += 6 * 60_000;
    const freshLogin = await f.login();
    const freshAdmission = f.admission(freshLogin);
    const freshIdentity = f.kernel.getOwnedIdentity(freshLogin.sessionToken);
    assert.equal(freshIdentity.privacyEpoch, identity.privacyEpoch);
    const cancelled = await f.service.cancel(freshAdmission, { commandId, expectedRevision: plan.expectedRevision,
      expectedPrivacyEpoch: plan.expectedPrivacyEpoch }, reserve, verify);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await f.service.inspectStatus(freshAdmission)).status, 'cancelled');
    const duplicate = await f.service.cancel(freshAdmission, { commandId, expectedRevision: plan.expectedRevision,
      expectedPrivacyEpoch: plan.expectedPrivacyEpoch }, reserve, verify);
    assert.deepEqual(duplicate, cancelled);
  } finally { await f.close(); }
});

test('confirmed erase atomically advances the epoch, empties the snapshot, preserves auth, and clears private rows', async () => {
  const initialSnapshot = { ...EMPTY, documents: [{ path: 'private/secret.md', content: 'private document', revision: 1,
    updatedAt: '2026-10-15T00:00:00.000Z' }] };
  const f = await setup({ initialSnapshot, privateDocumentsRoot: true });
  const commandId = randomUUID();
  try {
    const login = await f.login();
    const admission = f.admission(login);
    const documentRoot = join(f.privateDocumentsRoot, f.enrolled.ownerId, f.enrolled.workspaceId);
    mkdirSync(documentRoot, { recursive: true });
    writeFileSync(join(documentRoot, 'secret.md'), 'synthetic private document file');
    const lineage = new DocumentLineage(f.kernel, login.sessionToken);
    new PeriodSummaryApplicationRuntime(f.kernel, login.sessionToken, lineage);
    f.kernel.withOwnedTransaction(login.sessionToken, 0, (context) => {
      lineage.captureDestination(context, 'private/secret.md');
      const insert = context.db.prepare(`INSERT INTO period_summary_application_receipts
        (workspace_id,owner_id,privacy_epoch,job_id,command_id,request_sha256,result_sha256,destination_path,document_id,document_revision,applied_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
      insert.run(context.workspaceId, context.ownerId, context.privacyEpoch, randomUUID(), randomUUID(), 'a'.repeat(64), 'b'.repeat(64),
        'memory/summaries/daily/2026-10-14.md', randomUUID(), 1, context.now);
      insert.run(context.workspaceId, randomUUID(), context.privacyEpoch, randomUUID(), randomUUID(), 'c'.repeat(64), 'd'.repeat(64),
        'memory/summaries/daily/2026-10-14.md', randomUUID(), 1, context.now);
      f.vault.setSecretWithinTransaction(context, { type: 'workspace' }, 'openrouter', 0, 'synthetic-secret');
    });
    const identity = f.kernel.getOwnedIdentity(login.sessionToken);
    f.kernel.withOwnedTransaction(login.sessionToken, 0, (context) => {
      assert.throws(() => context.db.prepare(`DELETE FROM period_summary_application_receipts WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?`)
        .run(context.workspaceId, context.ownerId, context.privacyEpoch), /period_summary_application_receipts_are_durable/);
    });
    const hold = Object.freeze({ identity, commandId, assertHeld() {}, releaseAfterCleanup() {}, releaseAfterCancellation() {} });
    const reserve = async (_admission, requestedCommandId) => { assert.equal(requestedCommandId, commandId); return hold; };
    const verify = (actual, requestedCommandId) => { assert.equal(actual, hold); assert.equal(requestedCommandId, commandId); };
    const reviewed = await f.service.prepare(admission, { commandId, expectedRevision: identity.revision,
      expectedPrivacyEpoch: identity.privacyEpoch }, reserve, verify);
    await f.service.confirm(admission, { commandId, expectedRevision: reviewed.expectedRevision,
      expectedPrivacyEpoch: reviewed.expectedPrivacyEpoch }, reserve, verify);
    const erased = await f.service.execute(admission, { commandId, expectedRevision: reviewed.expectedRevision,
      expectedPrivacyEpoch: reviewed.expectedPrivacyEpoch }, reserve, verify);
    assert.equal(erased.status, 'complete');
    assert.equal(existsSync(documentRoot), false, 'the receipt completes only after the private document tree is removed');
    assert.equal(f.auth.getSession(login.sessionToken).authenticated, false);

    const fresh = await f.login();
    const nextIdentity = f.kernel.getOwnedIdentity(fresh.sessionToken);
    assert.equal(nextIdentity.privacyEpoch, 1);
    assert.equal(nextIdentity.revision, identity.revision + 1);
    const erasedSnapshot = f.kernel.withOwnedTransaction(fresh.sessionToken, 1, (context) => f.kernel.readOwnedSnapshotWithinTransaction(context).snapshot);
    assert.deepEqual(JSON.parse(JSON.stringify(erasedSnapshot)), EMPTY);
    const state = f.kernel.withOwnedTransaction(fresh.sessionToken, 1, (context) => ({
      lineageHeads: context.db.prepare('SELECT count(*) AS count FROM document_lineage_heads WHERE workspace_id=? AND owner_id=?').get(context.workspaceId, context.ownerId).count,
      lineageScopes: context.db.prepare('SELECT count(*) AS count FROM document_lineage_scopes WHERE workspace_id=? AND owner_id=?').get(context.workspaceId, context.ownerId).count,
      applicationReceipts: context.db.prepare('SELECT count(*) AS count FROM period_summary_application_receipts WHERE workspace_id=? AND owner_id=?').get(context.workspaceId, context.ownerId).count,
      foreignApplicationReceipts: context.db.prepare('SELECT count(*) AS count FROM period_summary_application_receipts WHERE workspace_id=? AND owner_id<>?').get(context.workspaceId, context.ownerId).count,
      vaultCiphertexts: context.db.prepare('SELECT count(*) AS count FROM vault_ciphertexts WHERE workspace_id=?').get(context.workspaceId).count,
      vaultMetadata: context.db.prepare("SELECT generation,configured FROM vault_metadata WHERE workspace_id=? AND scope_type='workspace' AND purpose='openrouter'").get(context.workspaceId),
      authOwner: context.db.prepare('SELECT count(*) AS count FROM auth_owner WHERE singleton=1 AND owner_id=?').get(context.ownerId).count,
    }));
    assert.equal(state.lineageHeads, 0);
    assert.equal(state.lineageScopes, 0);
    assert.equal(state.applicationReceipts, 0);
    assert.equal(state.foreignApplicationReceipts, 1, 'erase must preserve receipt rows outside its exact owner scope');
    assert.equal(state.vaultCiphertexts, 0);
    assert.deepEqual(state.vaultMetadata, { generation: 2, configured: 0 });
    assert.equal(state.authOwner, 1);
    const status = await f.service.inspectStatus(f.admission(fresh));
    assert.equal(status.status, 'complete');
    assert.equal(status.receipt.commandId, commandId);
  } finally { await f.close(); }
});

test('a fresh erase connection registers the exact lineage delete guard without constructing DocumentLineage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-workspace-erase-lineage-guard-'));
  const databasePath = join(directory, 'workspace.sqlite');
  const vaultRootKey = randomBytes(32);
  let now = 1_800_000_000_000;
  const createKernel = () => createDurableKernel({ databasePath, now: () => now,
    validateSnapshot(value) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); } });
  let kernel = createKernel();
  let auth = new AuthService(kernel, { canonicalOrigin: ORIGIN, allowLocalHttp: true, authSecret: SECRET, now: () => now });
  let vault = new SecretVault(kernel, vaultRootKey);
  let enrolled;
  try {
    enrolled = await auth.enrollOwner('correct horse battery staple', { ...EMPTY,
      documents: [{ path: 'lineage.md', content: 'synthetic lineage content', revision: 1, updatedAt: '2026-10-15T00:00:00.000Z' }] });
    const challenge = auth.createLoginChallenge(ORIGIN);
    const firstLogin = await auth.login({ password: 'correct horse battery staple', origin: ORIGIN,
      preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken });
    const lineage = new DocumentLineage(kernel, firstLogin.sessionToken);
    kernel.withOwnedTransaction(firstLogin.sessionToken, 0, (context) => lineage.captureDestination(context, 'lineage.md'));
  } finally {
    vault.close(); auth.close(); kernel.close();
  }
  kernel = createKernel();
  auth = new AuthService(kernel, { canonicalOrigin: ORIGIN, allowLocalHttp: true, authSecret: SECRET, now: () => now });
  vault = new SecretVault(kernel, vaultRootKey);
  try {
    const service = new WorkspaceEraseService({ kernel, auth, vault, createEmptySnapshot: () => EMPTY, now: () => now,
      privateDocumentsRoot: join(directory, 'private-documents') });
    const challenge = auth.createLoginChallenge(ORIGIN);
    const login = await auth.login({ password: 'correct horse battery staple', origin: ORIGIN,
      preAuthToken: challenge.preAuthToken, csrfToken: challenge.csrfToken });
    const admission = { sessionToken: login.sessionToken, assertCurrent() {
      assert.equal(auth.getSession(login.sessionToken).authenticated, true);
    } };
    const identity = kernel.getOwnedIdentity(login.sessionToken);
    kernel.withOwnedTransaction(login.sessionToken, identity.privacyEpoch, (context) => {
      assert.throws(() => context.db.prepare(`DELETE FROM document_lineage_heads WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?`)
        .run(context.workspaceId, context.ownerId, context.privacyEpoch), /document_lineage_tombstones_are_durable/);
    });
    const commandId = randomUUID();
    const hold = Object.freeze({ identity, commandId, assertHeld() {}, releaseAfterCleanup() {}, releaseAfterCancellation() {} });
    const reserve = async () => hold;
    const verify = (actual) => assert.equal(actual, hold);
    const plan = await service.prepare(admission, { commandId, expectedRevision: identity.revision,
      expectedPrivacyEpoch: identity.privacyEpoch }, reserve, verify);
    await service.confirm(admission, { commandId, expectedRevision: plan.expectedRevision,
      expectedPrivacyEpoch: plan.expectedPrivacyEpoch }, reserve, verify);
    assert.equal((await service.execute(admission, { commandId, expectedRevision: plan.expectedRevision,
      expectedPrivacyEpoch: plan.expectedPrivacyEpoch }, reserve, verify)).status, 'complete');
    assert.equal(kernel.withTrustedDatabaseTransaction((db) => db.prepare('SELECT count(*) AS count FROM document_lineage_heads').get().count), 0);
  } finally {
    vault.close(); auth.close(); kernel.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('cleanup receipt reads are side-effect free and an authenticated explicit retry completes after fresh login', async (t) => {
  const f = await setup({ privateDocumentsRoot: true });
  const outside = join(f.directory, 'outside');
  const marker = join(outside, 'keep.txt');
  const ownerRoot = join(f.privateDocumentsRoot, f.enrolled.ownerId);
  const workspaceRoot = join(ownerRoot, f.enrolled.workspaceId);
  const commandId = randomUUID();
  let released = false;
  try {
    mkdirSync(outside, { recursive: true });
    writeFileSync(marker, 'preserve until explicit retry');
    mkdirSync(dirname(f.privateDocumentsRoot), { recursive: true });
    mkdirSync(f.privateDocumentsRoot, { recursive: true });
    try { symlinkSync(outside, ownerRoot, 'junction'); }
    catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOTSUP') { t.skip('directory symlinks are unavailable on this host'); return; }
      throw error;
    }
    const login = await f.login();
    const admission = f.admission(login);
    const identity = f.kernel.getOwnedIdentity(login.sessionToken);
    const hold = Object.freeze({ identity, commandId, assertHeld() {}, releaseAfterCleanup() { released = true; }, releaseAfterCancellation() {} });
    const reserve = async () => hold;
    const verify = (actual) => assert.equal(actual, hold);
    const reviewed = await f.service.prepare(admission, { commandId, expectedRevision: identity.revision,
      expectedPrivacyEpoch: identity.privacyEpoch }, reserve, verify);
    await f.service.confirm(admission, { commandId, expectedRevision: reviewed.expectedRevision,
      expectedPrivacyEpoch: reviewed.expectedPrivacyEpoch }, reserve, verify);
    const pendingReceipt = await f.service.execute(admission, { commandId, expectedRevision: reviewed.expectedRevision,
      expectedPrivacyEpoch: reviewed.expectedPrivacyEpoch }, reserve, verify);
    assert.equal(pendingReceipt.status, 'cleanup_pending');
    assert.equal(released, false);

    const fresh = await f.login();
    const freshAdmission = f.admission(fresh);
    const pending = await f.service.inspectStatus(freshAdmission);
    assert.equal(pending.status, 'cleanup_pending');
    assert.equal(pending.receipt.commandId, commandId);
    assert.equal(released, false, 'a GET status read cannot release the hold');
    assert.equal(readFileSync(marker, 'utf8'), 'preserve until explicit retry');

    rmSync(ownerRoot, { recursive: true, force: true });
    mkdirSync(workspaceRoot, { recursive: true });
    const privateFile = join(workspaceRoot, 'private.md');
    writeFileSync(privateFile, 'still pending');
    assert.equal((await f.service.inspect(freshAdmission, commandId)).status, 'cleanup_pending');
    assert.equal(existsSync(privateFile), true, 'receipt inspection is read-only');
    await assert.rejects(f.service.retryPhysicalCleanup(freshAdmission, { commandId, expectedPrivacyEpoch: 0 }));
    const foreignCommandId = randomUUID();
    f.kernel.withTrustedDatabaseTransaction((db) => db.prepare(`INSERT INTO workspace_erase_receipts(command_id,workspace_id,owner_id,
      erased_privacy_epoch,current_privacy_epoch,status,created_at,updated_at) VALUES(?,?,?,0,1,'cleanup_pending',1,1)`)
      .run(foreignCommandId, f.enrolled.workspaceId, randomUUID()));
    await assert.rejects(f.service.retryPhysicalCleanup(freshAdmission, { commandId: foreignCommandId, expectedPrivacyEpoch: 1 }));
    const completed = await f.service.retryPhysicalCleanup(freshAdmission, { commandId, expectedPrivacyEpoch: 1 });
    assert.equal(completed.status, 'complete');
    assert.equal(existsSync(privateFile), false);
    assert.equal(released, true, 'only successful explicit physical cleanup releases the old runtime hold');
    const replay = await f.service.retryPhysicalCleanup(freshAdmission, { commandId, expectedPrivacyEpoch: 1 });
    assert.deepEqual(replay, completed);
  } finally { await f.close(); }
});

test('durable cleanup refuses a tampered owner path and leaves an outside marker untouched', async () => {
  const f = await setup({ privateDocumentsRoot: true });
  const marker = join(f.directory, 'outside-marker.txt');
  writeFileSync(marker, 'preserve');
  const commandId = randomUUID();
  const workspaceId = randomUUID();
  try {
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.prepare(`INSERT INTO workspace_erase_receipts(command_id,workspace_id,owner_id,erased_privacy_epoch,current_privacy_epoch,status,created_at,updated_at)
        VALUES(?,?,?,0,1,'cleanup_pending',1,1)`).run(commandId, workspaceId, '../escape');
      db.prepare(`INSERT INTO workspace_erase_files(command_id,workspace_id,owner_id,privacy_epoch,kind,relative_path)
        VALUES(?,?,?,0,'documents','workspace-tree')`).run(commandId, workspaceId, '../escape');
    });
    await f.service.resumePendingPhysicalCleanup();
    assert.equal(readFileSync(marker, 'utf8'), 'preserve');
    assert.equal(existsSync(join(dirname(f.privateDocumentsRoot), 'escape', workspaceId)), false);
  } finally { await f.close(); }
});

test('durable cleanup refuses a symlinked owner directory', async (t) => {
  const f = await setup({ privateDocumentsRoot: true });
  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  const outside = join(f.directory, 'outside');
  const marker = join(outside, 'keep.txt');
  const ownerRoot = join(f.privateDocumentsRoot, ownerId);
  const commandId = randomUUID();
  try {
    mkdirSync(outside, { recursive: true });
    writeFileSync(marker, 'preserve');
    mkdirSync(dirname(f.privateDocumentsRoot), { recursive: true });
    mkdirSync(f.privateDocumentsRoot, { recursive: true });
    try { symlinkSync(outside, ownerRoot, 'junction'); }
    catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ENOTSUP') { t.skip('directory symlinks are unavailable on this host'); return; }
      throw error;
    }
    f.kernel.withTrustedDatabaseTransaction((db) => {
      db.prepare(`INSERT INTO workspace_erase_receipts(command_id,workspace_id,owner_id,erased_privacy_epoch,current_privacy_epoch,status,created_at,updated_at)
        VALUES(?,?,?,0,1,'cleanup_pending',1,1)`).run(commandId, workspaceId, ownerId);
      db.prepare(`INSERT INTO workspace_erase_files(command_id,workspace_id,owner_id,privacy_epoch,kind,relative_path)
        VALUES(?,?,?,0,'documents','workspace-tree')`).run(commandId, workspaceId, ownerId);
    });
    await f.service.resumePendingPhysicalCleanup();
    assert.equal(readFileSync(marker, 'utf8'), 'preserve');
  } finally { await f.close(); }
});


test('used erase command IDs are rejected before acquiring new holds and duplicate cancellation is read-only', async () => {
  const f = await setup();
  const commandId = randomUUID();
  let reserveCalls = 0;
  try {
    const login = await f.login();
    const admission = f.admission(login);
    const identity = f.kernel.getOwnedIdentity(login.sessionToken);
    const hold = Object.freeze({ identity, commandId, assertHeld() {}, releaseAfterCleanup() {}, releaseAfterCancellation() {} });
    const reserve = async (_admission, requested) => {
      reserveCalls += 1;
      assert.equal(requested, commandId);
      return hold;
    };
    const verify = (actual, requested) => { assert.equal(actual, hold); assert.equal(requested, commandId); };
    const plan = await f.service.prepare(admission, { commandId, expectedRevision: identity.revision,
      expectedPrivacyEpoch: identity.privacyEpoch }, reserve, verify);
    await assert.rejects(f.service.confirm(admission, { commandId, expectedRevision: plan.expectedRevision + 1,
      expectedPrivacyEpoch: plan.expectedPrivacyEpoch }, reserve, verify), /workspace_erase_plan_unavailable/);
    assert.equal(reserveCalls, 1, 'an invalid confirmation does not create or drain a hold');
    const cancellationInput = { commandId, expectedRevision: plan.expectedRevision, expectedPrivacyEpoch: plan.expectedPrivacyEpoch };
    await f.service.cancel(admission, cancellationInput, reserve, verify);
    assert.equal(reserveCalls, 2);
    await f.service.cancel(admission, cancellationInput, async () => { reserveCalls += 1; return hold; }, verify);
    assert.equal(reserveCalls, 2, 'duplicate cancellation returns its durable receipt without acquiring a new hold');
    await assert.rejects(f.service.prepare(admission, { commandId, expectedRevision: identity.revision,
      expectedPrivacyEpoch: identity.privacyEpoch }, async () => { reserveCalls += 1; return hold; }, verify), /workspace_erase_command_conflict/);
    assert.equal(reserveCalls, 2, 'cancelled command reuse cannot create a new undrained hold');
  } finally { await f.close(); }
});

test('completed erase command cannot acquire a replacement runtime hold', async () => {
  const f = await setup();
  const commandId = randomUUID();
  let reserveCalls = 0;
  let heldHandle;
  const identityFor = (sessionToken) => f.kernel.getOwnedIdentity(sessionToken);
  const reserve = async (admission, requested) => {
    reserveCalls += 1;
    if (!heldHandle) {
      const identity = identityFor(admission.sessionToken);
      heldHandle = Object.freeze({ identity, commandId: requested, assertHeld() {}, releaseAfterCleanup() {}, releaseAfterCancellation() {} });
    }
    return heldHandle;
  };
  const verify = (hold, requested) => { assert.equal(hold.commandId, requested); };
  try {
    const login = await f.login();
    const admission = f.admission(login);
    const identity = f.kernel.getOwnedIdentity(login.sessionToken);
    const plan = await f.service.prepare(admission, { commandId, expectedRevision: identity.revision,
      expectedPrivacyEpoch: identity.privacyEpoch }, reserve, verify);
    await f.service.confirm(admission, { commandId, expectedRevision: plan.expectedRevision,
      expectedPrivacyEpoch: plan.expectedPrivacyEpoch }, reserve, verify);
    await f.service.execute(admission, { commandId, expectedRevision: plan.expectedRevision,
      expectedPrivacyEpoch: plan.expectedPrivacyEpoch }, reserve, verify);
    assert.equal(reserveCalls, 3);
    const fresh = await f.login();
    const freshAdmission = f.admission(fresh);
    const current = f.kernel.getOwnedIdentity(fresh.sessionToken);
    await assert.rejects(f.service.prepare(freshAdmission, { commandId, expectedRevision: current.revision,
      expectedPrivacyEpoch: current.privacyEpoch }, async () => { reserveCalls += 1; throw new Error('must not reserve'); }, verify),
      /workspace_erase_command_conflict/);
    assert.equal(reserveCalls, 3);
  } finally { await f.close(); }
});

test('execute, startup recovery, and explicit retry share one physical cleanup flight and release only after completion', async () => {
  let enteredCleanup;
  const entered = new Promise((resolve) => { enteredCleanup = resolve; });
  let releaseCleanup;
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  let traversalCount = 0;
  const f = await setup({ privateDocumentsRoot: true, beforePhysicalCleanupForTesting: async (intent) => {
    assert.equal(intent.kind, 'documents');
    assert.equal(intent.relativePath, 'workspace-tree');
    traversalCount += 1;
    enteredCleanup();
    await cleanupGate;
  } });
  const commandId = randomUUID();
  const workspaceRoot = join(f.privateDocumentsRoot, f.enrolled.ownerId, f.enrolled.workspaceId);
  let releaseCount = 0;
  let holdActive = true;
  try {
    mkdirSync(workspaceRoot, { recursive: true });
    const oldFile = join(workspaceRoot, 'old.md');
    writeFileSync(oldFile, 'synthetic content to erase');
    const login = await f.login();
    const admission = f.admission(login);
    const identity = f.kernel.getOwnedIdentity(login.sessionToken);
    const hold = Object.freeze({ identity, commandId, assertHeld() { assert.equal(holdActive, true); },
      releaseAfterCleanup() { assert.equal(holdActive, true); holdActive = false; releaseCount += 1; }, releaseAfterCancellation() {} });
    const reserve = async () => hold;
    const verify = (actual) => assert.equal(actual, hold);
    const plan = await f.service.prepare(admission, { commandId, expectedRevision: identity.revision,
      expectedPrivacyEpoch: identity.privacyEpoch }, reserve, verify);
    await f.service.confirm(admission, { commandId, expectedRevision: plan.expectedRevision,
      expectedPrivacyEpoch: plan.expectedPrivacyEpoch }, reserve, verify);

    const execute = f.service.execute(admission, { commandId, expectedRevision: plan.expectedRevision,
      expectedPrivacyEpoch: plan.expectedPrivacyEpoch }, reserve, verify);
    await entered;
    assert.equal(traversalCount, 1);
    assert.equal(existsSync(oldFile), true, 'the real file tree stays intact while its one traversal is paused');
    assert.equal(holdActive, true, 'normal workspace admission remains held until the traversal and receipt commit finish');
    const startupRecovery = f.service.resumePendingPhysicalCleanup();
    const fresh = await f.login();
    const freshAdmission = f.admission(fresh);
    const retryInput = { commandId, expectedPrivacyEpoch: 1 };
    const retryOne = f.service.retryPhysicalCleanup(freshAdmission, retryInput);
    const retryTwo = f.service.retryPhysicalCleanup(freshAdmission, retryInput);
    assert.equal(traversalCount, 1, 'startup and both fresh-login retries join the same installed flight');
    assert.equal(holdActive, true);
    releaseCleanup();

    const [executed, retriedOne, retriedTwo] = await Promise.all([execute, retryOne, retryTwo]);
    await startupRecovery;
    assert.equal(executed.status, 'complete');
    assert.deepEqual(retriedOne, executed);
    assert.deepEqual(retriedTwo, executed);
    assert.equal(existsSync(oldFile), false);
    assert.equal(traversalCount, 1, 'only the shared flight performed filesystem deletion');
    assert.equal(releaseCount, 1, 'the exact hold is released once after physical cleanup is durably complete');

    const freshFile = join(workspaceRoot, 'new-epoch.md');
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(freshFile, 'new epoch content must survive');
    const [terminalRetryOne, terminalRetryTwo] = await Promise.all([
      f.service.retryPhysicalCleanup(freshAdmission, retryInput),
      f.service.retryPhysicalCleanup(freshAdmission, retryInput),
    ]);
    assert.equal(terminalRetryOne.status, 'complete');
    assert.deepEqual(terminalRetryTwo, terminalRetryOne, 'terminal duplicate retries read the same durable receipt without releasing a stale hold twice');
    assert.equal(traversalCount, 1);
    assert.equal(existsSync(freshFile), true, 'a completed receipt replay cannot delete files written after release');
  } finally {
    releaseCleanup();
    await f.close();
  }
});
