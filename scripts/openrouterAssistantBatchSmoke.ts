import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, mkdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { AppSettings, Note } from '../src/core';
import { validateAssistantResponseV2 } from '../src/assistant';
import { OPENROUTER_BATCH_MODEL, OPENROUTER_BATCH_NOTE_RESPONSE_PROFILE_VERSION, OpenRouterBatchClient, OpenRouterBatchDispatchError, OpenRouterBatchRequestBuilder, type OpenRouterBatchInspection } from '../src/services/openRouter';

export const ASSISTANT_BATCH_SMOKE_TEST_NAME = 'openrouter assistant batch smoke';
export const ASSISTANT_BATCH_SMOKE_MAX_JOURNAL_BYTES = 16 * 1024;
const JOURNAL_VERSION = 1;
const JOURNAL_STATUSES = new Set(['submission_unknown', 'submitted', 'validating', 'in_progress', 'finalizing', 'completed', 'failed', 'expired', 'cancelling', 'cancelled']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const appData = process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local');

export const DEFAULT_ASSISTANT_BATCH_SMOKE_KEY_PATH = resolve(appData, 'Still', 'openrouter-api-key.txt');
export const DEFAULT_ASSISTANT_BATCH_SMOKE_JOURNAL_PATH = resolve(appData, 'Still', 'openrouter-assistant-v2-smoke.json');

export function isAssistantBatchSmokeOptedIn(env: Readonly<Record<string, string | undefined>>, testName: string): boolean {
  return env.STILL_OPENROUTER_ASSISTANT_BATCH_SMOKE === 'RUN_ONCE' &&
    env.STILL_OPENROUTER_ASSISTANT_BATCH_CONFIG === 'scripts/vitest.openrouter-assistant-batch.config.ts' &&
    env.STILL_OPENROUTER_ASSISTANT_BATCH_PROFILE === '2' && testName === ASSISTANT_BATCH_SMOKE_TEST_NAME;
}

export interface AssistantBatchSmokeFileHandle {
  writeFile(data: string, options?: { encoding?: string }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface AssistantBatchSmokeFileSystem {
  readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string>;
  open(path: string, flags: string, mode?: number): Promise<AssistantBatchSmokeFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  stat(path: string): Promise<{ size?: number; isFile(): boolean }>;
}
export interface AssistantBatchSmokePaths { key: string; journal: string; }
export interface AssistantBatchSmokeDependencies {
  readonly mode: 'submit' | 'check';
  readonly fs?: AssistantBatchSmokeFileSystem;
  readonly fetcher?: typeof fetch;
  readonly output?: (line: string) => void;
  readonly paths?: Partial<AssistantBatchSmokePaths>;
  readonly now?: () => Date;
  readonly uuid?: () => string;
  readonly testName?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}
export interface AssistantBatchSmokeResult {
  readonly status: 'gated' | 'precondition_unavailable' | 'existing_intent' | 'submission_unknown' | 'submitted' | 'validating' | 'in_progress' | 'finalizing' | 'completed' | 'failed' | 'expired' | 'cancelling' | 'cancelled' | 'not_verified';
  readonly code?: 'not_opted_in' | 'invalid_mode' | 'journal_exists' | 'journal_invalid' | 'journal_unavailable' | 'credential_unavailable' | 'journal_write_failed' | 'journal_update_failed' | 'request_invalid' | 'provider_unknown' | 'check_unavailable';
  readonly httpStatus?: number;
  readonly requestProfileVersion?: 2;
  readonly modelValidated?: boolean;
  readonly strictSchemaValidated?: boolean;
  readonly assistantResultValidated?: boolean;
  readonly intendedReplyMatched?: boolean;
  readonly usage?: Readonly<{ cost?: number; isByok?: boolean; promptTokens?: number; completionTokens?: number; totalTokens?: number }>;
}

interface SmokeJournal {
  readonly version: 1;
  readonly status: AssistantBatchSmokeResult['status'];
  readonly createdAt: string;
  readonly checkedAt?: string;
  readonly requestProfileVersion: 2;
  readonly model: typeof OPENROUTER_BATCH_MODEL;
  readonly endpoint: '/v1/chat/completions';
  readonly requestCount: 1;
  readonly customId: string;
  readonly requestSha256: string;
  readonly timezone: string;
  readonly batchId?: string;
  readonly httpStatus?: number;
  readonly modelValidated?: boolean;
  readonly strictSchemaValidated?: boolean;
  readonly assistantResultValidated?: boolean;
  readonly intendedReplyMatched?: boolean;
  readonly usage?: AssistantBatchSmokeResult['usage'];
}

const nodeFs: AssistantBatchSmokeFileSystem = {
  async readFile(path, encoding) {
    if (encoding === 'utf8') return readFile(path, { encoding: 'utf8' });
    const bytes = await readFile(path);
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  },
  async open(path, flags, mode) {
    const handle = await open(path, flags, mode);
    return {
      async writeFile(data, options) { await handle.writeFile(data, { encoding: options?.encoding as BufferEncoding | undefined }); },
      async sync() { await handle.sync(); },
      async close() { await handle.close(); },
    };
  },
  async rename(from, to) { await rename(from, to); },
  async unlink(path) { await unlink(path); },
  async mkdir(path, options) { await mkdir(path, options); },
  async stat(path) { return stat(path); },
};

/** One explicit fictional Batch submit, or one explicit read of its confirmed saved batch. */
export async function runOpenRouterAssistantBatchSmoke(deps: AssistantBatchSmokeDependencies): Promise<AssistantBatchSmokeResult> {
  const output = deps.output ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = deps.env ?? process.env;
  const testName = deps.testName ?? ASSISTANT_BATCH_SMOKE_TEST_NAME;
  if (!isAssistantBatchSmokeOptedIn(env, testName)) return report(output, { status: 'gated', code: 'not_opted_in' });
  if (deps.mode !== 'submit' && deps.mode !== 'check') return report(output, { status: 'gated', code: 'invalid_mode' });
  const fs = deps.fs ?? nodeFs;
  const paths: AssistantBatchSmokePaths = {
    key: deps.paths?.key ?? DEFAULT_ASSISTANT_BATCH_SMOKE_KEY_PATH,
    journal: deps.paths?.journal ?? DEFAULT_ASSISTANT_BATCH_SMOKE_JOURNAL_PATH,
  };
  const uuid = deps.uuid ?? randomUUID;
  const now = deps.now ?? (() => new Date());

  if (deps.mode === 'submit') {
    try {
      if (await exists(fs, paths.journal)) return report(output, { status: 'existing_intent', code: 'journal_exists' });
    } catch { return report(output, { status: 'precondition_unavailable', code: 'journal_unavailable' }); }
    const createdAt = canonicalIso(now());
    if (!createdAt) return report(output, { status: 'precondition_unavailable', code: 'request_invalid' });
    const customId = uuid();
    if (!isUuidV4(customId)) return report(output, { status: 'precondition_unavailable', code: 'request_invalid' });

    let key: string;
    const settings = smokeSettings();
    let prepared: Awaited<ReturnType<OpenRouterBatchRequestBuilder['prepareAnalysis']>>;
    try {
      key = decodeKey(await readBounded(fs, paths.key, 8192));
      prepared = await prepareSyntheticRequest(createdAt, settings.timezone);
    } catch {
      return report(output, { status: 'precondition_unavailable', code: 'credential_unavailable' });
    }
    const requestSha256 = sha256Hex(prepared.body);
    const intent: SmokeJournal = {
      version: JOURNAL_VERSION, status: 'submission_unknown', createdAt, requestProfileVersion: 2,
      model: OPENROUTER_BATCH_MODEL, endpoint: '/v1/chat/completions', requestCount: 1,
      customId, requestSha256, timezone: settings.timezone,
    };
    if (!requestHasNoOutputQuota(prepared.body)) return report(output, { status: 'precondition_unavailable', code: 'request_invalid' });
    try {
      await fs.mkdir(dirname(paths.journal), { recursive: true });
      await writeExclusive(fs, paths.journal, intent);
    } catch (error) {
      return report(output, { status: isExists(error) ? 'existing_intent' : 'precondition_unavailable', code: isExists(error) ? 'journal_exists' : 'journal_write_failed' });
    }
    let observedHttp: number | undefined;
    const client = createClient(key, deps.fetcher, (status) => { observedHttp = status; });
    let result: AssistantBatchSmokeResult;
    try {
      const ack = await client.submit({ operationId: customId, requestBody: prepared.body, requestProfileVersion: 2 }, async () => undefined);
      const checkedAt = canonicalIso(now());
      if (!checkedAt) return report(output, { status: 'submission_unknown', code: 'journal_update_failed', httpStatus: observedHttp, requestProfileVersion: 2 });
      const submitted: SmokeJournal = { ...intent, status: ack.status, batchId: ack.batchId, checkedAt, httpStatus: observedHttp };
      await replaceAtomically(fs, paths.journal, submitted, uuid);
      result = { status: ack.status, httpStatus: observedHttp, requestProfileVersion: 2 };
    } catch (error) {
      result = { status: 'submission_unknown', code: error instanceof OpenRouterBatchDispatchError && error.phase === 'pre_dispatch' ? 'request_invalid' : 'provider_unknown', httpStatus: observedHttp, requestProfileVersion: 2 };
      // The exclusive submission_unknown intent is deliberately retained after any failure.
    }
    return report(output, result);
  }

  let journal: SmokeJournal;
  try { journal = await readJournal(fs, paths.journal); }
  catch { return report(output, { status: 'precondition_unavailable', code: 'journal_invalid' }); }
  if (!journal.batchId || journal.status === 'submission_unknown') return report(output, { status: 'submission_unknown', code: 'journal_invalid', requestProfileVersion: 2 });
  let key: string;
  try { key = decodeKey(await readBounded(fs, paths.key, 8192)); }
  catch { return report(output, { status: 'precondition_unavailable', code: 'credential_unavailable', requestProfileVersion: 2 }); }
  let prepared: Awaited<ReturnType<OpenRouterBatchRequestBuilder['prepareAnalysis']>>;
  try { prepared = await prepareSyntheticRequest(journal.createdAt, journal.timezone); }
  catch { return report(output, { status: 'precondition_unavailable', code: 'request_invalid', requestProfileVersion: 2 }); }
  if (sha256Hex(prepared.body) !== journal.requestSha256) return report(output, { status: 'precondition_unavailable', code: 'journal_invalid', requestProfileVersion: 2 });
  let observedHttp: number | undefined;
  const client = createClient(key, deps.fetcher, (status) => { observedHttp = status; });
  try {
    const inspection = await client.inspect(journal.batchId, journal.customId);
    const validation = validateAssistantInspection(inspection, prepared);
    const checkedAt = canonicalIso(now());
    if (!checkedAt) return report(output, { status: 'precondition_unavailable', code: 'journal_update_failed', requestProfileVersion: 2 });
    const updated: SmokeJournal = {
      ...journal, status: inspection.status, checkedAt, httpStatus: observedHttp,
      modelValidated: validation.modelValidated,
      strictSchemaValidated: validation.strictSchemaValidated,
      assistantResultValidated: validation.assistantResultValidated,
      intendedReplyMatched: validation.intendedReplyMatched,
      ...(inspection.usage ? { usage: safeUsage(inspection.usage) } : {}),
    };
    await replaceAtomically(fs, paths.journal, updated, uuid);
    return report(output, {
      status: inspection.status, httpStatus: observedHttp, requestProfileVersion: 2,
      ...validation, ...(inspection.usage ? { usage: safeUsage(inspection.usage) } : {}),
    });
  } catch {
    const checkedAt = canonicalIso(now());
    if (checkedAt) await tryUpdate(fs, paths.journal, { ...journal, checkedAt, ...(observedHttp !== undefined ? { httpStatus: observedHttp } : {}) }, uuid);
    return report(output, { status: 'precondition_unavailable', code: 'check_unavailable', httpStatus: observedHttp, requestProfileVersion: 2 });
  }
}

function createClient(key: string, fetcher: typeof fetch | undefined, onHttp: (status: number) => void): OpenRouterBatchClient {
  const observedFetch: typeof fetch = async (input, init) => {
    const response = await (fetcher ?? fetch)(input, init);
    if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) onHttp(response.status);
    return response;
  };
  return new OpenRouterBatchClient({
    fetcher: observedFetch,
    withRequestOwnership: (actual) => actual(),
    readCredentialSnapshot: async () => ({ key, generation: 1 }),
    assertCredentialGeneration: () => undefined,
    assertBeforeStart: () => undefined,
  });
}

function validateAssistantInspection(inspection: OpenRouterBatchInspection, prepared: Awaited<ReturnType<OpenRouterBatchRequestBuilder['prepareAnalysis']>>): Pick<AssistantBatchSmokeResult, 'modelValidated' | 'strictSchemaValidated' | 'assistantResultValidated' | 'intendedReplyMatched'> {
  const body = inspection.result?.responseBody;
  if (!body || inspection.status !== 'completed' || inspection.metadataValidation !== 'valid' || inspection.resultValidation !== 'valid' || inspection.total !== 1 || inspection.completed !== 1 || inspection.failed !== 0 || inspection.result.statusCode !== 200 || inspection.result.finishReason !== 'stop' || inspection.result.errorPresent) {
    return { modelValidated: false, strictSchemaValidated: false, assistantResultValidated: false, intendedReplyMatched: false };
  }
  const row = object(body);
  const modelValidated = row?.model === 'openai/gpt-6-luna' || row?.model === 'openai/gpt-6-luna-20260922';
  const choices = Array.isArray(row?.choices) ? row.choices : [];
  const message = object(object(choices[0])?.message);
  if (!modelValidated || typeof message?.content !== 'string' || message.refusal !== undefined || choices.length !== 1 || object(choices[0])?.index !== 0 || object(choices[0])?.finish_reason !== 'stop' || message.role !== 'assistant') return { modelValidated, strictSchemaValidated: false, assistantResultValidated: false, intendedReplyMatched: false };
  let parsed: unknown;
  try { parsed = JSON.parse(message.content); } catch { return { modelValidated, strictSchemaValidated: false, assistantResultValidated: false, intendedReplyMatched: false }; }
  const parsedRow = object(parsed);
  if (!parsedRow || Object.keys(parsedRow).sort().join(',') !== 'answer,citations,clarifications,decisions,memorySuggestions,proposals,summary') {
    return { modelValidated, strictSchemaValidated: false, assistantResultValidated: false, intendedReplyMatched: false };
  }
  try {
    validateAssistantResponseV2(parsed, prepared.catalog, prepared.selection);
    const intendedReplyMatched = parsedRow.answer === 'READY' &&
      Array.isArray(parsedRow.decisions) && parsedRow.decisions.length === 0 &&
      Array.isArray(parsedRow.citations) && parsedRow.citations.length === 0 &&
      Array.isArray(parsedRow.clarifications) && parsedRow.clarifications.length === 0 &&
      Array.isArray(parsedRow.proposals) && parsedRow.proposals.length === 0 &&
      Array.isArray(parsedRow.memorySuggestions) && parsedRow.memorySuggestions.length === 0;
    return { modelValidated, strictSchemaValidated: true, assistantResultValidated: true, intendedReplyMatched };
  } catch {
    return { modelValidated, strictSchemaValidated: false, assistantResultValidated: false, intendedReplyMatched: false };
  }
}

async function prepareSyntheticRequest(createdAt: string, timezone: string): Promise<Awaited<ReturnType<OpenRouterBatchRequestBuilder['prepareAnalysis']>>> {
  if (!isCanonicalIso(createdAt)) throw new Error('invalid_time');
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  const settings = { ...smokeSettings(), timezone };
  const note: Note = {
    id: '7c62e5ad-cdb4-4a1d-994e-6fd8fdc8dc61', title: 'Chat message',
    transcript: 'This is a fictional local readiness message. Set the answer field to the exact string READY. Return empty proposals, decisions, citations, clarifications, and memory suggestions.',
    durationSeconds: 0, createdAt, capturedAt: createdAt, captureTimeZone: timezone, origin: 'assistant_chat', status: 'recorded', revision: 1,
  };
  return new OpenRouterBatchRequestBuilder().prepareAnalysis(note, [], settings, {
    intent: 'answer', question: 'Respond to the current user message.', chatMode: true,
  }, OPENROUTER_BATCH_NOTE_RESPONSE_PROFILE_VERSION);
}

function requestHasNoOutputQuota(serialized: string): boolean {
  const row = object(JSON.parse(serialized));
  return !!row && !Object.keys(row).some((key) => ['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'budget_tokens'].includes(key));
}

function smokeSettings(): AppSettings {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  new Intl.DateTimeFormat('en', { timeZone: timezone });
  return {
    mode: 'provider', llmProvider: 'openrouter', openRouterModel: OPENROUTER_BATCH_MODEL,
    openRouterReasoningEffort: 'low', llmRequestContractVersion: 1, timezone,
    maxContextTokens: 1000, maxRequestBytes: 64 * 1024, maxOutputTokens: 512,
    monthlyBudgetUsd: 0, reasoningEffort: 'low', maxAttempts: 1, maxCallsPerDay: 1,
    maxAudioSeconds: 600, audioRetention: 'keep',
  };
}

function safeUsage(usage: NonNullable<OpenRouterBatchInspection['usage']>): NonNullable<AssistantBatchSmokeResult['usage']> {
  return Object.freeze({
    ...(typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? { cost: usage.cost } : {}),
    ...(typeof usage.isByok === 'boolean' ? { isByok: usage.isByok } : {}),
    ...(Number.isSafeInteger(usage.promptTokens) && (usage.promptTokens ?? -1) >= 0 ? { promptTokens: usage.promptTokens } : {}),
    ...(Number.isSafeInteger(usage.completionTokens) && (usage.completionTokens ?? -1) >= 0 ? { completionTokens: usage.completionTokens } : {}),
    ...(Number.isSafeInteger(usage.totalTokens) && (usage.totalTokens ?? -1) >= 0 ? { totalTokens: usage.totalTokens } : {}),
  });
}

function safeJournal(value: unknown): SmokeJournal | undefined {
  const row = object(value);
  if (!row || Object.keys(row).some((key) => !['version', 'status', 'createdAt', 'checkedAt', 'requestProfileVersion', 'model', 'endpoint', 'requestCount', 'customId', 'requestSha256', 'timezone', 'batchId', 'httpStatus', 'modelValidated', 'strictSchemaValidated', 'assistantResultValidated', 'intendedReplyMatched', 'usage'].includes(key))) return undefined;
  if (row.version !== 1 || typeof row.status !== 'string' || !JOURNAL_STATUSES.has(row.status) || !isCanonicalIso(row.createdAt) || row.requestProfileVersion !== 2 || row.model !== OPENROUTER_BATCH_MODEL || row.endpoint !== '/v1/chat/completions' || row.requestCount !== 1 || !isUuidV4(row.customId) || typeof row.requestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.requestSha256) || typeof row.timezone !== 'string' || row.timezone.length > 100) return undefined;
  if (row.checkedAt !== undefined && !isCanonicalIso(row.checkedAt)) return undefined;
  if (row.batchId !== undefined && (typeof row.batchId !== 'string' || !OPAQUE_ID.test(row.batchId))) return undefined;
  if (row.status !== 'submission_unknown' && typeof row.batchId !== 'string') return undefined;
  if (row.httpStatus !== undefined && (!Number.isSafeInteger(row.httpStatus) || (row.httpStatus as number) < 100 || (row.httpStatus as number) > 599)) return undefined;
  for (const key of ['modelValidated', 'strictSchemaValidated', 'assistantResultValidated', 'intendedReplyMatched'] as const) if (row[key] !== undefined && typeof row[key] !== 'boolean') return undefined;
  const usageRow = row.usage === undefined ? undefined : object(row.usage);
  if (row.usage !== undefined && (!usageRow || Object.keys(usageRow).some((key) => !['cost', 'isByok', 'promptTokens', 'completionTokens', 'totalTokens'].includes(key)))) return undefined;
  if (usageRow && ((usageRow.cost !== undefined && (typeof usageRow.cost !== 'number' || !Number.isFinite(usageRow.cost) || usageRow.cost < 0)) ||
      (usageRow.isByok !== undefined && typeof usageRow.isByok !== 'boolean') ||
      [usageRow.promptTokens, usageRow.completionTokens, usageRow.totalTokens].some((count) => count !== undefined && (!Number.isSafeInteger(count) || (count as number) < 0)))) return undefined;
  const usage = usageRow ? safeUsage(usageRow as NonNullable<OpenRouterBatchInspection['usage']>) : undefined;
  return Object.freeze({ ...row, ...(usage ? { usage } : {}) }) as unknown as SmokeJournal;
}

async function readJournal(fs: AssistantBatchSmokeFileSystem, path: string): Promise<SmokeJournal> {
  const bytes = await readBounded(fs, path, ASSISTANT_BATCH_SMOKE_MAX_JOURNAL_BYTES);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  const journal = safeJournal(parsed);
  if (!journal) throw new Error('invalid_journal');
  return journal;
}
async function readBounded(fs: AssistantBatchSmokeFileSystem, path: string, max: number): Promise<Uint8Array> {
  const value = await fs.readFile(path);
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > max) throw new Error('bounded_read_failed');
  return bytes;
}
function decodeKey(bytes: Uint8Array): string {
  const key = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  if (!key || /[\r\n]/.test(key)) throw new Error('credential_unavailable');
  return key;
}
async function writeExclusive(fs: AssistantBatchSmokeFileSystem, path: string, value: unknown): Promise<void> {
  const handle = await fs.open(path, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: 'utf8' }); await handle.sync(); }
  finally { await handle.close(); }
}
async function replaceAtomically(fs: AssistantBatchSmokeFileSystem, path: string, value: unknown, uuid: () => string): Promise<void> {
  const temp = `${path}.${uuid()}.tmp`;
  let handle: AssistantBatchSmokeFileHandle | undefined;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: 'utf8' }); await handle.sync(); await handle.close(); handle = undefined;
    await fs.rename(temp, path);
  } catch { if (handle) await handle.close().catch(() => undefined); await fs.unlink(temp).catch(() => undefined); throw new Error('journal_update_failed'); }
}
async function tryUpdate(fs: AssistantBatchSmokeFileSystem, path: string, value: unknown, uuid: () => string): Promise<void> { try { await replaceAtomically(fs, path, value, uuid); } catch { /* the prior durable journal remains authoritative */ } }
async function exists(fs: AssistantBatchSmokeFileSystem, path: string): Promise<boolean> { try { await fs.stat(path); return true; } catch (error) { if (isMissing(error)) return false; throw error; } }
function report(output: (line: string) => void, value: AssistantBatchSmokeResult): AssistantBatchSmokeResult {
  const safe: Record<string, string | number | boolean> = { status: value.status };
  if (value.code) safe.code = value.code;
  if (value.httpStatus !== undefined) safe.httpStatus = value.httpStatus;
  if (value.requestProfileVersion !== undefined) safe.requestProfileVersion = value.requestProfileVersion;
  for (const key of ['modelValidated', 'strictSchemaValidated', 'assistantResultValidated', 'intendedReplyMatched'] as const) if (value[key] !== undefined) safe[key] = value[key]!;
  if (value.usage) Object.assign(safe, safeUsage(value.usage));
  output(Object.entries(safe).map(([key, val]) => `${key}=${String(val)}`).join(' '));
  return Object.freeze({ ...value, ...(value.usage ? { usage: safeUsage(value.usage) } : {}) });
}
function canonicalIso(date: Date): string | undefined { if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return undefined; return date.toISOString(); }
function isCanonicalIso(value: unknown): value is string { return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function isUuidV4(value: unknown): value is string { return typeof value === 'string' && value.length === 36 && UUID_V4.test(value); }
function sha256Hex(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function isMissing(error: unknown): boolean { return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT'; }
function isExists(error: unknown): boolean { return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'EEXIST'; }
