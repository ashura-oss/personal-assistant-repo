import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundationInternal } from '../dist/bootstrap.js';
import { ProcessWorkspaceActors } from '../dist/runtimeActors.js';
import { createInitialWorkspaceState } from '../dist/sharedControllerNode.mjs';
import { createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';

const worker = join(process.cwd(), 'test', 'fixtures', 'proactivePreparingJobCrashWorker.mjs');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'still-proactive-recovery-boundary-'));
  const staticRoot = join(directory, 'public');
  mkdirSync(join(staticRoot, 'assets'), { recursive: true });
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>');
  writeFileSync(join(staticRoot, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(staticRoot, 'sw.js'), '');
  writeFileSync(join(staticRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  const config = loadServerConfig({ STILL_ORIGIN: 'http://127.0.0.1:3000', STILL_DATA_DIR: join(directory, 'private', 'data'),
    STILL_VAULT_KEY_FILE: join(directory, 'private', 'keys', 'root.key'), STILL_GOOGLE_CLIENT_ID: 'paid-reply-client',
    STILL_GOOGLE_CLIENT_SECRET: 'test-only-synthetic-google-secret' }, { staticRoot, allowLocalHttp: true });
  return { directory, config };
}

async function crash(state, status, lostAck = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, state.directory, status, String(lostAck)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`recovery child timed out at ${status}`)); }, 20_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 73 || signal !== null) return reject(new Error(`recovery child exited ${code}/${signal}: ${stderr}`));
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error(`recovery child receipt invalid: ${stderr}`)); }
    });
  });
}

function recoveryHook(state, opened, fetcher) {
  const hook = createProductionApplicationRuntimeFactory(state.config, { fetcher }).recoverProactivePreflights;
  assert.equal(typeof hook, 'function');
  hook({ kernel: opened.privateContext.kernel, startupCapability: opened.privateContext.startup.capability });
}

