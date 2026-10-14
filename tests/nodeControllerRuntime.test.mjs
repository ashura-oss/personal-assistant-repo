import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('shared controller imports and runs in a real Node process without native modules', () => {
  const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const script = resolve(repositoryRoot, 'scripts/check-node-controller-runtime.mjs');
  const result = spawnSync(process.execPath, [script], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Node controller boundary passed/);
});
