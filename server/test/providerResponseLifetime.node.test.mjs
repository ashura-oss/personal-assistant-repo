import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeProviderResponseLifetimeOwner } from '../dist/providerResponseLifetime.node.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function owner(fetcher) {
  let nextId = 1;
  return createNodeProviderResponseLifetimeOwner({
    fetcher,
    createId: () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`,
  });
}

test('Node transport is Expo-free and fails before any fetch when its start guard rejects', async () => {
  let fetches = 0;
  const lifetimeOwner = owner(async () => { fetches += 1; return new Response('unexpected'); });
  const lifetime = lifetimeOwner.withResponseLifetimeFor('openrouter_batch');
  await assert.rejects(lifetime('https://provider.invalid', {}, async (response) => response.text(), undefined, () => {
    throw new Error('stale');
  }), /stale/);
  assert.equal(fetches, 0);
  assert.deepEqual(lifetimeOwner.getPending(), []);
});

test('drain waits for a fetcher that ignores abort and does not dispatch again after admission closes', async () => {
  const fetchResult = deferred();
  let fetches = 0;
  let consumed = 0;
  const lifetimeOwner = owner((_input, init) => {
    fetches += 1;
    assert.ok(init.signal);
    return fetchResult.promise;
  });
  const operation = lifetimeOwner.withResponseLifetimeFor('oauth')('https://provider.invalid', {}, async () => {
    consumed += 1;
    return 'not expected';
  });
  lifetimeOwner.stopAdmission();
  const drain = lifetimeOwner.drain();
  let drained = false;
  void drain.then(() => { drained = true; }, () => { drained = true; });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(drained, false);
  assert.equal(lifetimeOwner.getPending().length, 1);
  fetchResult.resolve(new Response('body'));
  await assert.rejects(operation);
  await drain;
  assert.equal(consumed, 0);
  assert.equal(fetches, 1);
  await assert.rejects(lifetimeOwner.withResponseLifetimeFor('oauth')('https://provider.invalid', {}, async (response) => response.text()));
  assert.equal(fetches, 1);
});

test('drain waits for the consumer and observed response stream after cancellation', async () => {
  const consumerGate = deferred();
  const consumerStarted = deferred();
  let retryHandle;
  let settledNotifications = 0;
  let fetches = 0;
  const lifetimeOwner = owner(async () => { fetches += 1; return new Response('body'); });
  const operation = lifetimeOwner.withResponseLifetimeFor('azure_speech')('https://provider.invalid', {}, async () => {
    consumerStarted.resolve();
    await consumerGate.promise;
    return 'consumed-result';
  }, (retry) => { retryHandle = retry; });
  await consumerStarted.promise;
  lifetimeOwner.stopAdmission();
  const drain = lifetimeOwner.drain();
  let drained = false;
  void drain.then(() => { drained = true; }, () => { drained = true; });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(drained, false);
  assert.equal(lifetimeOwner.getPending()[0]?.purpose, 'azure_speech');
  assert.deepEqual(Object.keys(lifetimeOwner.getPending()[0] ?? {}).sort(), ['id', 'purpose', 'state']);
  const unsubscribe = retryHandle.subscribeSettled(() => { settledNotifications += 1; });
  consumerGate.resolve();
  assert.equal(await operation, 'consumed-result');
  await drain;
  unsubscribe();
  assert.equal(fetches, 1);
  assert.equal(settledNotifications, 1);
  assert.deepEqual(lifetimeOwner.getPending(), []);
});

test('a rejected Node body cancellation remains fenced when a later cancel is not evidence of cleanup', async () => {
  let cancelCalls = 0;
  const response = new Response(new ReadableStream({
    pull() {},
    cancel() {
      cancelCalls += 1;
      throw new Error('first cancellation failed');
    },
  }));
  let fetches = 0;
  const lifetimeOwner = owner(async () => { fetches += 1; return response; });
  const operation = lifetimeOwner.withResponseLifetimeFor('openrouter_batch')('https://provider.invalid', {}, async () => 'returned-before-reading');
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(operation, /first cancellation failed/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    const pending = lifetimeOwner.getPending();
    assert.equal(pending.length, 1);
    const operationId = '00000000-0000-4000-8000-000000000001';
    assert.equal(pending[0]?.id, operationId);
    await assert.rejects(lifetimeOwner.drain(), /first cancellation failed/);
    await assert.rejects(lifetimeOwner.retryCleanup(operationId), /first cancellation failed/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    await assert.rejects(lifetimeOwner.drain(), /first cancellation failed/);
    assert.equal(lifetimeOwner.getPending()[0]?.state, 'cleanup_failed');
    assert.equal(cancelCalls, 1);
    assert.equal(fetches, 1);
    assert.equal(lifetimeOwner.getPending()[0]?.id, operationId);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('normal JSON/text consumption observes terminal stream completion and removes the entry', async () => {
  let fetches = 0;
  const lifetimeOwner = owner(async () => { fetches += 1; return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); });
  const result = await lifetimeOwner.withResponseLifetimeFor('connector')('https://provider.invalid', {}, async (response) => response.json());
  assert.deepEqual(result, { ok: true });
  assert.equal(fetches, 1);
  assert.deepEqual(lifetimeOwner.getPending(), []);
  await lifetimeOwner.drain();
});

test('a stale saved retry handle cannot act on a later entry that reuses its opaque id', async () => {
  const firstStarted = deferred();
  const firstConsumer = deferred();
  const secondStarted = deferred();
  const secondConsumer = deferred();
  const firstCaller = new AbortController();
  const secondCaller = new AbortController();
  let fetches = 0;
  const internalSignals = [];
  const lifetimeOwner = createNodeProviderResponseLifetimeOwner({
    createId: () => '00000000-0000-4000-8000-000000000099',
    fetcher: async (_input, init) => {
      fetches += 1;
      internalSignals.push(init.signal);
      return new Response('body');
    },
  });
  let staleRetry;
  const lifetime = lifetimeOwner.withResponseLifetimeFor('connector');
  const first = lifetime('https://provider.invalid', { signal: firstCaller.signal }, async () => {
    firstStarted.resolve();
    await firstConsumer.promise;
    return 'first';
  }, (retry) => { staleRetry = retry; });
  await firstStarted.promise;
  firstCaller.abort();
  firstConsumer.resolve();
  assert.equal(await first, 'first');
  assert.deepEqual(lifetimeOwner.getPending(), []);

  let currentRetry;
  const second = lifetime('https://provider.invalid', { signal: secondCaller.signal }, async () => {
    secondStarted.resolve();
    await secondConsumer.promise;
    return 'second';
  }, (retry) => { currentRetry = retry; });
  await secondStarted.promise;
  assert.equal(fetches, 2);
  await assert.rejects(staleRetry(), /not_pending/);
  assert.equal(internalSignals[1].aborted, false);
  secondCaller.abort();
  await currentRetry();
  secondConsumer.resolve();
  assert.equal(await second, 'second');
  assert.deepEqual(lifetimeOwner.getPending(), []);
});