function replaceCertificateSchemaWithV1(db, { corrupt = false } = {}) {
  const prior = db.prepare('SELECT * FROM background_proactive_not_submitted_certificates ORDER BY created_at LIMIT 1').get();
  assert.ok(prior, 'fixture must contain a real v2 certificate row to preserve');
  db.exec(`DROP TRIGGER background_proactive_not_submitted_no_update;
    DROP TRIGGER background_proactive_not_submitted_erase_only;
    CREATE TABLE background_proactive_not_submitted_certificates_v1 (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
      job_id TEXT NOT NULL CHECK(length(job_id)=36), custom_id TEXT NOT NULL CHECK(custom_id=job_id),
      request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64), marker_sha256 TEXT NOT NULL CHECK(length(marker_sha256)=64),
      job_projection_sha256 TEXT NOT NULL CHECK(length(job_projection_sha256)=64),
      preflight_attempt_id TEXT NOT NULL CHECK(length(preflight_attempt_id)=36),
      occurrence_id TEXT NOT NULL CHECK(length(occurrence_id)=36), paid_attempt_id TEXT NOT NULL CHECK(length(paid_attempt_id)=36),
      command_id TEXT NOT NULL CHECK(command_id=paid_attempt_id), created_at INTEGER NOT NULL CHECK(created_at>=0),
      PRIMARY KEY(workspace_id,owner_id,privacy_epoch,job_id),
      UNIQUE(workspace_id,owner_id,privacy_epoch,preflight_attempt_id),
      UNIQUE(workspace_id,owner_id,privacy_epoch,paid_attempt_id)
    ) STRICT;
    CREATE TABLE background_proactive_recovery_schema_v1 (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL CHECK(version=1)
    ) STRICT;
    INSERT INTO background_proactive_recovery_schema_v1(singleton,version) VALUES(1,1);`);
  db.prepare(`INSERT INTO background_proactive_not_submitted_certificates_v1(
    workspace_id,owner_id,privacy_epoch,job_id,custom_id,request_sha256,marker_sha256,job_projection_sha256,
    preflight_attempt_id,occurrence_id,paid_attempt_id,command_id,created_at)
    VALUES(@workspace_id,@owner_id,@privacy_epoch,@job_id,@custom_id,@request_sha256,@marker_sha256,@job_projection_sha256,
    @preflight_attempt_id,@occurrence_id,@paid_attempt_id,@command_id,@created_at)`).run(prior);
  if (corrupt) {
    db.exec(`DROP TABLE background_proactive_not_submitted_certificates_v1;
      CREATE TABLE background_proactive_not_submitted_certificates_v1 (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL, privacy_epoch INTEGER NOT NULL CHECK(privacy_epoch>=0),
        job_id TEXT NOT NULL CHECK(length(job_id)=36), custom_id TEXT NOT NULL CHECK(custom_id=job_id),
        request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64), marker_sha256 TEXT NOT NULL CHECK(length(marker_sha256)=64),
        job_projection_sha256 TEXT NOT NULL CHECK(length(job_projection_sha256)=64),
        preflight_attempt_id TEXT NOT NULL CHECK(length(preflight_attempt_id)=36),
        occurrence_id TEXT NOT NULL CHECK(length(occurrence_id)=36), paid_attempt_id TEXT NOT NULL CHECK(length(paid_attempt_id)=36),
        command_id TEXT NOT NULL CHECK(command_id=paid_attempt_id), created_at INTEGER NOT NULL CHECK(created_at>=0),
        PRIMARY KEY(workspace_id,owner_id,privacy_epoch,job_id)
      ) STRICT;`);
    db.prepare(`INSERT INTO background_proactive_not_submitted_certificates_v1(
      workspace_id,owner_id,privacy_epoch,job_id,custom_id,request_sha256,marker_sha256,job_projection_sha256,
      preflight_attempt_id,occurrence_id,paid_attempt_id,command_id,created_at)
      VALUES(@workspace_id,@owner_id,@privacy_epoch,@job_id,@custom_id,@request_sha256,@marker_sha256,@job_projection_sha256,
      @preflight_attempt_id,@occurrence_id,@paid_attempt_id,@command_id,@created_at)`).run(prior);
  }
  db.exec(`DROP TABLE background_proactive_not_submitted_certificates;
    ALTER TABLE background_proactive_not_submitted_certificates_v1 RENAME TO background_proactive_not_submitted_certificates;
    DROP TABLE background_proactive_recovery_schema;
    ALTER TABLE background_proactive_recovery_schema_v1 RENAME TO background_proactive_recovery_schema;
    CREATE TRIGGER background_proactive_not_submitted_no_update BEFORE UPDATE ON background_proactive_not_submitted_certificates
      BEGIN SELECT RAISE(ABORT,'proactive_recovery_certificate_immutable'); END;
    CREATE TRIGGER background_proactive_not_submitted_erase_only BEFORE DELETE ON background_proactive_not_submitted_certificates
      WHEN still_workspace_erase_authorized(OLD.workspace_id,OLD.owner_id,OLD.privacy_epoch) IS NOT 1
      BEGIN SELECT RAISE(ABORT,'proactive_recovery_certificate_retained'); END;`);
  return prior;
}

