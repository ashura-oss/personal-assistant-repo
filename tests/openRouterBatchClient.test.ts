import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  OPENROUTER_BATCH_BODY_MODEL,
  OPENROUTER_BATCH_ENDPOINT,
  OPENROUTER_BATCH_RESPONSE_MAX_BYTES,
  OPENROUTER_CHAT_COMPLETIONS_PATH,
  OpenRouterBatchClient,
  OpenRouterBatchDispatchError,
  OpenRouterBatchInspectionReadError,
  OpenRouterBatchRequestBuilder,
  parseOpenRouterRetryAfter,
} from '../src/services/openRouter';
import type { PrivacyControlState, PrivacyControlStore, PrivacyEraseAdapter, PrivacyOwner } from '../src/privacy/types';
import type { AppSettings, Note } from '../src/core';
import { AppControllerImpl } from '../src/services/controller';
import { createProviderCleanupRegistry, createTrackedProviderResponseLifetime } from '../src/services/providerResponseLifetime';
import { buildOpenRouterPeriodSummaryRequest, createOpenRouterPeriodSummaryBinding } from '../src/services/openRouterPeriodSummary';

vi.mock('expo', () => ({ requireOptionalNativeModule: () => null }));

const operationId = '20000000-0000-4000-8000-000000000001';
const requestBody = JSON.stringify({
  model: OPENROUTER_BATCH_BODY_MODEL,
  messages: [{ role: 'system', content: 'fixed system' }, { role: 'user', content: 'fictional request' }],
  reasoning: { effort: 'low', exclude: true },
  response_format: { type: 'json_schema', json_schema: { name: 'mail_reply_body', strict: true, schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } } } },
  stream: false,
});

function acceptedBatch(batchId = 'batch_fixture_1') {
  return new Response(JSON.stringify({
    id: batchId,
    object: 'batch',
    endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
    model: OPENROUTER_BATCH_BODY_MODEL,
    completion_window: '24h',
    status: 'validating',
    request_counts: { total: 1, completed: 0, failed: 0 },
  }), { status: 202 });
}

function makeClient(fetcher: typeof fetch, options: { key?: string | null; beforeFetch?: () => Promise<void>; ownership?: <T>(work: () => Promise<T>) => Promise<T>; sha256Text?: (value: string) => Promise<string> } = {}) {
  const events: string[] = [];
  const client = new OpenRouterBatchClient({
    fetcher,
    withRequestOwnership: options.ownership ?? (async (work) => { events.push('owned:start'); try { return await work(); } finally { events.push('owned:settled'); } }),
    readCredentialSnapshot: async () => ({ key: options.key === undefined ? 'fictional-key' : options.key, generation: 3 }),
    assertCredentialGeneration: (expected) => { if (expected !== 3) throw new Error('stale'); },
    assertBeforeStart: () => undefined,
    sha256Text: options.sha256Text,
  });
  return { client, events };
}

