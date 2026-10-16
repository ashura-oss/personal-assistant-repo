import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import test from 'node:test';

const worker = join(process.cwd(), 'test', 'fixtures', 'proactiveSourceVersionWorker.mjs');
function fixtureDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'still-proactive-source-version-'));
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
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`source version ${mode} worker timed out`)); }, 60_000);
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || signal !== null) return reject(new Error(`source version ${mode} worker exited ${code}/${signal}: ${stderr}`));
      resolve();
    });
  });
}

test('each_changed_source submits one new body version, deduplicates the repeated version, and first_match mode cannot switch', async () => {
  const eachChanged = fixtureDirectory();
  const firstMatch = fixtureDirectory();
  try {
    await runWorker(eachChanged, 'each-a');
    await runWorker(eachChanged, 'each-b');
    await runWorker(eachChanged, 'each-repeat-b');
    await runWorker(firstMatch, 'first-a');
    await runWorker(firstMatch, 'mode-switch');
  } finally {
    rmSync(eachChanged, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(firstMatch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
