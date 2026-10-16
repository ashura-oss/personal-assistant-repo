import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createDurableKernel } from '../dist/kernel.js';
import { CommandJournal } from '../dist/commandJournal.js';
import { BackgroundBatchLinkStore } from '../dist/backgroundBatchLink.js';
import { DocumentLineage } from '../dist/documentLineage.js';
import { PeriodSummaryCaptureStore } from '../dist/periodSummaryCaptureStore.js';
import { canonicalBackgroundJson } from '../dist/backgroundContracts.js';
import { ServerWorkspaceStore, composeSnapshotCommitParticipants } from '../dist/workspaceStore.js';
import { PeriodSummaryPaidWork } from '../dist/periodSummaryPaidWork.node.mjs';
import { PeriodSummaryRecovery } from '../dist/periodSummaryRecovery.node.mjs';
import { capturePeriodSummarySources } from '../dist/periodSummarySources.node.mjs';
import { AppControllerImpl, createInitialWorkspaceState, OpenRouterBatchDispatchError } from '../dist/sharedControllerNode.mjs';

const sha = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const COMMAND_KIND = 'assistant.periodsummary.scheduled.submit';

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'still-summary-paid-work-'));
  const kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'),
    validateSnapshot: (value) => assert.ok(value && typeof value === 'object' && !Array.isArray(value)) });
  const ownerId = randomUUID();
  const state = createInitialWorkspaceState(randomUUID, { mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' });
  const noteId = randomUUID();
  state.notes.push({ id: noteId, title: 'Fixture note', transcript: 'A dated note for the paid summary fixture.', durationSeconds: 1,
    createdAt: '2026-06-30T12:00:00.000Z', capturedAt: '2026-06-30T12:00:00.000Z', captureTimeZone: 'UTC', status: 'recorded', revision: 1 });
  const workspace = kernel.createWorkspace(ownerId, state);
  const sessionToken = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const admissionSession = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
  const journal = new CommandJournal(kernel);
  const lineage = new DocumentLineage(kernel, sessionToken);
  const captureStore = new PeriodSummaryCaptureStore(kernel, sessionToken);
  const batchLinks = new BackgroundBatchLinkStore(kernel);
  return { directory, kernel, ownerId, workspace, state, noteId, sessionToken, admissionSession, journal, lineage, captureStore, batchLinks,
    close() { kernel.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); } };
}

function countPaidLinks(f, sessionToken = f.sessionToken) {
  return f.kernel.withOwnedTransaction(sessionToken, 0, (context) => {
    const table = context.db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='background_paid_batch_links'").get();
    return table ? context.db.prepare('SELECT COUNT(*) AS count FROM background_paid_batch_links WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?')
      .get(context.workspaceId, context.ownerId, context.privacyEpoch).count : 0;
  });
}