describe('OpenRouter Batch client', () => {
  it('submits a fully validated profile-6 summary through the one-POST path and rejects a tampered binding before side effects', async () => {
    const digest = async (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
    const content = 'A fictional event captured for the period-summary client test.';
    const binding = await createOpenRouterPeriodSummaryBinding({
      version: 1, requestProfileVersion: 6, operation: 'period_summary', policyId: '11111111-1111-4111-8111-111111111111',
      policyRevision: 1, policyDigest: 'a'.repeat(64), occurrenceId: '22222222-2222-4222-8222-222222222222',
      period: 'daily', timeZone: 'UTC', localInterval: { start: '2026-06-30', end: '2026-07-01' },
      startUtc: '2026-06-30T00:00:00.000Z', endUtc: '2026-07-01T00:00:00.000Z', preparedAt: '2026-07-01T01:00:00.000Z',
      sources: [{ id: 'event-1', role: 'event', kind: 'note', revision: 1, content, contentSha256: await digest(content),
        effectiveAt: '2026-06-30T12:00:00.000Z', observedAt: '2026-07-01T01:00:00.000Z' }],
      destination: { kind: 'absent', documentId: null, path: 'reports/daily.md', expectedRevision: null, expectedAbsenceGeneration: 0 },
      instructions: 'Summarize supplied events.', effort: 'low',
    }, digest);
    const prepared = await buildOpenRouterPeriodSummaryRequest(binding, digest);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => acceptedBatch('batch_period_summary'));
    const reservation = vi.fn(async () => undefined);
    const { client } = makeClient(fetcher as unknown as typeof fetch, { sha256Text: digest });
    await expect(client.submit({ operationId, requestProfileVersion: 6, operation: 'period_summary', requestBody: prepared.body,
      requestSha256: await digest(prepared.body), summaryBinding: binding }, reservation)).resolves.toMatchObject({ batchId: 'batch_period_summary' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(reservation).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { requests: { custom_id: string; body: { response_format: { json_schema: { name: string } } } }[] };
    expect(payload.requests[0]).toMatchObject({ custom_id: operationId, body: { response_format: { json_schema: { name: 'period_summary' } } } });

    const rejectedFetch = vi.fn(async () => acceptedBatch());
    const rejectedReservation = vi.fn(async () => undefined);
    const { client: rejectedClient } = makeClient(rejectedFetch as unknown as typeof fetch, { sha256Text: digest });
    await expect(rejectedClient.submit({ operationId, requestProfileVersion: 6, operation: 'period_summary', requestBody: prepared.body,
      requestSha256: await digest(prepared.body), summaryBinding: { ...binding,
        sources: binding.sources.map((source) => ({ ...source, content: 'Tampered source bytes.' })) } }, rejectedReservation)).rejects.toMatchObject({ phase: 'pre_dispatch' });
    expect(rejectedReservation).not.toHaveBeenCalled();
    expect(rejectedFetch).not.toHaveBeenCalled();

    const legacyFetch = vi.fn(async () => acceptedBatch());
    const legacyReservation = vi.fn(async () => undefined);
    const { client: legacyClient } = makeClient(legacyFetch as unknown as typeof fetch, { sha256Text: digest });
    await expect(legacyClient.submit({ operationId, requestProfileVersion: 5, operation: 'period_summary' as never, requestBody: prepared.body }, legacyReservation))
      .rejects.toMatchObject({ phase: 'pre_dispatch' });
    expect(legacyReservation).not.toHaveBeenCalled();
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('owns the full profile-6 operation synchronously before digest or credential barriers', async () => {
    const digest = async (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
    const content = 'A fictional event captured for the immutable submission test.';
    const binding = await createOpenRouterPeriodSummaryBinding({
      version: 1, requestProfileVersion: 6, operation: 'period_summary', policyId: '11111111-1111-4111-8111-111111111111',
      policyRevision: 1, policyDigest: 'a'.repeat(64), occurrenceId: '22222222-2222-4222-8222-222222222222',
      period: 'daily', timeZone: 'UTC', localInterval: { start: '2026-06-30', end: '2026-07-01' },
      startUtc: '2026-06-30T00:00:00.000Z', endUtc: '2026-07-01T00:00:00.000Z', preparedAt: '2026-07-01T01:00:00.000Z',
      sources: [{ id: 'event-1', role: 'event', kind: 'note', revision: 1, content, contentSha256: await digest(content),
        effectiveAt: '2026-06-30T12:00:00.000Z', observedAt: '2026-07-01T01:00:00.000Z' }],
      destination: { kind: 'absent', documentId: null, path: 'reports/daily.md', expectedRevision: null, expectedAbsenceGeneration: 0 },
      instructions: 'Summarize supplied events.', effort: 'low',
    }, digest);
    const prepared = await buildOpenRouterPeriodSummaryRequest(binding, digest);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => acceptedBatch('batch_immutable_summary'));
    const { client } = makeClient(fetcher as unknown as typeof fetch, { sha256Text: digest });
    const submission = { operationId, requestProfileVersion: 6, operation: 'period_summary', requestBody: prepared.body,
      requestSha256: await digest(prepared.body), summaryBinding: JSON.parse(JSON.stringify(binding)) } as {
        operationId: string; requestProfileVersion: number; operation: string; requestBody: string; requestSha256: string;
        summaryBinding: Record<string, any>;
      };
    const pending = client.submit(submission as never, async () => undefined);
    submission.operationId = '99999999-9999-4999-8999-999999999999';
    submission.requestBody = '{}';
    submission.requestSha256 = 'f'.repeat(64);
    submission.summaryBinding.policyId = '99999999-9999-4999-8999-999999999999';
    submission.summaryBinding.sources[0].content = 'substituted after submit';
    await expect(pending).resolves.toMatchObject({ batchId: 'batch_immutable_summary' });
    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { requests: { custom_id: string; body: unknown }[] };
    expect(payload.requests[0]?.custom_id).toBe(operationId);
    expect(payload.requests[0]?.body).toEqual(JSON.parse(prepared.body));
  });

  it('rejects accessor-bearing profile-6 input before reservation or provider I/O', async () => {
    const fetcher = vi.fn(async () => acceptedBatch());
    const reserve = vi.fn(async () => undefined);
    const { client } = makeClient(fetcher as unknown as typeof fetch);
    const input = { operationId, requestProfileVersion: 6, operation: 'period_summary', requestBody: '{}',
      requestSha256: 'a'.repeat(64), summaryBinding: {} } as Record<string, unknown>;
    Object.defineProperty(input, 'operationId', { enumerable: true, get: () => operationId });
    await expect(client.submit(input as never, reserve)).rejects.toMatchObject({ phase: 'pre_dispatch' });
    expect(reserve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('writes the fixed ordered Batch envelope and performs exactly one POST after durable admission', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const events: string[] = [];
    const { client } = makeClient(vi.fn(async (url, init) => {
      seen.push({ url: String(url), init });
      events.push('fetch');
      return acceptedBatch();
    }) as unknown as typeof fetch);

    const result = await client.submit({ operationId, requestBody }, async () => { events.push('durable-intent'); });
    const raw = String(seen[0]?.init?.body);
    expect(events).toEqual(['durable-intent', 'fetch']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(OPENROUTER_BATCH_ENDPOINT);
    expect(seen[0]?.init?.method).toBe('POST');
    expect(seen[0]?.init?.redirect).toBe('error');
    expect(raw.indexOf('"endpoint"')).toBeLessThan(raw.indexOf('"model"'));
    expect(raw.indexOf('"model"')).toBeLessThan(raw.indexOf('"provider"'));
    expect(raw.indexOf('"provider"')).toBeLessThan(raw.indexOf('"completion_window"'));
    expect(raw.indexOf('"completion_window"')).toBeLessThan(raw.indexOf('"requests"'));
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    expect(envelope.provider).toEqual({ only: ['openai'], allow_fallbacks: false });
    expect(envelope.completion_window).toBe('24h');
    expect(envelope.requests).toEqual([{ custom_id: operationId, body: JSON.parse(requestBody) }]);
    expect(result).toEqual({ batchId: 'batch_fixture_1', status: 'validating', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH, model: OPENROUTER_BATCH_BODY_MODEL, completionWindow: '24h', total: 1, completed: 0, failed: 0 });
  });

  it('clears the controller Batch cleanup view when its tracked request settles naturally', async () => {
    const app = new AppControllerImpl();
    const registry = createProviderCleanupRegistry();
    const retryRaw = vi.fn(async () => undefined);
    const lifetime = createTrackedProviderResponseLifetime(async (_input, _init, consume, onCancel, beforeStart) => {
      beforeStart?.();
      onCancel?.(retryRaw);
      return consume(acceptedBatch('batch_natural_settlement'));
    }, 'openrouter_batch', registry);
    const client = new OpenRouterBatchClient({
      withRequestOwnership: async (work) => work(), withResponseLifetime: lifetime,
      readCredentialSnapshot: async () => ({ key: 'fictional-key', generation: 3 }),
      assertCredentialGeneration: (generation) => { if (generation !== 3) throw new Error('stale'); },
      assertBeforeStart: () => undefined,
      onCancelPending: (id, retry) => app.rememberOpenRouterBatchCleanup(id, retry),
    });
    await expect(client.submit({ operationId, requestBody }, async () => undefined)).resolves.toMatchObject({ batchId: 'batch_natural_settlement' });
    expect(registry.getPending()).toEqual([]);
    await expect(app.retryAssistantBatchCleanup(operationId)).rejects.toThrow(/saved Batch job was not found/i);
    expect(retryRaw).not.toHaveBeenCalled();
  });

  it('accepts a profile-2 note body through the actual client and sends one fixed POST', async () => {
    const settings: AppSettings = {
      mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch',
      openRouterReasoningEffort: 'low', llmRequestContractVersion: 1,
      timezone: 'Asia/Singapore', openAiEndpoint: undefined, openAiDeployment: undefined,
      maxContextTokens: 4096, maxRequestBytes: 1024, maxOutputTokens: 64, monthlyBudgetUsd: 3,
      reasoningEffort: 'none', maxAttempts: 1, maxCallsPerDay: 2, maxAudioSeconds: 600, audioRetention: 'keep',
    };
    const note: Note = {
      id: 'note-profile-2', title: 'Profile test', transcript: 'A fictional note for the v2 integration test.',
      durationSeconds: 3.25, createdAt: '2026-10-13T10:00:00.000Z', capturedAt: '2026-10-13T10:00:00.000Z',
      captureTimeZone: 'Asia/Singapore', status: 'recorded', revision: 1,
    };
    const prepared = await new OpenRouterBatchRequestBuilder().prepareAnalysis(note, [], settings, { intent: 'answer', question: 'What should happen next?' });
    expect(prepared.requestProfileVersion).toBe(2);
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => acceptedBatch('batch_profile_2'));
    const { client } = makeClient(fetcher as unknown as typeof fetch);
    await expect(client.submit({ operationId, requestBody: prepared.body, requestProfileVersion: prepared.requestProfileVersion }, async () => undefined))
      .resolves.toMatchObject({ batchId: 'batch_profile_2' });
    expect(fetcher).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { requests: { body: { response_format: { json_schema: { schema: unknown } } } }[] };
    expect(body.requests[0]?.body.response_format.json_schema.schema).toEqual(JSON.parse(prepared.body).response_format.json_schema.schema);
  });

  it('rejects an unsupported forged profile version before credential reads, reservation, or POST', async () => {
    const settings: AppSettings = {
      mode: 'provider', llmProvider: 'openrouter', openRouterModel: 'openai/gpt-6-luna:batch',
      openRouterReasoningEffort: 'low', llmRequestContractVersion: 1,
      timezone: 'Asia/Singapore', openAiEndpoint: undefined, openAiDeployment: undefined,
      maxContextTokens: 4096, maxRequestBytes: 1024, maxOutputTokens: 64, monthlyBudgetUsd: 3,
      reasoningEffort: 'none', maxAttempts: 1, maxCallsPerDay: 2, maxAudioSeconds: 600, audioRetention: 'keep',
    };
    const note: Note = {
      id: 'note-invalid-profile', title: 'Profile test', transcript: 'A fictional note for the invalid-profile test.',
      durationSeconds: 3.25, createdAt: '2026-10-13T10:00:00.000Z', capturedAt: '2026-10-13T10:00:00.000Z',
      captureTimeZone: 'Asia/Singapore', status: 'recorded', revision: 1,
    };
    const prepared = await new OpenRouterBatchRequestBuilder().prepareAnalysis(note, [], settings, { intent: 'answer', question: 'What should happen next?' });
    const fetcher = vi.fn(async () => acceptedBatch());
    const readCredentialSnapshot = vi.fn(async () => ({ key: 'fictional-key', generation: 3 }));
    const reservation = vi.fn(async () => undefined);
    const client = new OpenRouterBatchClient({
      fetcher: fetcher as unknown as typeof fetch,
      withRequestOwnership: async (work) => work(),
      readCredentialSnapshot,
      assertCredentialGeneration: () => undefined,
      assertBeforeStart: () => undefined,
    });

    await expect(client.submit({
      operationId,
      requestBody: prepared.body,
      requestProfileVersion: 999 as unknown as 2,
    }, reservation)).rejects.toMatchObject<Partial<OpenRouterBatchDispatchError>>({ phase: 'pre_dispatch' });
    expect(readCredentialSnapshot).not.toHaveBeenCalled();
    expect(reservation).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('finishes credential reads and durable reservation before acquiring provider request ownership', async () => {
    let owned = false;
    const events: string[] = [];
    const client = new OpenRouterBatchClient({
      fetcher: async () => acceptedBatch(),
      withRequestOwnership: async (work) => {
        expect(owned).toBe(false);
        owned = true;
        events.push('ownership:start');
        try { return await work(); } finally { owned = false; events.push('ownership:settled'); }
      },
      readCredentialSnapshot: async () => {
        expect(owned).toBe(false);
        events.push('credential:read');
        return { key: 'fictional-key', generation: 7 };
      },
      assertCredentialGeneration: () => undefined,
      assertBeforeStart: () => { expect(owned).toBe(true); events.push('dispatch:fence'); },
    });

    await client.submit({ operationId, requestBody }, async () => {
      expect(owned).toBe(false);
      events.push('reservation:committed');
    });
    expect(events).toEqual(['credential:read', 'reservation:committed', 'ownership:start', 'dispatch:fence', 'ownership:settled']);
  });

  it('does not reacquire credential or app-state writers inside a provider writer when native cleanup queues', async () => {
    vi.stubGlobal('__DEV__', false);
    const [arbitrationModule, schema, boundaryModule, serviceModule] = await Promise.all([
      import('../src/privacy/arbitration'), import('../src/privacy/schema'), import('../src/privacy/resourceBoundary'), import('../src/privacy/service'),
    ]);
    const { createNativePrivacyArbitration } = arbitrationModule;
    const { createEmptyPrivacyControlState, validatePrivacyControlState } = schema;
    const { createPrivacyResourceBoundary } = boundaryModule;
    const { createPrivacyService } = serviceModule;
    const epoch = 'caa27bbc-5a14-4b73-a8fa-90c6a90207c4';
    const owner: PrivacyOwner = { platform: 'ios', runtimeId: epoch, processLaunchId: '6b7b5f77-1b6a-4b94-aeb7-7d76a2098131', bundleIdentifier: 'com.still.voiceassistant' };
    let controlState = createEmptyPrivacyControlState(epoch);
    const controlStore: PrivacyControlStore = {
      async read() { return structuredClone(validatePrivacyControlState(controlState)); },
      async compareAndSwap(expectedRevision: string, next: PrivacyControlState) {
        if (controlState.revision !== expectedRevision) throw new Error('revision conflict');
        controlState = structuredClone(validatePrivacyControlState(next));
      },
    };
    const arbitration = createNativePrivacyArbitration({ getRuntimeOwner: async () => owner, waitTimeoutMs: 1_000 });
    const eraseAdapter: PrivacyEraseAdapter = { async erase() {}, async verifyGone() { return true; } };
    const privacy = createPrivacyService({ controlStore, arbitration, eraseAdapter });
    const session = await privacy.openWorkspace();
    const resources = createPrivacyResourceBoundary({ privacy, session });
    const rawCredentials = { async get() { return 'fictional-key'; }, async set() {}, async delete() {} };
    const credentials = resources.credentialStore(rawCredentials);
    let queueCleanup!: () => void;
    let cleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const cleanupQueued = new Promise<void>((resolve) => { queueCleanup = resolve; });
    const cleanupEntering = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let cleanupPromise: Promise<void> | undefined;
    let finishResponse!: (response: Response) => void;
    const delayedResponse = new Promise<Response>((resolve) => { finishResponse = resolve; });
    let fetchStarted!: () => void;
    const fetched = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const client = new OpenRouterBatchClient({
      withRequestOwnership: (actual) => resources.withProviderOwnership(async () => {
        cleanupPromise = arbitration.withCleanupLock(async () => { cleanupStarted(); await cleanupGate; });
        queueCleanup();
        await Promise.resolve();
        return actual();
      }),
      fetcher: (async () => { fetchStarted(); return delayedResponse; }) as typeof fetch,
      readCredentialSnapshot: async () => ({ key: await credentials.get('openrouter.api-key'), generation: 9 }),
      assertCredentialGeneration: () => undefined,
      assertBeforeStart: () => undefined,
    });
    const submit = client.submit({ operationId, requestBody }, async () => {
      await privacy.withWriter(session.epoch, { kind: 'app_state', namespace: 'state_database' }, async () => undefined);
    });

    await cleanupQueued;
    await fetched;
    expect(cleanupPromise).toBeDefined();
    let cleanupHasEntered = false;
    void cleanupEntering.then(() => { cleanupHasEntered = true; });
    await Promise.resolve();
    expect(cleanupHasEntered).toBe(false);
    finishResponse(acceptedBatch('batch_native_arbitration'));
    await expect(submit).resolves.toMatchObject({ batchId: 'batch_native_arbitration' });
    await cleanupEntering;
    releaseCleanup();
    await cleanupPromise;
  });

  it('does not invoke the durable callback or fetch without a credential', async () => {
    const fetcher = vi.fn(async () => acceptedBatch());
    const before = vi.fn(async () => undefined);
    const { client } = makeClient(fetcher as unknown as typeof fetch, { key: null });
    await expect(client.submit({ operationId, requestBody }, before)).rejects.toMatchObject({ phase: 'pre_dispatch' });
    expect(before).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['batch_fixture_1\n', 'batch/unsafe'])('rejects unsafe provider acknowledgement identifiers before accepting a submitted job: %j', async (id) => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      id, object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH, model: OPENROUTER_BATCH_BODY_MODEL,
      completion_window: '24h', status: 'validating', request_counts: { total: 1, completed: 0, failed: 0 },
    }), { status: 202 }));
    const { client } = makeClient(fetcher as unknown as typeof fetch);
    await expect(client.submit({ operationId, requestBody }, async () => undefined)).rejects.toMatchObject({ phase: 'unknown' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects a local operation UUID with a trailing newline before any durable intent', async () => {
    const fetcher = vi.fn(async () => acceptedBatch());
    const admission = vi.fn(async () => undefined);
    const { client } = makeClient(fetcher as unknown as typeof fetch);
    await expect(client.submit({ operationId: `${operationId}\n`, requestBody }, admission)).rejects.toMatchObject({ phase: 'pre_dispatch' });
    expect(admission).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown schema name', (body: Record<string, any>) => { body.response_format.json_schema.name = 'other'; }],
    ['altered schema', (body: Record<string, any>) => { body.response_format.json_schema.schema.properties.text.maxLength = 9; }],
    ['extra reasoning control', (body: Record<string, any>) => { body.reasoning.max_tokens = 5; }],
    ['coerced reasoning value', (body: Record<string, any>) => { body.reasoning.effort = ['low']; }],
    ['extra format field', (body: Record<string, any>) => { body.response_format.temperature = 0; }],
    ['extra message field', (body: Record<string, any>) => { body.messages[0].tools = []; }],
  ])('rejects a %s before durable admission or fetch', async (_label, mutate) => {
    const fetcher = vi.fn(async () => acceptedBatch());
    const admission = vi.fn(async () => undefined);
    const { client } = makeClient(fetcher as unknown as typeof fetch);
    const body = JSON.parse(requestBody) as Record<string, any>;
    mutate(body);
    await expect(client.submit({ operationId, requestBody: JSON.stringify(body) }, admission)).rejects.toMatchObject({ phase: 'pre_dispatch' });
    expect(admission).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['credential rotation', 'source revocation'] as const)(
    'keeps a delayed normalization failure pre-dispatch after %s', async (mutation) => {
      let finishNormalization!: () => void;
      const normalization = new Promise<void>((resolve) => { finishNormalization = resolve; });
      let generation = 3;
      let sourceCurrent = true;
      const durableIntent = vi.fn(async () => undefined);
      const nativeOrWebStart = vi.fn(async () => acceptedBatch());
      const client = new OpenRouterBatchClient({
        withResponseLifetime: async (_input, _init, consume, _onCancel, beforeStart) => {
          await normalization;
          beforeStart?.();
          return consume(await nativeOrWebStart());
        },
        withRequestOwnership: async (work) => work(),
        readCredentialSnapshot: async () => ({ key: 'fictional-key', generation: 3 }),
        assertCredentialGeneration: (expected) => { if (expected !== generation) throw new Error('stale credential'); },
        assertBeforeStart: () => { if (!sourceCurrent) throw new Error('source revoked'); },
      });

      const pending = client.submit({ operationId, requestBody }, durableIntent);
      await vi.waitFor(() => expect(durableIntent).toHaveBeenCalledOnce());
      if (mutation === 'credential rotation') generation += 1;
      else sourceCurrent = false;
      finishNormalization();

      await expect(pending).rejects.toMatchObject<Partial<OpenRouterBatchDispatchError>>({ phase: 'pre_dispatch' });
      expect(nativeOrWebStart).not.toHaveBeenCalled();
      expect(durableIntent).toHaveBeenCalledOnce();
    }
  );

  it('keeps request ownership until the actual response body has settled', async () => {
    let finishBody!: (value: string) => void;
    let ownedSettled = false;
    const response = {
      ok: true,
      status: 202,
      arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => { finishBody = (value) => resolve(new TextEncoder().encode(value).buffer); }),
    } as Response;
    const client = new OpenRouterBatchClient({
      fetcher: vi.fn(async () => response) as unknown as typeof fetch,
      withRequestOwnership: async (actual) => {
        try { return await actual(); } finally { ownedSettled = true; }
      },
      readCredentialSnapshot: async () => ({ key: 'fictional-key', generation: 1 }),
      assertCredentialGeneration: () => undefined,
      assertBeforeStart: () => undefined,
    });
    const pending = client.submit({ operationId, requestBody }, async () => undefined);
    await vi.waitFor(() => expect(finishBody).toBeTypeOf('function'));
    expect(ownedSettled).toBe(false);
    finishBody(JSON.stringify({ id: 'batch_fixture_1', object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH, model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h', status: 'validating', request_counts: { total: 1, completed: 0, failed: 0 } }));
    await expect(pending).resolves.toMatchObject({ batchId: 'batch_fixture_1' });
    expect(ownedSettled).toBe(true);
  });

  it('awaits bounded web-stream cancellation before releasing request ownership', async () => {
    let cancelStarted!: () => void;
    let finishCancel!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => { cancelStarted = resolve; });
    let ownershipSettled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(OPENROUTER_BATCH_RESPONSE_MAX_BYTES + 1)); },
      cancel() {
        cancelStarted();
        return new Promise<void>((resolve) => { finishCancel = resolve; });
      },
    });
    const response = new Response(stream, { status: 200 });
    const client = new OpenRouterBatchClient({
      fetcher: (async () => response) as typeof fetch,
      withRequestOwnership: async (actual) => { try { return await actual(); } finally { ownershipSettled = true; } },
      readCredentialSnapshot: async () => ({ key: 'fictional-key', generation: 1 }),
      assertCredentialGeneration: () => undefined,
      assertBeforeStart: () => undefined,
    });
    const pending = client.inspect('batch_fixture_1', operationId);
    await cancellationStarted;
    expect(ownershipSettled).toBe(false);
    finishCancel();
    await expect(pending).rejects.toThrow(/16 MiB safety limit/i);
    expect(ownershipSettled).toBe(true);
  });

  it('reports a post-fetch response failure as unknown and never retries', async () => {
    const fetcher = vi.fn(async () => new Response('not-json', { status: 502 }));
    const { client } = makeClient(fetcher as unknown as typeof fetch);
    let beforeCalls = 0;
    await expect(client.submit({ operationId, requestBody }, async () => { beforeCalls += 1; })).rejects.toMatchObject<Partial<OpenRouterBatchDispatchError>>({ phase: 'unknown' });
    expect(beforeCalls).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('inspects one saved batch once and validates the exact single inline result', async () => {
    const payload = {
      id: 'batch_fixture_1', object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h', status: 'completed',
      request_counts: { total: 1, completed: 1, failed: 0 },
      usage: { cost: 0.0025, is_byok: false, prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      results: [{ custom_id: operationId, response: { status_code: 200, body: { model: OPENROUTER_BATCH_BODY_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }] } }, error: null }],
    };
    const calls: RequestInit[] = [];
    const fetcher: typeof fetch = async (_input, init) => { calls.push(init ?? {}); return new Response(JSON.stringify(payload), { status: 200 }); };
    const { client } = makeClient(fetcher);
    await expect(client.inspect('batch_fixture_1', operationId)).resolves.toMatchObject({
      status: 'completed', usage: { cost: 0.0025, isByok: false, totalTokens: 30 },
      result: { customId: operationId, statusCode: 200, finishReason: 'stop', responseBody: { model: OPENROUTER_BATCH_BODY_MODEL } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
  });

  it('preserves safe Retry-After hints for GET polling and classifies transient HTTP responses without shortening them', async () => {
    const now = Date.parse('2026-10-15T00:00:00.000Z');
    expect(parseOpenRouterRetryAfter('90000', now)).toBe(now + 90_000_000);
    expect(parseOpenRouterRetryAfter('not-a-date', now)).toBeUndefined();
    const date = 'Wed, 21 Oct 2026 07:28:00 GMT';
    const client = makeClient(async () => new Response(JSON.stringify({ id: 'batch_fixture_1', object: 'batch',
      endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH, model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h',
      status: 'in_progress', request_counts: { total: 1, completed: 0, failed: 0 } }), { status: 200, headers: { 'Retry-After': date } })).client;
    await expect(client.inspect('batch_fixture_1', operationId)).resolves.toMatchObject({ retryAfterMs: Date.parse(date) });
    const throttled = makeClient(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '7200' } })).client;
    await expect(throttled.inspect('batch_fixture_1', operationId)).rejects.toMatchObject<Partial<OpenRouterBatchInspectionReadError>>({
      retryable: true, retryAfterMs: expect.any(Number),
    });
    for (const [response, seconds] of [
      [new Response('<html>busy</html>', { status: 429, headers: { 'content-type': 'text/html', 'Retry-After': '90' } }), 90],
      [new Response(null, { status: 503, headers: { 'Retry-After': '120' } }), 120],
    ] as const) {
      const before = Date.now();
      const client = makeClient(async () => response).client;
      const error = await client.inspect('batch_fixture_1', operationId).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(OpenRouterBatchInspectionReadError);
      expect(error).toMatchObject({ retryable: true });
      expect((error as OpenRouterBatchInspectionReadError).retryAfterMs).toBeGreaterThanOrEqual(before + seconds * 1_000);
    }
    const denied = makeClient(async () => new Response('{}', { status: 401 })).client;
    await expect(denied.inspect('batch_fixture_1', operationId)).rejects.toMatchObject<Partial<OpenRouterBatchInspectionReadError>>({ retryable: false });
  });

  it('retains accounting for the owned batch when its model metadata is invalid, without exposing that model or result', async () => {
    const payload = {
      id: 'batch_fixture_1', object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: 'openai/not-the-configured-model', completion_window: '24h', status: 'completed',
      request_counts: { total: 1, completed: 1, failed: 0 },
      usage: { cost: 0.004, prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
      results: [{ custom_id: operationId, response: { status_code: 200, body: { model: 'openai/not-the-configured-model', choices: [] } }, error: null }],
    };
    const { client } = makeClient(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const result = await client.inspect('batch_fixture_1', operationId);
    expect(result.metadataValidation).toBe('invalid');
    expect(result.resultValidation).toBe('invalid');
    expect(result.usage).toEqual({ cost: 0.004, promptTokens: 30, completionTokens: 12, totalTokens: 42 });
    expect(result).not.toHaveProperty('model');
    expect(result).not.toHaveProperty('result');
  });

  it('does not attribute accounting from a result carrying a different custom ID', async () => {
    const payload = {
      id: 'batch_fixture_1', object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h', status: 'completed',
      request_counts: { total: 1, completed: 1, failed: 0 },
      usage: { cost: 0.004 },
      results: [{ custom_id: '30000000-0000-4000-8000-000000000001', response: { status_code: 200, body: {} }, error: null }],
    };
    const { client } = makeClient(async () => new Response(JSON.stringify(payload), { status: 200 }));
    await expect(client.inspect('batch_fixture_1', operationId)).rejects.toThrow(/did not match the saved request/i);
  });

  it('rejects inspection metadata with a different completion window', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({
      id: 'batch_fixture_1', object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '1h', status: 'in_progress',
      request_counts: { total: 1, completed: 0, failed: 0 },
    }), { status: 200 });
    const { client } = makeClient(fetcher);
    await expect(client.inspect('batch_fixture_1', operationId)).rejects.toThrow(/metadata did not match/i);
  });

  it('accepts only bounded opaque provider IDs and the exact verified canonical model slug', async () => {
    const payload = {
      id: 'batch-1234567890abcdef', object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: 'openai/gpt-6-luna-20260922', completion_window: '24h', status: 'in_progress',
      request_counts: { total: 1, completed: 0, failed: 0 },
    };
    const { client } = makeClient(async () => new Response(JSON.stringify(payload), { status: 200 }));
    await expect(client.inspect(payload.id, operationId)).resolves.toMatchObject({ batchId: payload.id, model: payload.model, completionWindow: '24h' });
    await expect(client.inspect('batch/unsafe', operationId)).rejects.toThrow(/identifiers are invalid/i);
    await expect(client.inspect(payload.id, 'not-a-uuid')).rejects.toThrow(/identifiers are invalid/i);
  });

  it('does not attribute accounting from a foreign inline result', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      id: 'batch_fixture_1', object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h', status: 'completed', request_counts: { total: 1, completed: 1, failed: 0 },
      usage: { cost: 0.003, prompt_tokens: 31, completion_tokens: 14, total_tokens: 45, is_byok: true },
      results: [{ custom_id: 'different', response: { status_code: 200 }, error: null }],
    }), { status: 200 }));
    const { client } = makeClient(fetcher as unknown as typeof fetch);
    await expect(client.inspect('batch_fixture_1', operationId)).rejects.toThrow(/did not match the saved request/i);
  });

  it('does not attribute accounting from a foreign result on a failed completed batch', async () => {
    const payload = {
      id: 'batch_fixture_1', object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h', status: 'completed',
      request_counts: { total: 1, completed: 0, failed: 1 }, usage: { cost: 0.009 },
      results: [{ custom_id: 'another-operation', response: null, error: { code: 'failed' } }],
    };
    const { client } = makeClient(async () => new Response(JSON.stringify(payload), { status: 200 }));
    await expect(client.inspect('batch_fixture_1', operationId)).rejects.toThrow(/did not match the saved request/i);
  });

  it('rejects non-string status values rather than coercing them into a known state', async () => {
    const payload = {
      id: 'batch_fixture_1', object: 'batch', endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
      model: OPENROUTER_BATCH_BODY_MODEL, completion_window: '24h', status: ['in_progress'],
      request_counts: { total: 1, completed: 0, failed: 0 },
    };
    const { client } = makeClient(async () => new Response(JSON.stringify(payload), { status: 200 }));
    await expect(client.inspect('batch_fixture_1', operationId)).rejects.toThrow(/metadata did not match/i);
  });
});
