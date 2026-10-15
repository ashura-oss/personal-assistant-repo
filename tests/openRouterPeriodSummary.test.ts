import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildOpenRouterPeriodSummaryRecoveryRequest, buildOpenRouterPeriodSummaryRequest,
  createOpenRouterPeriodSummaryBinding, isOpenRouterPeriodSummaryRequestBody, isOpenRouterPeriodSummaryRecoveryRequestBody,
  parseOpenRouterPeriodSummaryResult, type OpenRouterPeriodSummaryBinding,
  type OpenRouterPeriodSummarySource, type OpenRouterTruncatedPeriodSummaryJob,
} from '../src/services/openRouterPeriodSummary';

const digest = async (value: string): Promise<string> => createHash('sha256').update(value, 'utf8').digest('hex');
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function eventSource(id: string, overrides: Partial<OpenRouterPeriodSummarySource> = {}): OpenRouterPeriodSummarySource {
  const content = overrides.content ?? `Event facts for ${id}.`;
  return { id, role: 'event', kind: 'note', revision: 2, content, contentSha256: createHash('sha256').update(content).digest('hex'),
    effectiveAt: '2026-06-30T12:00:00.000Z', observedAt: '2026-07-01T02:00:00.000Z', ...overrides };
}

function contextSource(id: string, overrides: Partial<OpenRouterPeriodSummarySource> = {}): OpenRouterPeriodSummarySource {
  const content = overrides.content ?? `Selected reference context for ${id}.`;
  return { id, role: 'context', kind: 'document', revision: 4, documentPath: 'memory/reference.md', content,
    contentSha256: createHash('sha256').update(content).digest('hex'), effectiveAt: '2025-01-01T00:00:00.000Z',
    observedAt: '2026-07-01T02:00:00.000Z', ...overrides };
}

async function binding(sources: readonly OpenRouterPeriodSummarySource[] = [eventSource('event-1'), contextSource('context-1')], overrides: Record<string, unknown> = {}) {
  const base = {
    version: 1 as const, requestProfileVersion: 6 as const, operation: 'period_summary' as const,
    policyId: '11111111-1111-4111-8111-111111111111', policyRevision: 3, policyDigest: 'a'.repeat(64),
    occurrenceId: '22222222-2222-4222-8222-222222222222', period: 'daily' as const, timeZone: 'UTC',
    localInterval: { start: '2026-06-30', end: '2026-07-01' }, startUtc: '2026-06-30T00:00:00.000Z',
    endUtc: '2026-07-01T00:00:00.000Z', preparedAt: '2026-07-01T02:00:00.000Z', sources: [...sources].sort((left, right) => left.id.localeCompare(right.id)),
    destination: { kind: 'absent' as const, documentId: null, path: 'reports/summary-2026-06-30.md', expectedRevision: null },
    instructions: 'Summarize the events and cite only supplied source IDs.', effort: 'low' as const,
    ...overrides,
  };
  return createOpenRouterPeriodSummaryBinding(base as Omit<OpenRouterPeriodSummaryBinding, 'sourceManifestSha256'>, digest);
}

async function truncatedParent(captured: OpenRouterPeriodSummaryBinding): Promise<OpenRouterTruncatedPeriodSummaryJob> {
  const prepared = await buildOpenRouterPeriodSummaryRequest(captured, digest);
  const resultText = '{"markdown":"Partial summary","sourceReferences":[]}';
  return { id: '33333333-3333-4333-8333-333333333333', customId: '33333333-3333-4333-8333-333333333333',
    status: 'result_truncated', failureCode: 'result_truncated', requestProfileVersion: 6, operation: 'period_summary',
    effort: captured.effort, requestBody: prepared.body, requestSha256: await digest(prepared.body), resultText,
    resultSha256: await digest(resultText), binding: captured };
}

