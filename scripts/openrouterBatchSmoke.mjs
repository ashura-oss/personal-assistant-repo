import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const API_BASE = 'https://openrouter.ai/api/v1';
const MODEL = 'openai/gpt-6-luna';
const CANONICAL_MODEL = 'openai/gpt-6-luna-20260922';
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_JOURNAL_BYTES = 16 * 1024;
const TIMEOUT_MS = 60_000;
const JOURNAL_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH_STATUSES = ['validating', 'in_progress', 'finalizing', 'completed', 'failed', 'cancelling', 'cancelled', 'expired'];

const appData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
export const DEFAULT_KEY_PATH = join(appData, 'Still', 'openrouter-api-key.txt');
export const DEFAULT_JOURNAL_PATH = join(appData, 'Still', 'openrouter-batch-smoke.json');
export const DEFAULT_DIAGNOSTIC_PATH = join(appData, 'Still', 'openrouter-batch-diagnostic.json');

const smokeSchema = {
  type: 'object',
  properties: { ready: { type: 'string', enum: ['READY'] } },
  required: ['ready'],
  additionalProperties: false,
};

export function createSmokeRequest(customId) {
  if (!isUuid(customId)) throw new Error('invalid_request');
  return {
    endpoint: '/v1/chat/completions',
    model: MODEL,
    provider: { only: ['openai'], allow_fallbacks: false },
    completion_window: '24h',
    requests: [{
      custom_id: customId,
      body: {
        messages: [
          { role: 'system', content: 'You are performing a service-readiness check. Return exactly the requested JSON object and nothing else.' },
          { role: 'user', content: 'This is a fictional smoke test. Reply with the JSON value {"ready":"READY"}.' },
        ],
        reasoning: { effort: 'low', exclude: true },
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'still_readiness', strict: true, schema: smokeSchema },
        },
      },
    }],
  };
}

function safeJournal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== JOURNAL_VERSION) return null;
  if (!['submission_unknown', 'submitted', 'validating', 'in_progress', 'finalizing', 'completed', 'failed', 'cancelling', 'cancelled', 'expired'].includes(value.status)) return null;
  if (!isUuid(value.customId)) return null;
  if (value.batchId !== undefined && !isSafeOpaqueId(value.batchId)) return null;
  if (value.status !== 'submission_unknown' && !value.batchId) return null;
  if (value.model !== MODEL || value.requestCount !== 1 || !isCanonicalIso(value.createdAt)) return null;
  if (value.checkedAt !== undefined && !isCanonicalIso(value.checkedAt)) return null;
  return {
    version: JOURNAL_VERSION,
    status: value.status,
    customId: value.customId,
    ...(value.batchId ? { batchId: value.batchId } : {}),
    model: MODEL,
    requestCount: 1,
    createdAt: value.createdAt,
    ...(typeof value.checkedAt === 'string' ? { checkedAt: value.checkedAt } : {}),
  };
}

function safeDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) return null;
  const legacyKeys = new Set(['version', 'sourceCustomId', 'sourceCreatedAt', 'checkedAt', 'candidateIds']);
  const isLegacy = value.status === undefined && Object.keys(value).every((key) => legacyKeys.has(key));
  const status = isLegacy ? 'located' : value.status;
  if (!['locating', 'located', 'verification_unknown', 'verifying', 'verified', 'not_owned'].includes(status)) return null;
  if (!isUuid(value.sourceCustomId) || !isCanonicalIso(value.sourceCreatedAt)) return null;
  if (!isCanonicalIso(value.checkedAt) && status !== 'locating') return null;
  if (!Array.isArray(value.candidateIds) || value.candidateIds.length > 2
      || value.candidateIds.some((id) => !isSafeOpaqueId(id))) return null;
  const unique = [...new Set(value.candidateIds)];
  if (unique.length !== value.candidateIds.length) return null;
  const verification = value.verification;
  if (verification !== undefined) {
    if (!verification || typeof verification !== 'object' || Array.isArray(verification)
        || typeof verification.verifiedRequestOwned !== 'boolean'
        || typeof verification.structuredReadyValidated !== 'boolean'
        || typeof verification.modelVerified !== 'boolean'
        || !['expected_base', 'expected_batch', 'expected_canonical', 'bare_luna', 'other', 'missing'].includes(verification.modelKind)
        || !BATCH_STATUSES.includes(verification.batchStatus)
        || !Number.isSafeInteger(verification.requestCount) || verification.requestCount < 0
        || !isCanonicalIso(verification.checkedAt)) return null;
    for (const field of ['promptTokens', 'completionTokens', 'reasoningTokens']) {
      if (verification[field] !== undefined && (!Number.isSafeInteger(verification[field]) || verification[field] < 0)) return null;
    }
    if (verification.resultModelKind !== undefined
        && !['expected_base', 'expected_batch', 'expected_canonical', 'bare_luna', 'other', 'missing'].includes(verification.resultModelKind)) return null;
    if (verification.costUsd !== undefined && (typeof verification.costUsd !== 'number' || !Number.isFinite(verification.costUsd) || verification.costUsd < 0)) return null;
  }
  return {
    version: 1,
    status,
    sourceCustomId: value.sourceCustomId,
    sourceCreatedAt: value.sourceCreatedAt,
    ...(value.checkedAt ? { checkedAt: value.checkedAt } : {}),
    candidateIds: unique,
    ...(verification ? { verification: { ...verification, resultModelKind: verification.resultModelKind ?? 'missing' } } : {}),
  };
}

function isCanonicalIso(value) {
  if (typeof value !== 'string' || value.length > 32) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isUuid(value) {
  return typeof value === 'string' && value.length === 36 && UUID.test(value);
}

function isSafeOpaqueId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256 && !/[^A-Za-z0-9_-]/.test(value);
}

async function readJournalJson(fs, filePath) {
  const raw = await fs.readFile(filePath);
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw);
  if (bytes.byteLength > MAX_JOURNAL_BYTES) throw new Error('journal_too_large');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Closing a rejected response is best-effort; never expose the rejection.
  }
}

async function readBoundedJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  if (!response || typeof response.status !== 'number') throw new Error('invalid_response');
  const declaredLength = response.headers?.get?.('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await cancelResponseBody(response);
    throw new Error('response_too_large');
  }
  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error('response_too_large');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock?.();
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  } else {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error('response_too_large');
    bytes = new Uint8Array(buffer);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

function createAbortDeadline(milliseconds, AbortControllerImpl = AbortController) {
  const controller = new AbortControllerImpl();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  timer.unref?.();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function beginRequest(fetcher, url, key, body) {
  const deadline = createAbortDeadline(TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: deadline.signal,
      redirect: 'error',
    });
    return { response, clear: deadline.clear };
  } catch (error) {
    deadline.clear();
    throw error;
  }
}