function makeAuthorityFixture(f) {
  const policyId = randomUUID();
  const occurrenceId = randomUUID();
  const attemptId = randomUUID();
  const capability = randomUUID();
  const values = { policyId, policyRevision: 1, policyDigest: 'a'.repeat(64), executionOptionsDigest: 'b'.repeat(64),
    occurrenceSourceDigest: 'c'.repeat(64), occurrenceRequestDigest: 'd'.repeat(64),
    effort: 'low', instructions: 'Summarize the selected saved events.', emailTextMode: 'complete_body' };
  f.kernel.withTrustedDatabaseTransaction((db) => {
    db.exec(`CREATE TABLE fixture_summary_authority(workspace_id TEXT,owner_id TEXT,privacy_epoch INTEGER,occurrence_id TEXT,attempt_id TEXT,
      capability_sha256 TEXT,policy_id TEXT,policy_revision INTEGER,policy_digest TEXT,execution_options_digest TEXT,
      source_digest TEXT,request_digest TEXT,source_version_digest TEXT,status TEXT,job_id TEXT,
      PRIMARY KEY(workspace_id,owner_id,privacy_epoch,occurrence_id)) STRICT`);
    db.prepare(`INSERT INTO fixture_summary_authority VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'claimed',NULL)`)
      .run(f.workspace.workspaceId, f.ownerId, 0, occurrenceId, attemptId, sha(capability), policyId, 1, values.policyDigest,
        values.executionOptionsDigest, values.occurrenceSourceDigest, values.occurrenceRequestDigest, null);
  });
  const readAndAssert = (context, ticket, claim, evidence) => {
    f.kernel.assertOwnedTransactionContext(context);
    f.journal.assertScheduledPeriodSummarySubmissionWithinTransaction(context, ticket);
    const row = context.db.prepare(`SELECT * FROM fixture_summary_authority WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, claim.occurrenceId);
    assert.ok(row);
    assert.equal(row.attempt_id, claim.attemptId);
    assert.equal(row.capability_sha256, sha(claim.capability));
    assert.equal(row.status, 'claimed');
    assert.equal(row.policy_id, values.policyId);
    assert.equal(evidence.request.period, 'daily');
    assert.equal(evidence.request.timeZone, 'UTC');
    return row;
  };
  const authority = {
    prepareWithinTransaction(context, ticket, claim, captureEvidence) {
      readAndAssert(context, ticket, claim, captureEvidence);
      return Object.freeze({ ...values });
    },
    beginSubmissionWithinTransaction(context, ticket, claim, evidence, job, expectedLink) {
      const row = readAndAssert(context, ticket, claim, { request: { period: evidence.period, timeZone: evidence.timeZone } });
      assert.equal(job.id, evidence.jobId);
      assert.equal(job.status, 'submitting');
      const changed = context.db.prepare(`UPDATE fixture_summary_authority SET status='dispatching',job_id=?
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=? AND attempt_id=? AND capability_sha256=? AND status='claimed'`)
        .run(evidence.jobId, context.workspaceId, context.ownerId, context.privacyEpoch, claim.occurrenceId, claim.attemptId, row.capability_sha256);
      assert.equal(changed.changes, 1);
      return expectedLink;
    },
    assertBeforePostWithinTransaction(context, ticket, claim, evidence, job, link) {
      f.kernel.assertOwnedTransactionContext(context);
      f.journal.assertScheduledPeriodSummarySubmissionWithinTransaction(context, ticket);
      const row = context.db.prepare(`SELECT status,job_id,attempt_id,capability_sha256,policy_id,policy_revision,policy_digest FROM fixture_summary_authority
        WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, claim.occurrenceId);
      assert.equal(row?.status, 'dispatching');
      assert.equal(row?.job_id, evidence.jobId);
      assert.equal(row?.attempt_id, claim.attemptId);
      assert.equal(row?.capability_sha256, sha(claim.capability));
      assert.equal(row?.policy_id, evidence.policyId);
      assert.equal(row?.policy_revision, evidence.policyRevision);
      assert.equal(row?.policy_digest, evidence.policyDigest);
      assert.equal(job.requestSha256, evidence.requestSha256);
      assert.equal(link.jobId, evidence.jobId);
    },
    readRecoveryWithinTransaction(context, evidence) {
      const row = context.db.prepare(`SELECT status,job_id FROM fixture_summary_authority WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, evidence.occurrenceId);
      if (row?.status === 'claimed' && row.job_id === null) return Object.freeze({ decision: 'certified_not_submitted', status: 'claimed' });
      if (row?.status !== 'dispatching' || row.job_id !== evidence.jobId) return Object.freeze({ decision: 'inspect_required', status: row?.status ?? 'missing' });
      const snapshot = f.kernel.readOwnedSnapshotWithinTransaction(context).snapshot;
      const job = snapshot.openRouterBatchLedger?.jobs?.find((item) => item.id === evidence.jobId);
      const linkRow = context.db.prepare(`SELECT occurrence_id,attempt_id,command_id,ticket_id,policy_id,policy_revision,policy_digest,
        job_id,custom_id,request_sha256,source_digest,source_version_digest,request_digest,created_at
        FROM background_paid_batch_links WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, evidence.occurrenceId);
      if (!job || job.kind !== 'period_summary' || job.status !== 'queued' || !job.batchId || job.requestSha256 !== evidence.requestSha256 || !linkRow) {
        return Object.freeze({ decision: 'inspect_required', status: job?.status ?? 'dispatching' });
      }
      const link = { occurrenceId: linkRow.occurrence_id, attemptId: linkRow.attempt_id, commandId: linkRow.command_id,
        ticketId: linkRow.ticket_id, policyId: linkRow.policy_id, policyRevision: linkRow.policy_revision, policyDigest: linkRow.policy_digest,
        jobId: linkRow.job_id, customId: linkRow.custom_id, requestSha256: linkRow.request_sha256, sourceDigest: linkRow.source_digest,
        ...(linkRow.source_version_digest === null ? {} : { sourceVersionDigest: linkRow.source_version_digest }),
        requestDigest: linkRow.request_digest, createdAt: linkRow.created_at };
      if (link.occurrenceId !== evidence.occurrenceId || link.attemptId !== evidence.attemptId || link.commandId !== evidence.commandId ||
          link.ticketId !== evidence.ticketId || link.policyId !== evidence.policyId || link.policyRevision !== evidence.policyRevision ||
          link.policyDigest !== evidence.policyDigest || link.jobId !== evidence.jobId || link.customId !== evidence.customId ||
          link.requestSha256 !== evidence.requestSha256 || link.sourceDigest !== evidence.occurrenceSourceDigest ||
          link.sourceVersionDigest !== (evidence.occurrenceSourceVersionDigest ?? undefined) ||
          link.requestDigest !== evidence.occurrenceRequestDigest || link.createdAt !== evidence.linkCreatedAt || job.batchId.length > 256 ||
          /[^A-Za-z0-9_-]/.test(job.batchId)) return Object.freeze({ decision: 'inspect_required', status: 'dispatching' });
      return Object.freeze({ decision: 'known_batch', batchId: job.batchId, status: job.status });
    },
  };
  return { policyId, occurrenceId, attemptId, capability, authority };
}

