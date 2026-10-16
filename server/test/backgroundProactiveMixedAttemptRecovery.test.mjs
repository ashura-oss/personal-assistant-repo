import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Buffer } from 'node:buffer';

const preparingWorker = join(process.cwd(), 'test', 'fixtures', 'proactivePreparingJobCrashWorker.mjs');
const paidClaimWorker = join(process.cwd(), 'test', 'fixtures', 'proactivePaidClaimCrashWorker.mjs');
const resumeCrashWorker = join(process.cwd(), 'test', 'fixtures', 'proactiveResumeCrashWorker.mjs');
const resumeWorker = join(process.cwd(), 'test', 'fixtures', 'proactiveResumeWorker.mjs');

function fixtureDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'still-proactive-mixed-recovery-'));
  const publicRoot = join(directory, 'public');
  mkdirSync(join(publicRoot, 'assets'), { recursive: true });
  writeFileSync(join(publicRoot, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>');
  writeFileSync(join(publicRoot, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(publicRoot, 'sw.js'), '');
  writeFileSync(join(publicRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  return directory;
}

function runNode(entry, args, expectedExit, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`${label} timed out`)); }, 30_000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== expectedExit || signal !== null) return reject(new Error(`${label} exited ${code}/${signal}: ${stderr}`));
      resolve({ stdout, stderr });
    });
  });
}

test('a newer mapped no-job recovery wins over an older certified preparing job', async () => {
  const directory = fixtureDirectory();
  try {
    await runNode(preparingWorker, [directory], 73, 'first preparing crash');
    const newer = await runNode(resumeCrashWorker, [directory, 'paid_claim', '61000'], 73, 'newer mapped no-job crash');
    const evidence = JSON.parse(newer.stdout.trim());
    assert.equal(evidence.preflight.status, 'reading');
    assert.ok(evidence.preflight.paid_attempt_id);
    assert.equal(evidence.journalPresent, false);
    assert.equal(evidence.linkPresent, false);
    assert.equal(evidence.matchingJob, false);

    await runNode(resumeWorker, [directory, '61000'], 0, 'final recovery with newer no-job proof');
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a newer certified preparing recovery wins over an older mapped no-job attempt', async () => {
  const directory = fixtureDirectory();
  try {
    await runNode(paidClaimWorker, [directory], 73, 'first mapped no-job crash');
    const newer = await runNode(resumeCrashWorker, [directory, 'preparing', '61000'], 73, 'newer certified preparing crash');
    const evidence = JSON.parse(newer.stdout.trim());
    assert.equal(evidence.recoveryEvidence.job.status, 'preparing');
    assert.equal(evidence.recoveryEvidence.preflight.status, 'reading');
    assert.ok(evidence.recoveryEvidence.journal.checkpoint_revision);

    await runNode(resumeWorker, [directory, '61000'], 0, 'final recovery with newer certificate');
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a certified preparing recovery cannot POST after the current selected mail body changes', async () => {
  const directory = fixtureDirectory();
  try {
    await runNode(preparingWorker, [directory], 73, 'preparing crash before source change');
    await runNode(resumeWorker, [directory, '61000', 'changed_body'], 0, 'source change during certified recovery');
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a newer linked submission-unknown attempt fences an older certified preparing attempt after restart', async () => {
  const directory = fixtureDirectory();
  try {
    await runNode(preparingWorker, [directory], 73, 'older certified preparing crash');
    const newer = await runNode(resumeCrashWorker, [directory, 'submission_unknown', '61000'], 73,
      'newer linked submission-unknown crash');
    const evidence = JSON.parse(newer.stdout.trim());
    assert.equal(evidence.recoveryEvidence.job.status, 'submission_unknown');
    assert.ok(evidence.recoveryEvidence.preflight.paid_attempt_id);
    assert.equal(evidence.recoveryEvidence.journal.status, 'checkpointed');

    await runNode(resumeWorker, [directory, '61000', 'no_post'], 0, 'restart with newer ambiguous paid admission');
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
