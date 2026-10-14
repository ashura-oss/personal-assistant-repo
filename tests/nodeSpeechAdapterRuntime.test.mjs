import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('shared OpenRouter speech adapter imports and runs in real Node without Expo or global crypto', () => {
  const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const script = resolve(repositoryRoot, 'scripts/check-node-speech-adapter-runtime.mjs');
  const result = spawnSync(process.execPath, [script], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Node speech adapter boundary passed/);
});