function makeController(f, store, posts, hooks = {}) {
  const batchClient = {
    async submit(_input, onBeforeDispatch, assertBeforeStart) {
      await hooks.beforeDispatchState?.();
      if (hooks.preDispatchError) throw hooks.preDispatchError;
      await onBeforeDispatch();
      await hooks.beforeFinalFence?.();
      try { assertBeforeStart(); }
      catch (error) { throw new OpenRouterBatchDispatchError('pre_dispatch', String(error?.message ?? error)); }
      await hooks.afterFinalFence?.();
      posts.count += 1;
      return Object.freeze({ batchId: `batch_${posts.count}`, status: 'validating', endpoint: '/v1/chat/completions',
        model: 'openai/gpt-6-luna', completionWindow: '24h', total: 1, completed: 0, failed: 0 });
    },
  };
  const unavailable = async () => 'unavailable';
  const controller = new AppControllerImpl({ store,
      crypto: { randomUUID, async sha256(value) { return createHash('sha256').update(value).digest('hex'); } },
    providers: {
      speech: { async transcribe() { throw new Error('unexpected speech provider'); }, async releaseUploadLease() {}, disposeMemory() {} },
      openAi: { async prepare() { throw new Error('unexpected model provider'); }, async analyze() { throw new Error('unexpected model provider'); },
        async generateReply() { throw new Error('unexpected model provider'); } },
    },
    integration: { openRouterBatchClient: batchClient, privacySession: { epoch: String(0), async assertCurrent() {} },
      reminderBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable, async listPending() { return []; },
        async schedule() {}, async cancel() {}, async cancelLegacy() {}, async installForegroundHandler() {} },
      mailAlertBackend: { platform: 'web', getPermission: unavailable, requestPermission: unavailable, async present() { return 'unavailable'; }, async cancel() { return 'unknown'; } },
      deviceCalendarBackend: { platform: 'web', getPermission: unavailable, requestFullPermission: unavailable, async listCalendars() { return []; },
        async getCalendar() { return undefined; }, async readEvents() { return []; }, async createApprovedEvent() { throw new Error('unsupported'); },
        async lookupRecord() { return undefined; } },
      async writeDocument() {}, async removeAudio() {}, async loadRecordingRecovery() { return { async pickAndStage() { return null; }, async inspect() { throw new Error('unsupported'); }, async remove() {} }; },
      bindRecordingRecovery(service) { return service; },
    },
  });
  return controller;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function makePaidHarness(f, hooks = {}) {
  const initial = await f.kernel.getOwnedSnapshot(f.sessionToken);
  const capture = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, {
    expectedPrivacyEpoch: 0, period: 'daily', timeZone: 'UTC', localPeriodStart: '2026-06-30', localDeliveryTime: '08:00',
    preparedAt: '2026-07-02T01:00:00.000Z', selection: { notes: true, chat: false, tasks: false, decisions: false,
      acceptedInferences: false, mailAccounts: [], calendarAccounts: [], documentPaths: [], knowledge: [] },
  });
  assert.equal(capture.outcome, 'ready');
  const authority = makeAuthorityFixture(f);
  const commandId = randomUUID();
  const admission = f.journal.admit({ admissionSessionToken: f.admissionSession, expectedRevision: initial.revision, expectedPrivacyEpoch: 0,
    idempotencyKey: commandId, kind: COMMAND_KIND, canonicalBody: '{}' });
  const lineageParticipant = f.lineage.createSnapshotCommitParticipant();
  let controller;
  const controllerPort = { submitPreparedPeriodSummary(input) { return controller.submitPreparedPeriodSummary(input); } };
  const paidWork = new PeriodSummaryPaidWork({ kernel: f.kernel, sessionToken: f.sessionToken, journal: f.journal,
    captureStore: f.captureStore, documentLineage: f.lineage, batchLinks: f.batchLinks, authority: authority.authority,
    controller: controllerPort });
  const paidParticipant = paidWork.createSnapshotCommitParticipant();
  const commitFault = hooks.failCommitForStatus ? { commit(_context, input) {
    const target = input.nextSnapshot.openRouterBatchLedger?.jobs?.find((item) => item.kind === 'period_summary');
    if (target?.status === hooks.failCommitForStatus) throw new Error(`injected_${hooks.failCommitForStatus}_commit_failure`);
  } } : undefined;
  const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.sessionToken, journal: f.journal,
    snapshotCommitParticipant: composeSnapshotCommitParticipants([
      { name: 'lineage', participant: lineageParticipant }, { name: 'period-summary-paid', participant: paidParticipant },
      ...(commitFault ? [{ name: 'period-summary-test-fault', participant: commitFault }] : []),
    ]) });
  const posts = { count: 0 };
  controller = makeController(f, store, posts, hooks);
  await controller.load();
  return { authority, capture, commandId, admission, paidWork, controller, posts,
    execute(captured = capture) { return paidWork.executeScheduledPeriodSummary({
      claim: { occurrenceId: authority.occurrenceId, attemptId: authority.attemptId, capability: authority.capability }, capture: captured,
    }); },
    run(captured = capture, ticket = admission.ticket, sessionToken = f.sessionToken) {
      return f.journal.run(ticket, sessionToken, () => paidWork.executeScheduledPeriodSummary({
        claim: { occurrenceId: authority.occurrenceId, attemptId: authority.attemptId, capability: authority.capability }, capture: captured,
      }));
    } };
}