async function writeExclusiveJson(fs, filePath, value) {
  const handle = await fs.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceJsonAtomically(fs, filePath, value, uuid) {
  const temporary = join(dirname(filePath), `.openrouter-batch-${uuid()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, filePath);
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw new Error('journal_write_failed');
  }
}

function safeOutput(out, values) {
  const fields = ['mode', 'status', 'httpStatus', 'model', 'modelKind', 'resultModelKind', 'modelVerified', 'batchStatus', 'requestCount', 'candidateCount', 'idKind', 'idLength', 'matchedCustomId', 'verifiedRequestOwned', 'validatedResult', 'structuredReadyValidated', 'promptTokens', 'completionTokens', 'reasoningTokens', 'costUsd', 'billing'];
  const line = fields.filter((name) => values[name] !== undefined
      && (name !== 'httpStatus' || (Number.isSafeInteger(values[name]) && values[name] >= 100 && values[name] <= 599)))
    .map((name) => `${name}=${String(values[name])}`).join(' ');
  out(`${line}\n`);
}

function safeFieldType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

function safeFieldSummary(value, allowedFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return safeFieldType(value);
  const keys = Object.keys(value);
  const known = keys.filter((name) => allowedFields.has(name)).sort();
  const summary = known.map((name) => `${name}:${safeFieldType(value[name])}`).join(',') || 'none';
  const unknownCount = keys.length - known.length;
  return unknownCount > 0 ? `${summary};unknownFieldCount=${unknownCount}` : summary;
}

function safeCandidateSummary(candidate, index) {
  const id = typeof candidate?.id === 'string' ? candidate.id : '';
  const idKind = classifyProviderId(id);
  const modelInfo = classifyModel(candidate?.model);
  const total = candidate?.request_counts?.total;
  return [
    `candidate${index}Fields=${safeFieldSummary(candidate, new Set(['id', 'status', 'model', 'request_counts', 'endpoint', 'completion_window', 'created_at', 'updated_at', 'expires_at']))}`,
    `candidate${index}IdKind=${idKind}`,
    `candidate${index}IdLength=${id.length}`,
    `candidate${index}ModelKind=${modelInfo.kind}`,
    `candidate${index}ModelLength=${modelInfo.length}`,
    `candidate${index}Status=${BATCH_STATUSES.includes(candidate?.status) ? candidate.status : 'other'}`,
    `candidate${index}RequestCount=${Number.isSafeInteger(total) && total >= 0 ? total : 'unavailable'}`,
  ];
}

function classifyProviderId(value) {
  if (!isSafeOpaqueId(value)) return 'unsafe';
  if (value.startsWith('batch_')) return 'batch_';
  if (value.startsWith('batch-')) return 'batch-';
  if (value.length === 36 && CANONICAL_UUID.test(value)) return 'uuid';
  return 'opaque_safe';
}

function classifyModel(value) {
  if (typeof value !== 'string') return { kind: 'missing', length: 0 };
  if (value === MODEL) return { kind: 'expected_base', length: value.length };
  if (value === 'openai/gpt-6-luna:batch') return { kind: 'expected_batch', length: value.length };
  if (value === CANONICAL_MODEL) return { kind: 'expected_canonical', length: value.length };
  if (value === 'gpt-6-luna') return { kind: 'bare_luna', length: value.length };
  return { kind: 'other', length: value.length };
}

function isExpectedModel(value) {
  return ['expected_base', 'expected_batch', 'expected_canonical'].includes(classifyModel(value).kind);
}

function safeListEnvelope(payload, out, httpStatus) {
  const safeStatus = Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : 'unavailable';
  const summary = [
    'mode=locate',
    'status=unexpected_envelope',
    `httpStatus=${safeStatus}`,
    `envelopeType=${safeFieldType(payload)}`,
    `envelopeFields=${safeFieldSummary(payload, new Set(['data', 'has_more', 'total_count']))}`,
  ];
  out(`${summary.join(' ')}\n`);
}

function validateBatchJob(job, journal) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new Error('invalid_batch');
  if (job.id !== journal.batchId || !['validating', 'in_progress', 'finalizing', 'completed', 'failed', 'cancelling', 'cancelled', 'expired'].includes(job.status)) throw new Error('batch_mismatch');
  if (job.endpoint !== '/v1/chat/completions' || !isExpectedModel(job.model) || job.completion_window !== '24h') throw new Error('batch_mismatch');
  const counts = job.request_counts;
  if (!counts || counts.total !== 1 || !Number.isSafeInteger(counts.completed) || !Number.isSafeInteger(counts.failed) || counts.completed < 0 || counts.failed < 0 || counts.completed + counts.failed > 1) throw new Error('request_count_mismatch');
  if (job.status === 'completed' && (counts.completed !== 1 || counts.failed !== 0)) throw new Error('request_count_mismatch');
  return job;
}

function validateInlineResult(result, journal) {
  if (!result || typeof result !== 'object' || result.custom_id !== journal.customId) throw new Error('custom_id_mismatch');
  if (result.error != null) throw new Error('result_error');
  const response = result.response;
  if (!response || response.status_code !== 200 || !response.body) throw new Error('result_status_mismatch');
  if (!isExpectedModel(response.body.model)) throw new Error('result_model_mismatch');
  const choices = response.body.choices;
  if (!Array.isArray(choices) || choices.length !== 1) throw new Error('choice_count_mismatch');
  const choice = choices[0];
  if (choice.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') throw new Error('result_incomplete');
  const content = JSON.parse(choice.message.content);
  if (!content || typeof content !== 'object' || Array.isArray(content) || content.ready !== 'READY' || Object.keys(content).length !== 1) throw new Error('result_schema_mismatch');
}

function validateOwnedReadyResult(result, expectedCustomId) {
  if (!result || typeof result !== 'object' || result.custom_id !== expectedCustomId || result.error != null) throw new Error('custom_id_mismatch');
  const response = result.response;
  if (!response || response.status_code !== 200 || !response.body || typeof response.body !== 'object') throw new Error('result_status_mismatch');
  const choices = response.body.choices;
  if (!Array.isArray(choices) || choices.length !== 1) throw new Error('choice_count_mismatch');
  const choice = choices[0];
  if (choice.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') throw new Error('result_incomplete');
  const content = JSON.parse(choice.message.content);
  if (!content || typeof content !== 'object' || Array.isArray(content) || content.ready !== 'READY' || Object.keys(content).length !== 1) throw new Error('result_schema_mismatch');
}

function providerAccounting(job) {
  const usage = job?.usage;
  const cost = usage && typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0
    ? usage.cost
    : undefined;
  const billing = usage?.is_byok === true
    ? 'BYOK · OpenRouter fee only; provider inference billed separately'
    : usage?.is_byok === false
      ? 'OpenRouter-reported cost'
      : undefined;
  const safeCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  return {
    costUsd: cost,
    billing,
    promptTokens: safeCount(usage?.prompt_tokens),
    completionTokens: safeCount(usage?.completion_tokens),
    reasoningTokens: safeCount(usage?.reasoning_tokens),
  };
}

export function createOpenRouterBatchSmokeRunner({
  fs = { open, readFile, rename, unlink },
  fetcher = globalThis.fetch,
  keyPath = DEFAULT_KEY_PATH,
  journalPath = DEFAULT_JOURNAL_PATH,
  diagnosticJournalPath = DEFAULT_DIAGNOSTIC_PATH,
  now = () => new Date(),
  uuid = randomUUID,
  out = (text) => process.stdout.write(text),
} = {}) {
  if (typeof fetcher !== 'function') throw new Error('fetch_unavailable');

  const readKey = async () => {
    const value = await fs.readFile(keyPath, 'utf8');
    if (typeof value !== 'string' || value.trim().length < 16 || value.trim().length > 1024 || /[\r\n\0]/.test(value.trim())) throw new Error('credential_unavailable');
    return value.trim();
  };

  return Object.freeze({
    async locate() {
      let journal;
      try { journal = safeJournal(await readJournalJson(fs, journalPath)); }
      catch { journal = null; }
      if (!journal || journal.status !== 'submission_unknown' || journal.batchId) {
        safeOutput(out, { mode: 'locate', status: 'no_unknown_submission_intent' });
        return { status: 'unavailable' };
      }
      let priorDiagnostic = null;
      let hasPriorDiagnostic = false;
      try {
        priorDiagnostic = safeDiagnostic(await readJournalJson(fs, diagnosticJournalPath));
        hasPriorDiagnostic = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          safeOutput(out, { mode: 'locate', status: 'invalid_diagnostic_intent' });
          return { status: 'refused' };
        }
      }
      if (hasPriorDiagnostic && (!priorDiagnostic
          || priorDiagnostic.sourceCustomId !== journal.customId
          || priorDiagnostic.sourceCreatedAt !== journal.createdAt)) {
        safeOutput(out, { mode: 'locate', status: 'diagnostic_source_mismatch' });
        return { status: 'refused' };
      }
      let key;
      try { key = await readKey(); }
      catch { safeOutput(out, { mode: 'locate', status: 'credential_unavailable' }); return { status: 'blocked' }; }

      if (!hasPriorDiagnostic) {
        try {
          await writeExclusiveJson(fs, diagnosticJournalPath, {
            version: 1,
            status: 'locating',
            sourceCustomId: journal.customId,
            sourceCreatedAt: journal.createdAt,
            candidateIds: [],
          });
        } catch {
          safeOutput(out, { mode: 'locate', status: 'existing_diagnostic_intent' });
          return { status: 'refused' };
        }
      }

      const createdAt = new Date(journal.createdAt);
      const after = createdAt.toISOString();
      const before = new Date(createdAt.getTime() + 30_000).toISOString();
      const query = new URLSearchParams({ limit: '2', created_after: after, created_before: before });
      try {
        const { response, clear } = await beginRequest(fetcher, `${API_BASE}/batches?${query.toString()}`, key);
        try {
          if (response.status !== 200) {
            await cancelResponseBody(response);
            safeOutput(out, { mode: 'locate', status: 'status_unavailable', httpStatus: response.status });
            return { status: 'status_unavailable' };
          }
          const payload = await readBoundedJson(response);
          if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.data) || payload.data.length > 2) {
            safeListEnvelope(payload, out, response.status);
            return { status: 'unexpected_envelope' };
          }
          const candidates = payload.data;
          const candidateIds = candidates
            .map((candidate) => candidate?.id)
            .filter((id) => classifyProviderId(id) !== 'unsafe');
          const diagnostic = {
            version: 1,
            status: 'located',
            sourceCustomId: journal.customId,
            sourceCreatedAt: journal.createdAt,
            checkedAt: now().toISOString(),
            candidateIds: candidateIds.slice(0, 2),
          };
          await replaceJsonAtomically(fs, diagnosticJournalPath, diagnostic, uuid);
          const parts = [
            'mode=locate', 'status=located', `httpStatus=${response.status}`,
            `candidateCount=${candidates.length}`, `envelopeFields=${safeFieldSummary(payload, new Set(['data', 'has_more', 'total_count']))}`,
          ];
          candidates.forEach((candidate, index) => parts.push(...safeCandidateSummary(candidate, index + 1)));
          out(`${parts.join(' ')}\n`);
          return { status: 'located', candidateCount: candidates.length, validIdCount: candidateIds.length };
        } finally {
          clear();
        }
      } catch {
        safeOutput(out, { mode: 'locate', status: 'status_unavailable' });
        return { status: 'status_unavailable' };
      }
    },

    async verifyLocated() {
      let journal;
      let diagnostic;
      try {
        journal = safeJournal(await readJournalJson(fs, journalPath));
        diagnostic = safeDiagnostic(await readJournalJson(fs, diagnosticJournalPath));
      } catch {
        journal = null;
        diagnostic = null;
      }
      if (!journal || journal.status !== 'submission_unknown' || journal.batchId || !diagnostic
          || diagnostic.sourceCustomId !== journal.customId || diagnostic.sourceCreatedAt !== journal.createdAt
          || diagnostic.candidateIds.length !== 1) {
        safeOutput(out, { mode: 'verify-located', status: 'precondition_unavailable' });
        return { status: 'unavailable' };
      }
      const candidateId = diagnostic.candidateIds[0];
      const idKind = classifyProviderId(candidateId);
      if (idKind === 'unsafe') {
        safeOutput(out, { mode: 'verify-located', status: 'unsafe_candidate_id' });
        return { status: 'unavailable' };
      }
      let key;
      try { key = await readKey(); }
      catch { safeOutput(out, { mode: 'verify-located', status: 'credential_unavailable' }); return { status: 'blocked' }; }

      try {
        const started = { ...diagnostic, status: 'verifying', checkedAt: now().toISOString() };
        await replaceJsonAtomically(fs, diagnosticJournalPath, started, uuid);
        const { response, clear } = await beginRequest(fetcher, `${API_BASE}/batches/${encodeURIComponent(candidateId)}`, key);
        try {
          if (response.status !== 200) {
            await cancelResponseBody(response);
            safeOutput(out, { mode: 'verify-located', status: 'status_unavailable', httpStatus: response.status, idKind, idLength: candidateId.length });
            return { status: 'status_unavailable' };
          }
          const job = await readBoundedJson(response);
          if (!job || typeof job !== 'object' || Array.isArray(job)
              || !BATCH_STATUSES.includes(job.status) || job.id !== candidateId) {
            safeOutput(out, { mode: 'verify-located', status: 'unexpected_batch', httpStatus: response.status, idKind, idLength: candidateId.length });
            return { status: 'unexpected_batch' };
          }
          const total = job.request_counts?.total;
          const completedCount = job.request_counts?.completed;
          const failedCount = job.request_counts?.failed;
          const results = job.results;
          const soleResult = Array.isArray(results) && results.length === 1 ? results[0] : null;
          const matchedCustomId = soleResult?.custom_id === journal.customId;
          const modelKind = classifyModel(job.model).kind;
          const resultModelKind = classifyModel(soleResult?.response?.body?.model).kind;
          const modelVerified = isExpectedModel(job.model) && isExpectedModel(soleResult?.response?.body?.model);
          let structuredReadyValidated = false;
          if (total === 1 && completedCount === 1 && failedCount === 0 && job.status === 'completed' && matchedCustomId
              && job.endpoint === '/v1/chat/completions' && job.completion_window === '24h') {
            try { validateOwnedReadyResult(soleResult, journal.customId); structuredReadyValidated = true; }
            catch { structuredReadyValidated = false; }
          }
          const verifiedRequestOwned = structuredReadyValidated;
          const accounting = verifiedRequestOwned ? providerAccounting(job) : {};
          const checkedAt = now().toISOString();
          const requestCount = Number.isSafeInteger(total) && total >= 0 ? total : 0;
          const verification = {
            verifiedRequestOwned,
            structuredReadyValidated,
            modelVerified,
            modelKind,
            resultModelKind,
            batchStatus: job.status,
            requestCount,
            checkedAt,
            ...(verifiedRequestOwned && accounting.promptTokens !== undefined ? { promptTokens: accounting.promptTokens } : {}),
            ...(verifiedRequestOwned && accounting.completionTokens !== undefined ? { completionTokens: accounting.completionTokens } : {}),
            ...(verifiedRequestOwned && accounting.reasoningTokens !== undefined ? { reasoningTokens: accounting.reasoningTokens } : {}),
            ...(verifiedRequestOwned && accounting.costUsd !== undefined ? { costUsd: accounting.costUsd } : {}),
          };
          const updated = safeDiagnostic({
            ...diagnostic,
            status: verifiedRequestOwned ? 'verified' : 'not_owned',
            checkedAt,
            verification,
          });
          if (!updated) throw new Error('verification_receipt_invalid');
          await replaceJsonAtomically(fs, diagnosticJournalPath, updated, uuid);
          safeOutput(out, {
            mode: 'verify-located',
            status: verifiedRequestOwned ? 'verified' : 'not_owned',
            httpStatus: response.status,
            idKind,
            idLength: candidateId.length,
            modelKind,
            resultModelKind,
            batchStatus: job.status,
            requestCount: Number.isSafeInteger(total) && total >= 0 ? total : 'unavailable',
            matchedCustomId,
            verifiedRequestOwned,
            structuredReadyValidated,
            modelVerified,
            ...(verifiedRequestOwned && accounting.promptTokens !== undefined ? { promptTokens: accounting.promptTokens } : {}),
            ...(verifiedRequestOwned && accounting.completionTokens !== undefined ? { completionTokens: accounting.completionTokens } : {}),
            ...(verifiedRequestOwned && accounting.reasoningTokens !== undefined ? { reasoningTokens: accounting.reasoningTokens } : {}),
            ...(verifiedRequestOwned && accounting.costUsd !== undefined ? { costUsd: accounting.costUsd } : {}),
            ...(verifiedRequestOwned && accounting.costUsd === undefined ? { costUsd: 'unavailable' } : {}),
            ...(verifiedRequestOwned && accounting.billing ? { billing: accounting.billing } : {}),
          });
          return {
            status: verifiedRequestOwned ? 'verified' : 'not_owned',
            matchedCustomId,
            verifiedRequestOwned,
            structuredReadyValidated,
            modelVerified,
            ...(verifiedRequestOwned ? accounting : {}),
          };
        } finally {
          clear();
        }
      } catch {
        safeOutput(out, { mode: 'verify-located', status: 'verification_unknown', idKind, idLength: candidateId.length });
        return { status: 'verification_unknown' };
      }
    },

    async submit() {
      let key;
      try { key = await readKey(); }
      catch { safeOutput(out, { mode: 'submit', status: 'blocked', model: MODEL, requestCount: 1 }); return { status: 'blocked' }; }
      const customId = uuid();
      if (!isUuid(customId)) throw new Error('invalid_local_id');
      const intent = {
        version: JOURNAL_VERSION,
        status: 'submission_unknown',
        customId,
        model: MODEL,
        requestCount: 1,
        createdAt: now().toISOString(),
      };
      try { await writeExclusiveJson(fs, journalPath, intent); }
      catch { safeOutput(out, { mode: 'submit', status: 'refused_existing_or_unavailable_intent', model: MODEL, requestCount: 1 }); return { status: 'refused' }; }

      try {
        const { response, clear } = await beginRequest(fetcher, `${API_BASE}/batches`, key, createSmokeRequest(customId));
        try {
        if (response.status !== 202) {
          await cancelResponseBody(response);
          safeOutput(out, { mode: 'submit', status: 'submission_unknown', httpStatus: response.status, model: MODEL, requestCount: 1 });
          return { status: 'submission_unknown' };
        }
        const payload = await readBoundedJson(response);
        if (!payload || typeof payload !== 'object' || !isSafeOpaqueId(payload.id) || payload.status !== 'validating' || payload.endpoint !== '/v1/chat/completions' || !isExpectedModel(payload.model) || payload.completion_window !== '24h' || payload.request_counts?.total !== 1) {
          safeOutput(out, { mode: 'submit', status: 'submission_unknown', model: MODEL, requestCount: 1 });
          return { status: 'submission_unknown' };
        }
        const saved = safeJournal({ ...intent, status: 'submitted', batchId: payload.id });
        await replaceJsonAtomically(fs, journalPath, saved, uuid);
        safeOutput(out, { mode: 'submit', status: 'submitted', model: MODEL, requestCount: 1 });
        return { status: 'submitted' };
        } finally {
          clear();
        }
      } catch {
        safeOutput(out, { mode: 'submit', status: 'submission_unknown', model: MODEL, requestCount: 1 });
        return { status: 'submission_unknown' };
      }
    },

    async check() {
      let journal;
      try {
        journal = safeJournal(await readJournalJson(fs, journalPath));
      } catch { journal = null; }
      if (!journal) {
        safeOutput(out, { mode: 'check', status: 'no_valid_smoke_intent' });
        return { status: 'unavailable' };
      }
      if (!journal.batchId) {
        safeOutput(out, { mode: 'check', status: 'submission_unknown', model: MODEL, requestCount: 1 });
        return { status: 'submission_unknown' };
      }
      let key;
      try { key = await readKey(); }
      catch { safeOutput(out, { mode: 'check', status: 'credential_unavailable', model: MODEL, requestCount: 1 }); return { status: 'blocked' }; }
      try {
        const { response, clear } = await beginRequest(fetcher, `${API_BASE}/batches/${encodeURIComponent(journal.batchId)}`, key);
        try {
        if (response.status !== 200) {
          await cancelResponseBody(response);
          safeOutput(out, { mode: 'check', status: 'status_unavailable', httpStatus: response.status, model: MODEL, requestCount: 1 });
          return { status: 'status_unavailable' };
        }
        const job = validateBatchJob(await readBoundedJson(response), journal);
        let validatedResult = false;
        if (job.status === 'completed') {
          // OpenRouter returns batch results inline from this status request. Never
          // follow an output-file reference or make a second download request.
          try {
            if (job.output_file_id !== undefined || !Array.isArray(job.results) || job.results.length !== 1) {
              throw new Error('inline_result_unavailable');
            }
            validateInlineResult(job.results[0], journal);
            validatedResult = true;
          } catch {
            validatedResult = false;
          }
        } else if (job.results !== null && job.results !== undefined) {
          throw new Error('unexpected_results');
        }
        const accounting = providerAccounting(job);
        const finalStatus = String(job.status);
        const updated = safeJournal({ ...journal, status: finalStatus, checkedAt: now().toISOString() });
        await replaceJsonAtomically(fs, journalPath, updated, uuid);
        safeOutput(out, {
          mode: 'check', status: finalStatus, httpStatus: response.status, model: MODEL, requestCount: 1,
          validatedResult,
          ...(accounting.promptTokens !== undefined ? { promptTokens: accounting.promptTokens } : {}),
          ...(accounting.completionTokens !== undefined ? { completionTokens: accounting.completionTokens } : {}),
          ...(accounting.reasoningTokens !== undefined ? { reasoningTokens: accounting.reasoningTokens } : {}),
          ...(accounting.costUsd !== undefined ? { costUsd: accounting.costUsd } : {}),
          ...(accounting.costUsd === undefined ? { costUsd: 'unavailable' } : {}),
          ...(accounting.billing ? { billing: accounting.billing } : {}),
        });
        return { status: finalStatus, validatedResult, ...accounting };
        } finally {
          clear();
        }
      } catch {
        safeOutput(out, { mode: 'check', status: 'status_unavailable', model: MODEL, requestCount: 1 });
        return { status: 'status_unavailable' };
      }
    },
  });
}

function isNodeRuntime() {
  return typeof process !== 'undefined' && process.release?.name === 'node' && typeof process.versions?.node === 'string';
}

async function main() {
  if (!isNodeRuntime()) {
    process.stdout.write('status=unsupported_runtime\n');
    process.exitCode = 2;
    return;
  }
  const mode = process.argv[2];
  if (mode !== 'submit' && mode !== 'check' && mode !== 'locate' && mode !== 'verify-located') {
    process.stdout.write('status=usage command="node scripts/openrouterBatchSmoke.mjs submit|check|locate|verify-located"\n');
    process.exitCode = 2;
    return;
  }
  const method = { submit: 'submit', check: 'check', locate: 'locate', 'verify-located': 'verifyLocated' }[mode];
  const runner = createOpenRouterBatchSmokeRunner();
  const result = await runner[method]();
  if (['blocked', 'refused', 'unavailable', 'submission_unknown', 'status_unavailable'].includes(result.status)) process.exitCode = result.status === 'submission_unknown' ? 0 : 1;
}

if (isNodeRuntime() && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stdout.write('status=failed\n');
    process.exitCode = 1;
  });
}
