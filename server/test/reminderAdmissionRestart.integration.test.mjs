import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const within = async (promise, label, timeoutMs = 30_000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
};
const waitFor = async (predicate, label, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(label);
};
function child(script, args) {
  const childProcess = spawn(globalThis.process.execPath, [script, ...args], { cwd: globalThis.process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  childProcess.stdout.setEncoding('utf8').on('data', (value) => { stdout += value; });
  childProcess.stderr.setEncoding('utf8').on('data', (value) => { stderr += value; });
  return { process: childProcess, output: () => ({ stdout, stderr }) };
}
function exited(childProcess, timeoutMs = 30_000) {
  return within(new Promise((resolve, reject) => {
    childProcess.once('error', reject);
    childProcess.once('exit', (code, signal) => resolve({ code, signal }));
  }), 'reminder_crash_child_exit_timeout', timeoutMs);
}

test('fresh production runtime never resends a reminder after another process committed dispatch admission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-reminder-admission-restart-'));
  const databasePath = join(directory, 'private', 'workspace.sqlite');
  const worker = fileURLToPath(new URL('./fixtures/reminderAdmissionCrashWorker.mjs', import.meta.url));
  const authSecret = randomBytes(32).toString('hex');
  const vaultKey = randomBytes(32).toString('hex');
  const admittedPath = join(directory, 'admitted.json');
  const secondSendPath = join(directory, 'second-send.json');
  const reportPath = join(directory, 'report.json');
  let first;
  let restarted;
  try {
    first = child(worker, ['create', databasePath, authSecret, vaultKey, admittedPath, secondSendPath, reportPath]);
    await waitFor(() => existsSync(admittedPath), 'reminder_dispatch_admission_not_committed');
    assert.deepEqual(JSON.parse(readFileSync(admittedPath, 'utf8')), { sends: 1, admitted: true });
    first.process.kill();
    await exited(first.process);

    restarted = child(worker, ['restart', databasePath, authSecret, vaultKey, admittedPath, secondSendPath, reportPath]);
    const result = await exited(restarted.process, 30_000);
    assert.equal(result.code, 0, restarted.output().stderr || restarted.output().stdout);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.sends, 0, 'startup recovery and the existing timer do not create another transport send');
    assert.equal(report.secondSendObserved, false);
    assert.ok(report.state.attempt, 'the admitted attempt remains available for recovery inspection');
    assert.ok(['dispatching', 'inspect_required'].includes(report.state.attempt.status));
    assert.notEqual(report.state.occurrence, 'scheduled');
  } finally {
    if (first?.process.exitCode === null) first.process.kill();
    if (restarted?.process.exitCode === null) restarted.process.kill();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