test('real controller path atomically checkpoints preparation, dispatch, one fake POST, and durable link', async () => {
  const f = setup();
  try {
    const state = await f.kernel.getOwnedSnapshot(f.sessionToken);
    const capture = capturePeriodSummarySources(f.kernel, f.sessionToken, f.lineage, {
      expectedPrivacyEpoch: 0, period: 'daily', timeZone: 'UTC', localPeriodStart: '2026-06-30', localDeliveryTime: '08:00',
      preparedAt: '2026-07-02T01:00:00.000Z', selection: { notes: true, chat: false, tasks: false, decisions: false,
        acceptedInferences: false, mailAccounts: [], calendarAccounts: [], documentPaths: [], knowledge: [] },
    });
    assert.equal(capture.outcome, 'ready');
    const authority = makeAuthorityFixture(f);
    const commandId = randomUUID();
    const admission = f.journal.admit({ admissionSessionToken: f.admissionSession, expectedRevision: state.revision, expectedPrivacyEpoch: 0,
      idempotencyKey: commandId, kind: COMMAND_KIND, canonicalBody: '{}' });
    assert.equal(admission.fresh, true);
    const lineageParticipant = f.lineage.createSnapshotCommitParticipant();
    let controller;
    const controllerPort = { submitPreparedPeriodSummary(input) { return controller.submitPreparedPeriodSummary(input); } };
    const paidWork = new PeriodSummaryPaidWork({ kernel: f.kernel, sessionToken: f.sessionToken, journal: f.journal,
      captureStore: f.captureStore, documentLineage: f.lineage, batchLinks: f.batchLinks, authority: authority.authority,
      controller: controllerPort });
    const paidParticipant = paidWork.createSnapshotCommitParticipant();
    const store = new ServerWorkspaceStore({ kernel: f.kernel, sessionToken: f.sessionToken, journal: f.journal,
      snapshotCommitParticipant: composeSnapshotCommitParticipants([
        { name: 'lineage', participant: lineageParticipant }, { name: 'period-summary-paid', participant: paidParticipant },
      ]) });
    const posts = { count: 0 };
    controller = makeController(f, store, posts);
    await controller.load();
    const result = await f.journal.run(admission.ticket, f.sessionToken, () => paidWork.executeScheduledPeriodSummary({
      claim: { occurrenceId: authority.occurrenceId, attemptId: authority.attemptId, capability: authority.capability }, capture,
    }));
    assert.equal(posts.count, 1);
    assert.equal(result.status, 'queued');
    assert.equal(f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => f.captureStore.readPhaseWithinTransaction(context, result.id).phase), 'submitted');
    const persisted = f.kernel.getOwnedSnapshot(f.sessionToken).snapshot;
    const job = persisted.openRouterBatchLedger.jobs.find((item) => item.id === result.id);
    assert.equal(job.status, 'queued');
    assert.equal(job.summaryBinding.requestProfileVersion, 6);
    const link = f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => {
      const row = context.db.prepare(`SELECT occurrence_id,attempt_id,command_id,ticket_id,policy_id,policy_revision,policy_digest,
        job_id,custom_id,request_sha256,source_digest,source_version_digest,request_digest,created_at
        FROM background_paid_batch_links WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND job_id=?`)
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, result.id);
      assert.ok(row);
      const exact = { occurrenceId: row.occurrence_id, attemptId: row.attempt_id, commandId: row.command_id, ticketId: row.ticket_id,
        policyId: row.policy_id, policyRevision: row.policy_revision, policyDigest: row.policy_digest, jobId: row.job_id,
        customId: row.custom_id, requestSha256: row.request_sha256, sourceDigest: row.source_digest,
        ...(row.source_version_digest === null ? {} : { sourceVersionDigest: row.source_version_digest }),
        requestDigest: row.request_digest, createdAt: row.created_at };
      f.batchLinks.assertExistingLinkWithinTransaction(context, exact);
      return exact;
    });
    assert.equal(link.occurrenceId, authority.occurrenceId);
    assert.equal(link.attemptId, authority.attemptId);
    assert.equal(link.commandId, commandId);
    assert.equal(link.sourceDigest, 'c'.repeat(64));
    assert.equal(link.requestDigest, 'd'.repeat(64));
    const occurrence = f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => context.db.prepare(`SELECT status,job_id FROM fixture_summary_authority
      WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=?`)
      .get(context.workspaceId, context.ownerId, context.privacyEpoch, authority.occurrenceId));
    assert.deepEqual(occurrence, { status: 'dispatching', job_id: result.id });
  } finally { f.close(); }
});

