import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

test('server package keeps provider verification dependencies server-only and has no Expo or React Native dependency', () => {
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  assert.deepEqual(Object.keys(packageJson.dependencies), ['better-sqlite3', 'jose', 'openid-client']);
  assert.equal(packageJson.dependencies['better-sqlite3'], '13.0.3');
  assert.equal(packageJson.dependencies.jose, '6.2.12');
  assert.equal(packageJson.dependencies['openid-client'], '6.8.8');
  assert.equal(Object.keys(dependencies).some((name) => /^(expo|react-native|react|still-voice-assistant)/i.test(name)), false);
  const runtimeFiles = filesUnder(fileURLToPath(new URL('../dist', import.meta.url))).filter((path) => path.endsWith('.js'));
  for (const path of runtimeFiles) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /from\s+["'](?:expo|react-native|\.\.\/\.\.\/src\/services\/controller)/);
    assert.doesNotMatch(source, /require\(["'](?:expo|react-native|\.\.\/\.\.\/src\/services\/controller)/);
  }
});