describe('OpenRouter period summary profile 6', () => {
  it('builds a deterministic strict request from a closed frozen source manifest', async () => {
    const captured = await binding();
    const prepared = await buildOpenRouterPeriodSummaryRequest(captured, digest);
    const wire = JSON.parse(prepared.body) as {
      model: string; reasoning: { effort: string }; response_format: { json_schema: { name: string; strict: boolean; schema: { properties: { markdown: { minLength: number }; sourceReferences: { items: { enum: string[] } } } } } };
      messages: { role: string; content: string }[];
    };
    expect(prepared).toMatchObject({ requestProfileVersion: 6, operation: 'period_summary', requestBytes: new TextEncoder().encode(prepared.body).length });
    expect(prepared.endpoint).toBe('/v1/chat/completions');
    expect(prepared.binding).toMatchObject({ startUtc: '2026-06-30T00:00:00.000Z', endUtc: '2026-07-01T00:00:00.000Z',
      timeZone: 'UTC', localInterval: { start: '2026-06-30', end: '2026-07-01' } });
    expect(wire.model).toBe('openai/gpt-6-luna');
    expect(wire.reasoning.effort).toBe('low');
    expect(wire.response_format.json_schema).toMatchObject({ name: 'period_summary', strict: true });
    expect(wire.response_format.json_schema.schema.properties.markdown.minLength).toBe(1);
    expect(wire.response_format.json_schema.schema.properties.sourceReferences.items.enum).toEqual(['context-1', 'event-1']);
    expect(JSON.parse(wire.messages[1]!.content).sources.map((source: { id: string }) => source.id)).toEqual(['event-1', 'context-1'].sort());
    expect(await buildOpenRouterPeriodSummaryRequest(captured, digest)).toEqual(prepared);
    expect(await isOpenRouterPeriodSummaryRequestBody(prepared.body, captured, digest)).toBe(true);
    expect(await isOpenRouterPeriodSummaryRequestBody(prepared.body.replace('"period_summary"', '"note_assistance"'), captured, digest)).toBe(false);
  });

  it('recomputes content and source-manifest digests and rejects noncanonical or extra fields', async () => {
    const captured = await binding();
    const alteredContent = json(captured) as unknown as Record<string, any>;
    alteredContent.sources[0].content = 'changed bytes';
    await expect(buildOpenRouterPeriodSummaryRequest(alteredContent, digest)).rejects.toThrow(/source_digest_mismatch/);

    const alteredManifest = { ...captured, sourceManifestSha256: 'b'.repeat(64) };
    await expect(buildOpenRouterPeriodSummaryRequest(alteredManifest, digest)).rejects.toThrow(/manifest_digest_mismatch/);
    await expect(buildOpenRouterPeriodSummaryRequest({ ...captured, extra: true }, digest)).rejects.toThrow(/binding_invalid/);
    await expect(buildOpenRouterPeriodSummaryRequest({ ...captured, requestProfileVersion: 5 }, digest)).rejects.toThrow(/binding_invalid/);
  });

  it('captures mutable caller input synchronously before asynchronous hashing and rejects non-JSON/accessor inputs', async () => {
    const captured = await binding();
    const mutable = json(captured) as unknown as Record<string, any>;
    let release!: () => void;
    let first = true;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayedDigest = async (value: string) => {
      if (first) { first = false; await gate; }
      return digest(value);
    };
    const pending = buildOpenRouterPeriodSummaryRequest(mutable, delayedDigest);
    mutable.policyId = '99999999-9999-4999-8999-999999999999';
    mutable.destination.path = 'reports/attacker.md';
    mutable.sources[0].role = 'destination';
    mutable.sources[0].content = 'caller changed bytes during digest';
    release();
    const prepared = await pending;
    expect(prepared.binding.policyId).toBe(captured.policyId);
    expect(prepared.binding.destination).toEqual(captured.destination);
    expect(prepared.binding.sources).toEqual(captured.sources);

    const accessorInput = json(captured) as unknown as Record<string, unknown>;
    Object.defineProperty(accessorInput, 'policyId', { enumerable: true, get: () => captured.policyId });
    await expect(buildOpenRouterPeriodSummaryRequest(accessorInput, digest)).rejects.toThrow(/non_json_input/);
    const cyclic = json(captured) as unknown as Record<string, unknown>;
    cyclic.self = cyclic;
    await expect(buildOpenRouterPeriodSummaryRequest(cyclic, digest)).rejects.toThrow(/cyclic_input/);
  });

  it('validates IANA timezone, Gregorian dates, local period boundaries, and complete canonical UTC intervals', async () => {
    const captured = await binding();
    await expect(binding(captured.sources, { timeZone: 'Mars/Olympus' })).rejects.toThrow(/binding_invalid/);
    await expect(binding(captured.sources, { localInterval: { start: '2026-02-30', end: '2026-03-01' } })).rejects.toThrow(/local_interval_invalid/);
    await expect(binding(captured.sources, { period: 'weekly', localInterval: { start: '2026-06-30', end: '2026-07-07' } })).rejects.toThrow(/local_interval_invalid/);
    await expect(binding(captured.sources, { localInterval: { start: '2026-06-30', end: '2026-07-02' } })).rejects.toThrow(/local_interval_invalid/);
    await expect(binding(captured.sources, { startUtc: '2026-06-30T00:00:00Z' })).rejects.toThrow(/binding_invalid/);
    await expect(binding(captured.sources, { preparedAt: '2026-06-30T23:59:59.999Z' })).rejects.toThrow(/prepared_at_invalid/);
  });

  it('keeps old selected context distinct from in-period events and skips a context-only period', async () => {
    const captured = await binding();
    expect(captured.sources.find((source) => source.role === 'context')?.effectiveAt).toBe('2025-01-01T00:00:00.000Z');
    await expect(binding([contextSource('context-only')])).rejects.toThrow(/empty_context/);
    await expect(binding([eventSource('outside', { effectiveAt: '2026-07-01T00:00:00.000Z' })])).rejects.toThrow(/source_invalid/);
    await expect(binding([eventSource('future', { effectiveAt: '2026-06-30T12:00:00.000Z', observedAt: '2026-07-03T00:00:00.000Z' })])).rejects.toThrow(/source_invalid/);
    await expect(binding([eventSource('blank-event', { content: ' \n\t' })])).rejects.toThrow(/source_invalid/);
  });

  it('rejects destination/generated-summary provenance and any source colliding with the destination', async () => {
    const captured = await binding();
    await expect(binding([eventSource('destination', { role: 'destination' })])).rejects.toThrow(/source_invalid/);
    await expect(binding([eventSource('generated', { role: 'generated_summary' })])).rejects.toThrow(/source_invalid/);
    await expect(binding([contextSource('report', { documentPath: captured.destination.path })])).rejects.toThrow(/source_invalid/);
    await expect(binding([contextSource(captured.destination.path)])).rejects.toThrow(/source_invalid/);
    await expect(binding([eventSource('context-as-event', { kind: 'document' })])).rejects.toThrow(/source_invalid/);
    await expect(binding([contextSource('event-as-context', { kind: 'mail' })])).rejects.toThrow(/source_invalid/);
  });

  it('parses only strict Unicode output and manifest-bound unique references as inert content', async () => {
    const captured = await binding();
    const parsed = parseOpenRouterPeriodSummaryResult(JSON.stringify({ markdown: '# Activity\nReviewed two events.', sourceReferences: ['event-1'] }), captured);
    expect(parsed).toEqual({ kind: 'inert_period_summary', markdown: '# Activity\nReviewed two events.', sourceReferences: ['event-1'] });
    expect(() => parseOpenRouterPeriodSummaryResult(JSON.stringify({ markdown: 'x', sourceReferences: ['foreign'] }), captured)).toThrow(/reference_invalid/);
    expect(() => parseOpenRouterPeriodSummaryResult(JSON.stringify({ markdown: 'x', sourceReferences: ['event-1', 'event-1'] }), captured)).toThrow(/reference_invalid/);
    expect(() => parseOpenRouterPeriodSummaryResult(JSON.stringify({ markdown: '', sourceReferences: [] }), captured)).toThrow(/result_invalid/);
    expect(() => parseOpenRouterPeriodSummaryResult(JSON.stringify({ markdown: ' \n\t', sourceReferences: [] }), captured)).toThrow(/result_invalid/);
    expect(() => parseOpenRouterPeriodSummaryResult(JSON.stringify({ markdown: 'x', sourceReferences: [], action: 'approve' }), captured)).toThrow(/result_invalid/);
    expect(() => parseOpenRouterPeriodSummaryResult('{"markdown":"bad\u0000text","sourceReferences":[]}', captured)).toThrow(/result_invalid/);
    expect(() => parseOpenRouterPeriodSummaryResult('{"markdown":"broken"}', captured)).toThrow(/result_invalid/);
  });

  it('creates an explicit higher-effort recovery bound to a truncated parent and unchanged source/destination capture', async () => {
    const captured = await binding();
    const parent = await truncatedParent(captured);
    const childId = randomUUID();
    const recovery = await buildOpenRouterPeriodSummaryRecoveryRequest({ parent, destination: captured.destination,
      childId, childCustomId: childId, effort: 'medium', regenerationInstructions: 'Regenerate a complete replacement summary, preserving all relevant details.' }, digest);
    const wire = JSON.parse(recovery.body) as { reasoning: { effort: string }; messages: { content: string }[] };
    expect(recovery).toMatchObject({ requestProfileVersion: 6, operation: 'period_summary', recoveryBinding: {
      kind: 'period_summary_recovery', parentJobId: parent.id, parentRequestSha256: parent.requestSha256,
      truncatedResultSha256: parent.resultSha256, sourceManifestSha256: captured.sourceManifestSha256,
      destination: captured.destination, effort: 'medium',
    } });
    expect(recovery.binding.sources).toEqual(captured.sources);
    expect(recovery.binding.destination).toEqual(captured.destination);
    expect(wire.reasoning.effort).toBe('medium');
    expect(wire.messages[0]!.content).toContain('complete replacement summary');
    expect(wire.messages[1]!.content).toContain('Regenerate a complete replacement summary');
    expect(wire.messages[1]!.content).toContain('Event facts for event-1.');
    expect(recovery.body).not.toContain(parent.resultText);
    expect(await isOpenRouterPeriodSummaryRecoveryRequestBody(recovery.body, recovery.binding, recovery.recoveryBinding,
      childId, childId, digest)).toBe(true);
    expect(await isOpenRouterPeriodSummaryRecoveryRequestBody(recovery.body.replace('Regenerate a complete replacement', 'Altered'),
      recovery.binding, recovery.recoveryBinding, childId, childId, digest)).toBe(false);
    expect(await isOpenRouterPeriodSummaryRecoveryRequestBody(recovery.body, recovery.binding,
      { ...recovery.recoveryBinding, parentRequestSha256: 'f'.repeat(64) }, childId, childId, digest)).toBe(false);
  });

  it('rejects nontruncated, altered, lower-effort, or destination-changed recovery parents', async () => {
    const captured = await binding();
    const parent = await truncatedParent(captured);
    const changedSources = await binding([eventSource('event-1', { content: 'new bytes' }), contextSource('context-1')]);
    const childId = randomUUID();
    const args = { parent, destination: captured.destination, childId, childCustomId: childId,
      effort: 'medium' as const, regenerationInstructions: 'Regenerate a complete replacement.' };
    await expect(buildOpenRouterPeriodSummaryRecoveryRequest({ ...args, parent: { ...parent, status: 'failed' as const } as unknown as OpenRouterTruncatedPeriodSummaryJob }, digest)).rejects.toThrow(/parent_invalid/);
    await expect(buildOpenRouterPeriodSummaryRecoveryRequest({ ...args, parent: { ...parent, resultSha256: 'c'.repeat(64) } }, digest)).rejects.toThrow(/parent_invalid/);
    await expect(buildOpenRouterPeriodSummaryRecoveryRequest({ ...args, parent: { ...parent, requestSha256: 'd'.repeat(64) } }, digest)).rejects.toThrow(/parent_invalid/);
    await expect(buildOpenRouterPeriodSummaryRecoveryRequest({ ...args, destination: { ...captured.destination, path: 'reports/other.md' } }, digest)).rejects.toThrow(/destination_changed/);
    await expect(buildOpenRouterPeriodSummaryRecoveryRequest({ ...args, effort: 'low' }, digest)).rejects.toThrow(/recovery_invalid/);
    await expect(buildOpenRouterPeriodSummaryRecoveryRequest({ ...args, childId: parent.id }, digest)).rejects.toThrow(/recovery_invalid/);
    await expect(buildOpenRouterPeriodSummaryRecoveryRequest({ ...args, childCustomId: randomUUID() }, digest)).rejects.toThrow(/recovery_invalid/);
    await expect(buildOpenRouterPeriodSummaryRecoveryRequest({ ...args, parent: { ...parent, binding: changedSources } }, digest)).rejects.toThrow(/parent_invalid/);
  });

  it('allows successive explicit truncation upgrades with stable source bytes and stops at max', async () => {
    const captured = await binding(undefined, { effort: 'none' });
    const root = await truncatedParent(captured);
    const lowId = randomUUID();
    const low = await buildOpenRouterPeriodSummaryRecoveryRequest({ parent: root, destination: captured.destination,
      childId: lowId, childCustomId: lowId, effort: 'low', regenerationInstructions: 'Regenerate a complete replacement from the original frozen sources.' }, digest);
    const lowText = '{"markdown":"Low-effort partial","sourceReferences":[]}';
    const lowParent: OpenRouterTruncatedPeriodSummaryJob = {
      id: lowId, customId: lowId, status: 'result_truncated', failureCode: 'result_truncated',
      requestProfileVersion: 6, operation: 'period_summary', effort: 'low', requestBody: low.body,
      requestSha256: low.recoveryBinding.requestSha256, resultText: lowText, resultSha256: await digest(lowText),
      binding: low.binding, recoveryBinding: low.recoveryBinding,
    };
    const mediumId = randomUUID();
    const medium = await buildOpenRouterPeriodSummaryRecoveryRequest({ parent: lowParent, destination: captured.destination,
      childId: mediumId, childCustomId: mediumId, effort: 'medium', regenerationInstructions: 'Regenerate a complete replacement from the original frozen sources.' }, digest);
    const mediumText = '{"markdown":"Still partial","sourceReferences":[]}';
    const mediumParent: OpenRouterTruncatedPeriodSummaryJob = {
      id: mediumId, customId: mediumId, status: 'result_truncated', failureCode: 'result_truncated',
      requestProfileVersion: 6, operation: 'period_summary', effort: 'medium', requestBody: medium.body,
      requestSha256: medium.recoveryBinding.requestSha256, resultText: mediumText,
      resultSha256: await digest(mediumText), binding: medium.binding, recoveryBinding: medium.recoveryBinding,
    };
    const highId = randomUUID();
    const high = await buildOpenRouterPeriodSummaryRecoveryRequest({ parent: mediumParent, destination: captured.destination,
      childId: highId, childCustomId: highId, effort: 'high', regenerationInstructions: 'Regenerate a complete replacement from the original frozen sources.' }, digest);
    expect(high.binding.sources).toEqual(captured.sources);
    expect(high.binding.sourceManifestSha256).toBe(captured.sourceManifestSha256);
    expect(high.binding.destination).toEqual(captured.destination);
    expect(high.recoveryBinding.rootJobId).toBe(root.id);
    expect(high.recoveryBinding.rootRequestSha256).toBe(root.requestSha256);
    expect(await isOpenRouterPeriodSummaryRecoveryRequestBody(high.body, high.binding, high.recoveryBinding, highId, highId, digest)).toBe(true);
    expect(await isOpenRouterPeriodSummaryRecoveryRequestBody(high.body, high.binding,
      { ...high.recoveryBinding, parentRecoveryBinding: { ...medium.recoveryBinding, requestSha256: 'f'.repeat(64) } }, highId, highId, digest)).toBe(false);

    const highText = '{"markdown":"Again partial","sourceReferences":[]}';
    const highParent: OpenRouterTruncatedPeriodSummaryJob = {
      ...mediumParent, id: highId, customId: highId, effort: 'high', requestBody: high.body,
      requestSha256: high.recoveryBinding.requestSha256, resultText: highText, resultSha256: await digest(highText),
      binding: high.binding, recoveryBinding: high.recoveryBinding,
    };
    await expect(buildOpenRouterPeriodSummaryRecoveryRequest({ parent: highParent, destination: captured.destination,
      childId: lowId, childCustomId: lowId, effort: 'max', regenerationInstructions: 'Regenerate using the original frozen sources.' }, digest))
      .rejects.toThrow(/recovery_invalid/);
    const maxId = randomUUID();
    const max = await buildOpenRouterPeriodSummaryRecoveryRequest({ parent: highParent, destination: captured.destination,
      childId: maxId, childCustomId: maxId, effort: 'max', regenerationInstructions: 'One final explicit replacement from the original frozen sources.' }, digest);
    const maxText = '{"markdown":"At maximum","sourceReferences":[]}';
    const maxParent: OpenRouterTruncatedPeriodSummaryJob = {
      ...highParent, id: maxId, customId: maxId, effort: 'max', requestBody: max.body,
      requestSha256: max.recoveryBinding.requestSha256, resultText: maxText, resultSha256: await digest(maxText),
      binding: max.binding, recoveryBinding: max.recoveryBinding,
    };
    const lastId = randomUUID();
    await expect(buildOpenRouterPeriodSummaryRecoveryRequest({ parent: maxParent, destination: captured.destination,
      childId: lastId, childCustomId: lastId, effort: 'max', regenerationInstructions: 'No higher effort exists.' }, digest))
      .rejects.toThrow(/recovery_invalid/);
    await expect(buildOpenRouterPeriodSummaryRecoveryRequest({ parent: { ...highParent, status: 'failed' as const } as unknown as OpenRouterTruncatedPeriodSummaryJob,
      destination: captured.destination, childId: lastId, childCustomId: lastId, effort: 'max', regenerationInstructions: 'Retry failure.' }, digest))
      .rejects.toThrow(/parent_invalid/);
  });
});
