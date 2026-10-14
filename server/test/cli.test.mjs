import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthError } from '../dist/auth.js';
import { runLocalCli } from '../dist/cli.js';

function fakeRuntime() {
  const calls = [];
  return {
    calls,
    runtime: {
      auth: {
        enrollOwner: async (password, snapshot) => { calls.push(['enroll', password, snapshot]); },
        resetPassword: async (password) => { calls.push(['reset', password]); },
      },
      initialWorkspaceSnapshot: () => ({ private: 'initial' }),
      readStatus: () => ({ enrolled: calls.some(([name]) => name === 'enroll') }),
      close: () => { calls.push(['close']); },
    },
  };
}

function depsFor(runtime, prompts = []) {
  const output = [];
  const errors = [];
  let opened = 0;
  return {
    output, errors, get opened() { return opened; },
    dependencies: {
      openRuntime: () => { opened += 1; return runtime; },
      promptHidden: async () => prompts.shift() ?? '',
      writeOut: (value) => output.push(value),
      writeError: (value) => errors.push(value),
    },
  };
}

test('CLI accepts only one explicit local command and never reads password arguments', async () => {
  const fixture = fakeRuntime();
  const deps = depsFor(fixture.runtime, ['secret', 'secret']);
  assert.equal(await runLocalCli(['enroll', 'secret'], deps.dependencies), 2);
  assert.equal(deps.opened, 0);
  assert.equal(await runLocalCli([], deps.dependencies), 2);
  assert.equal(await runLocalCli(['status'], deps.dependencies), 0);
  assert.deepEqual(deps.output, ['Owner account is not enrolled.\n']);
  assert.deepEqual(fixture.calls, [['close']]);
});

test('enrollment and reset use matching hidden prompts and close the trusted runtime', async () => {
  const fixture = fakeRuntime();
  const deps = depsFor(fixture.runtime, ['private password', 'private password', 'replacement', 'replacement']);
  assert.equal(await runLocalCli(['enroll'], deps.dependencies), 0);
  assert.equal(await runLocalCli(['reset-password'], deps.dependencies), 0);
  assert.deepEqual(fixture.calls, [
    ['enroll', 'private password', { private: 'initial' }], ['close'],
    ['reset', 'replacement'], ['close'],
  ]);
  assert.ok(deps.output.every((line) => !line.includes('private password') && !line.includes('replacement')));
  assert.ok(deps.errors.length === 0);
});

test('password mismatch and auth errors do not disclose submitted material', async () => {
  const fixture = fakeRuntime();
  const mismatch = depsFor(fixture.runtime, ['do not print', 'different']);
  assert.equal(await runLocalCli(['enroll'], mismatch.dependencies), 1);
  assert.deepEqual(fixture.calls, [['close']]);
  assert.doesNotMatch(mismatch.errors.join(''), /do not print|different/);

  const broken = fakeRuntime();
  broken.runtime.auth.resetPassword = async () => { throw new AuthError('private detail', 'auth_throttled'); };
  const failed = depsFor(broken.runtime, ['secret', 'secret']);
  assert.equal(await runLocalCli(['reset-password'], failed.dependencies), 1);
  assert.deepEqual(failed.errors, ['auth_throttled\n']);
});