test('certificate schema migrates authentic v1 rows transactionally to strict v2 cold proofs', async (t) => {
  for (const corrupt of [false, true]) {
    await t.test(corrupt ? 'bad legacy shape rolls back' : 'valid legacy row is preserved', async () => {
      const state = fixture();
      let opened;
      let legacyRow;
      try {
        const child = await crash(state, 'preparing');
        opened = openServerFoundationInternal(state.config);
        opened.privateContext.startup.beginRecovery();
        recoveryHook(state, opened, async () => { throw new Error('provider access is closed in this fixture'); });
        opened.privateContext.kernel.withColdStartDatabaseTransaction(opened.privateContext.startup.capability, (db) => {
          legacyRow = replaceCertificateSchemaWithV1(db, { corrupt });
        });
        opened.privateContext.startup.seal();
        opened.foundation.close();
        opened = openServerFoundationInternal(state.config);
        opened.privateContext.startup.beginRecovery();
        const migrate = () => recoveryHook(state, opened, async () => { throw new Error('provider access is closed in this fixture'); });
        if (corrupt) {
          assert.throws(migrate, /background_proactive_recovery_schema_invalid/);
          const retained = opened.privateContext.kernel.withColdStartDatabaseTransaction(opened.privateContext.startup.capability, (db) => ({
            version: db.prepare('SELECT version FROM background_proactive_recovery_schema WHERE singleton=1').get().version,
            columns: db.pragma('table_info(background_proactive_not_submitted_certificates)').map((column) => column.name),
          }));
          assert.equal(retained.version, 1);
          assert.equal(retained.columns.length, 13);
        } else {
          migrate();
          const migrated = opened.privateContext.kernel.withColdStartDatabaseTransaction(opened.privateContext.startup.capability, (db) => ({
            version: db.prepare('SELECT version FROM background_proactive_recovery_schema WHERE singleton=1').get().version,
            columns: db.pragma('table_info(background_proactive_not_submitted_certificates)').map((column) => column.name),
            certificate: db.prepare(`SELECT proof_kind,ticket_id,job_id,custom_id,request_sha256,marker_sha256,job_projection_sha256,
              preflight_attempt_id,occurrence_id,paid_attempt_id,command_id FROM background_proactive_not_submitted_certificates
              WHERE workspace_id=? AND owner_id=? AND privacy_epoch=0`).get(child.workspaceId, child.ownerId),
            strict: db.prepare("SELECT strict FROM pragma_table_list WHERE name='background_proactive_not_submitted_certificates'").get().strict,
          }));
          assert.equal(migrated.version, 2);
          assert.deepEqual(migrated.columns, ['workspace_id','owner_id','privacy_epoch','job_id','custom_id','request_sha256','marker_sha256',
            'job_projection_sha256','proof_kind','ticket_id','preflight_attempt_id','occurrence_id','paid_attempt_id','command_id','created_at']);
          assert.equal(migrated.strict, 1);
          assert.equal(migrated.certificate.proof_kind, 'cold_checkpoint');
          assert.equal(migrated.certificate.ticket_id, null);
          assert.equal(migrated.certificate.job_id, migrated.certificate.custom_id);
          for (const key of ['job_id','custom_id','request_sha256','marker_sha256','job_projection_sha256','preflight_attempt_id',
            'occurrence_id','paid_attempt_id','command_id']) assert.equal(migrated.certificate[key], legacyRow[key], `preserved ${key}`);
        }
      } finally {
        if (opened) {
          try { opened.privateContext.startup.seal(); } catch {}
          opened.foundation.close();
        }
        rmSync(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }
});

test('cold recovery rejects a checkpoint whose revision or raw snapshot digest no longer matches', async (t) => {
  for (const field of ['checkpoint_revision', 'snapshot_digest']) {
    await t.test(field, async () => {
      const state = fixture();
      let opened;
      try {
        const child = await crash(state, 'preparing');
        opened = openServerFoundationInternal(state.config);
        opened.privateContext.startup.beginRecovery();
        opened.privateContext.kernel.withColdStartDatabaseTransaction(opened.privateContext.startup.capability, (db) => {
          if (field === 'checkpoint_revision') {
            db.prepare(`UPDATE async_command_journal SET checkpoint_revision=checkpoint_revision+1 WHERE workspace_id=? AND idempotency_key=?`)
              .run(child.workspaceId, child.recoveryEvidence.journal.idempotency_key);
          } else {
            db.prepare(`UPDATE async_command_journal SET snapshot_digest=? WHERE workspace_id=? AND idempotency_key=?`)
              .run('0'.repeat(64), child.workspaceId, child.recoveryEvidence.journal.idempotency_key);
          }
        });
        assert.throws(() => recoveryHook(state, opened, async () => { throw new Error('provider fetch forbidden during recovery'); }),
          /proactive_preflight_journal_not_predispatch/);
        const retained = opened.privateContext.kernel.withColdStartDatabaseTransaction(opened.privateContext.startup.capability, (db) => ({
          certificateCount: db.prepare(`SELECT count(*) AS count FROM background_proactive_not_submitted_certificates
            WHERE workspace_id=? AND owner_id=?`).get(child.workspaceId, child.ownerId).count,
          preflight: db.prepare(`SELECT status FROM background_proactive_preflight_attempts WHERE attempt_id=?`).get(child.recoveryEvidence.preflight.attempt_id),
          journal: db.prepare(`SELECT status,checkpoint_revision,snapshot_digest FROM async_command_journal WHERE workspace_id=? AND idempotency_key=?`)
            .get(child.workspaceId, child.recoveryEvidence.journal.idempotency_key),
        }));
        assert.equal(retained.certificateCount, 0);
        assert.equal(retained.preflight.status, 'reading');
        assert.equal(retained.journal.status, 'checkpointed');
        if (field === 'checkpoint_revision') assert.equal(retained.journal.checkpoint_revision, child.recoveryEvidence.journal.checkpoint_revision + 1);
        else assert.equal(retained.journal.snapshot_digest, '0'.repeat(64));
      } finally {
        if (opened) {
          try { opened.privateContext.startup.seal(); } catch {}
          opened.foundation.close();
        }
        rmSync(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }
});

test('a restarted host never POSTs again for submitting or submission-unknown linked work', async (t) => {
  for (const mode of [{ status: 'submitting', lostAck: false }, { status: 'submission_unknown', lostAck: true }]) {
    await t.test(mode.status, async () => {
      const state = fixture();
      let opened;
      let actors;
      let runtime;
      let posts = 0;
      try {
        const child = await crash(state, mode.status, mode.lostAck);
        assert.equal(child.recoveryEvidence.job.status, mode.status);
        opened = openServerFoundationInternal(state.config);
        opened.privateContext.startup.beginRecovery();
        recoveryHook(state, opened, async () => { throw new Error('provider fetch forbidden during recovery hook'); });
        const recovered = opened.privateContext.kernel.withColdStartDatabaseTransaction(opened.privateContext.startup.capability, (db) => ({
          preflight: db.prepare(`SELECT status,result_code FROM background_proactive_preflight_attempts WHERE attempt_id=?`)
            .get(child.recoveryEvidence.preflight.attempt_id),
          certificateCount: db.prepare(`SELECT count(*) AS count FROM background_proactive_not_submitted_certificates
            WHERE workspace_id=? AND owner_id=?`).get(child.workspaceId, child.ownerId).count,
          job: JSON.parse(db.prepare('SELECT snapshot_json FROM workspaces WHERE id=?').get(child.workspaceId).snapshot_json)
            .openRouterBatchLedger.jobs.find((entry) => entry.kind === 'mail_reply'),
        }));
        assert.equal(recovered.preflight.status, 'complete');
        assert.equal(recovered.preflight.result_code, 'paid_checkpoint_committed');
        assert.equal(recovered.certificateCount, 0);
        assert.equal(recovered.job.status, mode.status);

        opened.privateContext.startup.seal();
        actors = new ProcessWorkspaceActors(opened.privateContext.kernel);
        runtime = await createProductionApplicationRuntimeFactory(state.config, { fetcher: async (input, init = {}) => {
          if (init.method === 'POST') posts += 1;
          throw new Error(`unexpected recovery provider request ${init.method ?? 'GET'} ${new URL(String(input)).pathname}`);
        } })({ kernel: opened.privateContext.kernel, vault: opened.privateContext.vault, auth: opened.foundation.auth,
          runtimeSessionFor: (identity) => actors.sessionForRegistry(identity),
          listWorkspaceMetadataPage: (afterWorkspaceId, limit) => actors.listWorkspaceMetadataPage(afterWorkspaceId, limit),
          processInstanceId: opened.privateContext.processInstanceId,
          createEmptyWorkspaceSnapshot: () => createInitialWorkspaceState(),
        });
        const deadline = performance.now() + 1_500;
        while (performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(posts, 0, 'ambiguous or in-flight paid submission must never be replayed after restart');
      } finally {
        if (runtime) { runtime.stopAdmission(); await runtime.drainAndDispose(); }
        if (actors) await actors.closeAfterDrain(async () => {});
        if (opened) {
          try { opened.privateContext.startup.seal(); } catch {}
          opened.foundation.close();
        }
        rmSync(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }
});