test('capture authority is private and scheduled execution requires the exact live journal ticket', async () => {
  const f = setup();
  try {
    const h = await makePaidHarness(f);
    const serializedCapture = JSON.parse(JSON.stringify(h.capture));
    await assert.rejects(h.run(serializedCapture), /period_summary_capture_proof_invalid/);
    await assert.rejects(h.execute(), /scheduled_period_summary_ticket_invalid/);
    const current = await f.kernel.getOwnedSnapshot(f.sessionToken);
    const wrongKind = f.journal.admit({ admissionSessionToken: f.admissionSession, expectedRevision: current.revision, expectedPrivacyEpoch: 0,
      idempotencyKey: randomUUID(), kind: 'assistant.periodsummary.application.prepare', canonicalBody: '{}' });
    await assert.rejects(h.run(h.capture, wrongKind.ticket), /scheduled_period_summary_ticket_invalid/);

    const foreignOwner = randomUUID();
    const foreignWorkspace = f.kernel.createWorkspace(foreignOwner, createInitialWorkspaceState(randomUUID, { mode: 'provider',
      llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch' }));
    const foreignSession = f.kernel.createSession(foreignWorkspace.workspaceId, foreignOwner, Date.now() + 60 * 60_000);
    const foreignAdmissionSession = f.kernel.createSession(foreignWorkspace.workspaceId, foreignOwner, Date.now() + 60 * 60_000);
    const foreignRevision = (await f.kernel.getOwnedSnapshot(foreignSession)).revision;
    const foreignTicket = f.journal.admit({ admissionSessionToken: foreignAdmissionSession, expectedRevision: foreignRevision,
      expectedPrivacyEpoch: 0, idempotencyKey: randomUUID(), kind: COMMAND_KIND, canonicalBody: '{}' });
    await assert.rejects(h.run(h.capture, foreignTicket.ticket, foreignSession), /scheduled_period_summary_session_invalid/);
    assert.equal(h.posts.count, 0);
    assert.equal(f.kernel.getOwnedSnapshot(f.sessionToken).snapshot.openRouterBatchLedger.jobs.some((job) => job.kind === 'period_summary'), false);
    const evidenceCount = f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => context.db.prepare(
      'SELECT COUNT(*) AS count FROM period_summary_capture_evidence WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?')
      .get(context.workspaceId, context.ownerId, context.privacyEpoch).count);
    assert.equal(evidenceCount, 0);
  } finally { f.close(); }
});

test('preparing and submitting participant failures roll back snapshot, evidence, claim, and paid link together', async () => {
  for (const failCommitForStatus of ['preparing', 'submitting']) {
    const f = setup();
    try {
      const h = await makePaidHarness(f, { failCommitForStatus });
      await assert.rejects(h.run(), new RegExp(`injected_${failCommitForStatus}_commit_failure`));
      assert.equal(h.posts.count, 0);
      const snapshot = f.kernel.getOwnedSnapshot(f.sessionToken).snapshot;
      const job = snapshot.openRouterBatchLedger?.jobs?.find((item) => item.kind === 'period_summary');
      assert.equal(job?.status, failCommitForStatus === 'preparing' ? undefined : 'preparing');
      const evidenceCount = f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => context.db.prepare(
        'SELECT COUNT(*) AS count FROM period_summary_capture_evidence WHERE workspace_id=? AND owner_id=? AND privacy_epoch=?')
        .get(context.workspaceId, context.ownerId, context.privacyEpoch).count);
      assert.equal(evidenceCount, failCommitForStatus === 'preparing' ? 0 : 1);
      const occurrence = f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => context.db.prepare(
        'SELECT status,job_id FROM fixture_summary_authority WHERE workspace_id=? AND owner_id=? AND privacy_epoch=? AND occurrence_id=?')
        .get(context.workspaceId, context.ownerId, context.privacyEpoch, h.authority.occurrenceId));
      assert.deepEqual(occurrence, { status: 'claimed', job_id: null });
      const links = countPaidLinks(f);
      assert.equal(links, 0);
    } finally { f.close(); }
  }
});

