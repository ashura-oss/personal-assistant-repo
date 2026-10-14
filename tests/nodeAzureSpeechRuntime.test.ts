import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

describe('shared Azure Speech Node boundary', () => {
  it('imports and runs without Expo or global crypto', () => {
    const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
    const script = resolve(repositoryRoot, 'scripts/check-node-azure-speech-runtime.mjs');
    const result = spawnSync(process.execPath, [script], { cwd: repositoryRoot, encoding: 'utf8' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/Node Azure Speech boundary passed/);
  });
});
