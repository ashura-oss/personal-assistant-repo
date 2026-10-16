import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import test from 'node:test';

const worker = join(process.cwd(), 'test', 'fixtures', 'proactiveCredentialRecoveryWorker.mjs');

function fixtureDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'still-proactive-credential-recovery-'));
  const publicRoot = join(directory, 'public');
  mkdirSync(join(publicRoot, 'assets'), { recursive: true });
  writeFileSync(join(publicRoot, 'index.html'), '<!doctype html><html><head><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>');
  writeFileSync(join(publicRoot, 'manifest.webmanifest'), '{"name":"Still"}');
  writeFileSync(join(publicRoot, 'sw.js'), '');
  writeFileSync(join(publicRoot, 'assets', 'still-icon.png'), Buffer.from([137, 80, 78, 71]));
  return directory;
}

function runWorker(directory, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, directory, mode], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`credential recovery ${mode} worker timed out`)); }, 30_000);
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || signal !== null) return reject(new Error(`credential recovery ${mode} worker exited ${code}/${signal}: ${stderr}`));
      resolve();
    });
  });
}

test('a missing-key pre-dispatch failure can resume only after restart, key setup, and fresh policy consent', async () => {
  const directory = fixtureDirectory();
  try {
    await runWorker(directory, 'missing');
    await runWorker(directory, 'key-only');
    await runWorker(directory, 'resume');
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