test('thenable authority adapters cannot create an unauthorized summary link or dispatch', async () => {
  for (const method of ['prepareWithinTransaction', 'beginSubmissionWithinTransaction', 'assertBeforePostWithinTransaction']) {
    const f = setup();
    try {
      const h = await makePaidHarness(f);
      const original = h.authority.authority[method];
      h.authority.authority[method] = async (...args) => original(...args);
      await assert.rejects(h.run(), /period_summary_authority_must_be_synchronous/);
      assert.equal(h.posts.count, 0);
      const links = countPaidLinks(f);
      assert.equal(links, method === 'assertBeforePostWithinTransaction' ? 1 : 0);
      const job = f.kernel.getOwnedSnapshot(f.sessionToken).snapshot.openRouterBatchLedger?.jobs?.find((item) => item.kind === 'period_summary');
      if (method === 'prepareWithinTransaction') assert.equal(job, undefined);
      if (method === 'beginSubmissionWithinTransaction') assert.equal(job?.status, 'preparing');
      if (method === 'assertBeforePostWithinTransaction') assert.equal(job?.status, 'failed');
    } finally { f.close(); }
  }
});

test('missing credential durably moves the prepared summary to not-submitted without a provider call', async () => {
  const f = setup();
  try {
    const h = await makePaidHarness(f, { preDispatchError: new OpenRouterBatchDispatchError('pre_dispatch', 'Configure an API key.') });
    await assert.rejects(h.run(), /Configure an API key/);
    assert.equal(h.posts.count, 0);
    const snapshot = f.kernel.getOwnedSnapshot(f.sessionToken).snapshot;
    const job = snapshot.openRouterBatchLedger.jobs.find((item) => item.kind === 'period_summary');
    assert.equal(job.status, 'failed');
    assert.equal(job.failureCode, 'not_submitted');
    assert.equal(f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => f.captureStore.readPhaseWithinTransaction(context, job.id).phase), 'not_submitted');
  } finally { f.close(); }
});

test('source changes before the final pre-POST fence fail closed and are durably marked not-submitted', async () => {
  const f = setup();
  const reached = deferred(); const continueFence = deferred();
  try {
    const h = await makePaidHarness(f, { beforeFinalFence: async () => { reached.resolve(); await continueFence.promise; } });
    const submission = h.run();
    await reached.promise;
    await h.controller.updateTranscript(f.noteId, 'The note changed before provider dispatch.', { expectedRevision: 1 });
    continueFence.resolve();
    await assert.rejects(submission, (error) => error instanceof OpenRouterBatchDispatchError && error.phase === 'pre_dispatch');
    assert.equal(h.posts.count, 0);
    const job = f.kernel.getOwnedSnapshot(f.sessionToken).snapshot.openRouterBatchLedger.jobs.find((item) => item.kind === 'period_summary');
    assert.equal(job.status, 'failed');
    assert.equal(job.failureCode, 'not_submitted');
    assert.equal(f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => f.captureStore.readPhaseWithinTransaction(context, job.id).phase), 'not_submitted');
  } finally { continueFence.resolve(); f.close(); }
});

test('summary dispatch cannot settle a job after its workspace lifecycle becomes stale', async () => {
  const f = setup();
  let controller;
  try {
    const h = await makePaidHarness(f, { beforeFinalFence: async () => { controller.loaded = false; } });
    controller = h.controller;
    await assert.rejects(h.run(), (error) => error instanceof OpenRouterBatchDispatchError && error.phase === 'pre_dispatch');
    assert.equal(h.posts.count, 0);
    const job = f.kernel.getOwnedSnapshot(f.sessionToken).snapshot.openRouterBatchLedger.jobs.find((item) => item.kind === 'period_summary');
    assert.equal(job.status, 'submitting', 'stale lifecycle keeps an uncertain request inspectable');
    assert.equal(job.failureCode, undefined);
    assert.equal(f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => f.captureStore.readPhaseWithinTransaction(context, job.id).phase), 'submitting');
  } finally { f.close(); }
});

test('an untyped transport failure is never converted into certified not-submitted', async () => {
  const f = setup();
  try {
    const h = await makePaidHarness(f, { afterFinalFence: async () => { throw new Error('transport outcome unavailable'); } });
    await assert.rejects(h.run(), /transport outcome unavailable/);
    assert.equal(h.posts.count, 0);
    const job = f.kernel.getOwnedSnapshot(f.sessionToken).snapshot.openRouterBatchLedger.jobs.find((item) => item.kind === 'period_summary');
    assert.equal(job.status, 'submitting');
    assert.equal(job.failureCode, undefined);
    assert.equal(f.kernel.withOwnedTransaction(f.sessionToken, 0, (context) => f.captureStore.readPhaseWithinTransaction(context, job.id).phase), 'submitting');
  } finally { f.close(); }
});

test('an acknowledged provider batch survives a source edit made after the final fence; recovery accepts opaque batch IDs', async () => {
  const f = setup();
  const reached = deferred(); const returnAck = deferred();
  try {
    const h = await makePaidHarness(f, { afterFinalFence: async () => { reached.resolve(); await returnAck.promise; } });
    const submission = h.run();
    await reached.promise;
    await h.controller.updateTranscript(f.noteId, 'The note changed while the provider request was in flight.', { expectedRevision: 1 });
    returnAck.resolve();
    const result = await submission;
    assert.equal(result.status, 'queued');
    assert.equal(h.posts.count, 1);
    const job = f.kernel.getOwnedSnapshot(f.sessionToken).snapshot.openRouterBatchLedger.jobs.find((item) => item.id === result.id);
    assert.equal(job.batchId, 'batch_1');
    const recovery = new PeriodSummaryRecovery({ kernel: f.kernel, sessionToken: f.sessionToken,
      captureStore: f.captureStore, batchLinks: f.batchLinks, authority: { ...h.authority.authority,
        readRecoveryWithinTransaction() { return Object.freeze({ decision: 'known_batch', batchId: 'batch_1', status: 'queued' }); } } });
    assert.deepEqual(recovery.classify(job.id), { decision: 'known_batch', jobId: job.id, batchId: 'batch_1', status: 'queued' });
    const retainedEvidenceWinsOverNonconflictingInspect = new PeriodSummaryRecovery({ kernel: f.kernel, sessionToken: f.sessionToken,
      captureStore: f.captureStore, batchLinks: f.batchLinks, authority: { ...h.authority.authority,
        readRecoveryWithinTransaction() { return Object.freeze({ decision: 'inspect_required', status: 'dispatching' }); } } });
    assert.deepEqual(retainedEvidenceWinsOverNonconflictingInspect.classify(job.id),
      { decision: 'known_batch', jobId: job.id, batchId: 'batch_1', status: 'queued' });
    const disagreement = new PeriodSummaryRecovery({ kernel: f.kernel, sessionToken: f.sessionToken,
      captureStore: f.captureStore, batchLinks: f.batchLinks, authority: { ...h.authority.authority,
        readRecoveryWithinTransaction() { return Object.freeze({ decision: 'known_batch', batchId: 'different_batch', status: 'queued' }); } } });
    assert.equal(disagreement.classify(job.id).decision, 'inspect_required');
    const notSubmittedClaim = new PeriodSummaryRecovery({ kernel: f.kernel, sessionToken: f.sessionToken,
      captureStore: f.captureStore, batchLinks: f.batchLinks, authority: { ...h.authority.authority,
        readRecoveryWithinTransaction() { return Object.freeze({ decision: 'certified_not_submitted' }); } } });
    assert.equal(notSubmittedClaim.classify(job.id).decision, 'inspect_required');
    f.kernel.withTrustedDatabaseTransaction((db) => {
      const row = db.prepare('SELECT snapshot_json FROM workspaces WHERE id=?').get(f.workspace.workspaceId);
      const snapshot = JSON.parse(row.snapshot_json);
      const persistedJob = snapshot.openRouterBatchLedger.jobs.find((item) => item.id === job.id);
      const request = JSON.parse(persistedJob.requestBody);
      request.messages[0].content = `${request.messages[0].content} tampered`;
      persistedJob.requestBody = canonicalBackgroundJson(request);
      db.prepare('UPDATE workspaces SET snapshot_json=? WHERE id=?').run(canonicalBackgroundJson(snapshot), f.workspace.workspaceId);
    });
    assert.throws(() => recovery.classify(job.id), /period_summary_recovery_job_evidence_mismatch/);
    assert.equal(h.posts.count, 1, 'restart classification must never submit another request');
    f.kernel.withTrustedDatabaseTransaction((db) => {
      const row = db.prepare('SELECT snapshot_json FROM workspaces WHERE id=?').get(f.workspace.workspaceId);
      const snapshot = JSON.parse(row.snapshot_json);
      snapshot.openRouterBatchLedger.jobs = snapshot.openRouterBatchLedger.jobs.filter((item) => item.id !== job.id);
      db.prepare('UPDATE workspaces SET snapshot_json=? WHERE id=?').run(canonicalBackgroundJson(snapshot), f.workspace.workspaceId);
    });
    assert.equal(recovery.classify(job.id).decision, 'inspect_required');
  } finally { returnAck.resolve(); f.close(); }
});

test('recovery requires a present preparing job and affirmative no-submit authority', async () => {
  const f = setup();
  const reached = deferred(); const continueDispatch = deferred();
  try {
    const h = await makePaidHarness(f, { beforeDispatchState: async () => { reached.resolve(); await continueDispatch.promise; } });
    const submission = h.run();
    await reached.promise;
    const recovery = new PeriodSummaryRecovery({ kernel: f.kernel, sessionToken: f.sessionToken,
      captureStore: f.captureStore, batchLinks: f.batchLinks, authority: h.authority.authority });
    const job = f.kernel.getOwnedSnapshot(f.sessionToken).snapshot.openRouterBatchLedger.jobs.find((item) => item.kind === 'period_summary');
    assert.equal(recovery.classify(job.id).decision, 'certified_not_submitted');
    const absentJob = new PeriodSummaryRecovery({ kernel: f.kernel, sessionToken: f.sessionToken,
      captureStore: f.captureStore, batchLinks: f.batchLinks, authority: { ...h.authority.authority,
        readRecoveryWithinTransaction() { return Object.freeze({ decision: 'inspect_required' }); } } });
    f.kernel.withTrustedDatabaseTransaction((db) => {
      const row = db.prepare('SELECT snapshot_json FROM workspaces WHERE id=?').get(f.workspace.workspaceId);
      const snapshot = JSON.parse(row.snapshot_json);
      snapshot.openRouterBatchLedger.jobs = snapshot.openRouterBatchLedger.jobs.filter((item) => item.id !== job.id);
      db.prepare('UPDATE workspaces SET snapshot_json=? WHERE id=?').run(canonicalBackgroundJson(snapshot), f.workspace.workspaceId);
    });
    assert.equal(absentJob.classify(job.id).decision, 'inspect_required');
    continueDispatch.resolve();
    await assert.rejects(submission);
  } finally { continueDispatch.resolve(); f.close(); }
});
