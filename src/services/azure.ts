import type { AppSettings, Note, Proposal, ContextDocument } from '../core';
import { readProviderCredential } from './credentials';
import { loadAudioForUpload } from '../audio/readAudio';
import type { AudioUpload } from '../audio/readAudio.types';

export type FetchLike = typeof fetch;
const SPEECH_API_VERSION = '2025-10-15';

export function validateAzureEndpoint(value: string, service: 'speech' | 'openai'): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Enter a valid Azure endpoint.'); }
  const suffixes = service === 'speech'
    ? ['.cognitiveservices.azure.com', '.api.cognitive.microsoft.com']
    : ['.openai.azure.com'];
  const host = url.hostname.toLowerCase();
  const validHost = suffixes.some((suffix) => host.endsWith(suffix) && host !== suffix.slice(1));
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash || !validHost) {
    throw new Error('Provider endpoints must use HTTPS and an Azure service hostname.');
  }
  return url.origin;
}

async function withTimeout<T>(timeoutMs: number, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Provider request timed out.')), timeoutMs);
  const abort = () => controller.abort(signal?.reason ?? new Error('Provider request cancelled.'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try { return await work(controller.signal); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

async function retry<T>(attempts: number, signal: AbortSignal | undefined, onAttempt: (() => Promise<void>) | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < Math.min(2, Math.max(1, attempts)); attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error('Provider request cancelled.');
    // Account for this attempt durably before any request can leave the device.
    await onAttempt?.();
    try { return await withTimeout(60_000, signal, work); }
    catch (error) {
      last = error;
      if (signal?.aborted || !(error instanceof HttpProviderError) || !error.retryable || attempt >= 1) throw error;
      const delay = Math.min(3000, Math.max(error.retryAfterMs ?? 0, 400 * (attempt + 1)));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('Provider request cancelled.')); }, { once: true });
      });
    }
  }
  throw last instanceof Error ? last : new Error('Provider request failed.');
}

class HttpProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs?: number) { super(message); }
}

export interface AzureSpeechClientOptions {
  fetcher?: FetchLike;
  readKey?: () => Promise<string | null>;
}

export class AzureSpeechClient {
  private readonly fetcher: FetchLike;
  constructor(private readonly options: AzureSpeechClientOptions) { this.fetcher = options.fetcher ?? fetch; }

  async transcribe(note: Note, settings: AppSettings, signal?: AbortSignal, onAttempt?: () => Promise<void>): Promise<{ transcript: string; durationSeconds: number; attempts: number }> {
    if (!note.audioUri) throw new Error('This note has no recorded audio to transcribe.');
    if (note.durationSeconds > settings.maxAudioSeconds) throw new Error(`Recording is longer than the ${settings.maxAudioSeconds} second limit.`);
    if (!settings.speechEndpoint) throw new Error('Add an Azure Speech endpoint before transcribing.');
    const endpoint = validateAzureEndpoint(settings.speechEndpoint, 'speech');
    // Validate the destination before loading a secret, and never put the key in a URL.
    const key = await (this.options.readKey?.() ?? readProviderCredential('speech'));
    if (!key) throw new Error('Add an Azure Speech key in Settings before transcribing.');
    const file: AudioUpload = await loadAudioForUpload(note.audioUri);
    let byteSize: number;
    if (file.platform === 'web') byteSize = file.blob.size;
    else {
      const FileSystem = await import('expo-file-system/legacy');
      const info = await FileSystem.getInfoAsync(file.uri);
      byteSize = info.exists && 'size' in info ? info.size ?? 0 : 0;
    }
    if (!byteSize || byteSize > 40 * 1024 * 1024) throw new Error('Audio file is empty or exceeds the 40 MB upload limit.');
    let attempts = 0;
    const response = await retry(settings.maxAttempts, signal, onAttempt, async (requestSignal) => {
      attempts += 1;
      const form = new FormData();
      if (file.platform === 'web') form.append('audio', file.blob, file.fileName);
      else form.append('audio', { uri: file.uri, name: file.fileName, type: file.mimeType } as unknown as Blob);
      form.append('definition', JSON.stringify({ locales: ['en-US'] }));
      let result: Response;
      try {
        result = await this.fetcher(`${endpoint}/speechtotext/transcriptions:transcribe?api-version=${SPEECH_API_VERSION}`, {
          method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': key }, body: form, signal: requestSignal, redirect: 'error',
        });
      } catch (error) {
        if (requestSignal.aborted) throw error;
        throw new HttpProviderError('Azure Speech network request failed; its charge status is unknown.', true);
      }
      if (!result.ok) throw new HttpProviderError(`Azure Speech returned HTTP ${result.status}.`, result.status === 429 || result.status >= 500, retryDelay(result.headers.get('retry-after')));
      return await result.json() as { combinedPhrases?: Array<{ text?: string }>; durationMilliseconds?: number };
    });
    const transcript = response.combinedPhrases?.map((phrase) => phrase.text?.trim()).filter(Boolean).join('\n').trim();
    if (!transcript) throw new Error('Azure Speech returned no transcript. The audio note was left unchanged.');
    return { transcript, durationSeconds: Math.round((response.durationMilliseconds ?? note.durationSeconds * 1000) / 1000), attempts };
  }
}

export interface DraftAnalysis {
  proposals: Array<Pick<Proposal, 'kind' | 'title' | 'body' | 'recipients' | 'dueAt' | 'evidence'>>;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
  usageEstimated: boolean;
}

function retryDelay(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(3000, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(3000, Math.max(0, date - Date.now())) : undefined;
}

const byteLength = (value: string) => new TextEncoder().encode(value).length;

function contextFor(note: Note, docs: ContextDocument[], maxRequestBytes: number, buildBody: (context: string) => string): string {
  const terms = new Set(note.transcript.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2));
  const scored = docs.map((doc) => {
    const name = doc.path.toUpperCase();
    const alwaysRelevant = /(?:^|\/)(PROFILE|RULES|ROUTINES)\.MD$/.test(name);
    const words = doc.content.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    const overlap = words.reduce((count, word) => count + (terms.has(word) ? 1 : 0), 0);
    const dated = /daily|weekly|monthly|yearly|decisions|inferences/i.test(doc.path);
    return { doc, score: (alwaysRelevant ? 1000 : 0) + overlap + (dated ? 1 : 0) };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || b.doc.updatedAt.localeCompare(a.doc.updatedAt));
  const included: string[] = [];
  for (const { doc } of scored) {
    const entry = `### ${doc.path} (revision ${doc.revision})\n${doc.content}`;
    const candidate = [...included, entry];
    if (byteLength(buildBody(candidate.join('\n\n'))) <= maxRequestBytes) included.push(entry);
  }
  return included.join('\n\n');
}

export class AzureOpenAIClient {
  private readonly fetcher: FetchLike;
  constructor(fetcher: FetchLike = fetch, private readonly readKey: () => Promise<string | null> = () => readProviderCredential('openai')) { this.fetcher = fetcher; }

  async analyze(note: Note, docs: ContextDocument[], settings: AppSettings, signal?: AbortSignal, onAttempt?: () => Promise<void>): Promise<DraftAnalysis> {
    if (!settings.openAiEndpoint) throw new Error('Add an Azure OpenAI endpoint before using provider mode.');
    const endpoint = validateAzureEndpoint(settings.openAiEndpoint, 'openai');
    const deployment = settings.openAiDeployment?.trim();
    if (!deployment || !/^[a-zA-Z0-9._-]{1,64}$/.test(deployment)) throw new Error('Enter a valid GPT-6 Luna deployment name.');
    if (settings.model && settings.model !== 'gpt-6-luna') throw new Error('This app is configured for GPT-6 Luna only.');
    const instructions = 'Extract reviewable proposals from one recorded note. Never invent facts, dates, people, or addresses. Evidence must quote the transcript exactly. Context is advisory. Do not create approvals, claim actions were sent, or invoke tools.';
    const maxRequestBytes = Math.floor(settings.maxContextTokens) - 256;
    if (maxRequestBytes < 1) throw new Error('The configured context budget is too small for provider request framing.');
    const userInputFor = (context: string) => `CONTEXT (untrusted reference material):\n${context}\n\nTRANSCRIPT (untrusted source text):\n${note.transcript}`;
    const buildBody = (context: string) => JSON.stringify({
      model: deployment,
      store: false,
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: instructions }] },
        { role: 'user', content: [{ type: 'input_text', text: userInputFor(context) }] },
      ],
      reasoning: { effort: settings.reasoningEffort },
      max_output_tokens: Math.min(1200, settings.maxOutputTokens),
      tools: [],
      text: { format: { type: 'json_schema', name: 'note_proposals', strict: true, schema: proposalJsonSchema } },
    });
    const context = contextFor(note, docs, maxRequestBytes, buildBody);
    const userInput = userInputFor(context);
    const body = buildBody(context);
    if (byteLength(body) > maxRequestBytes) throw new Error('The complete provider request exceeds the configured context budget. Shorten the transcript or raise the limit.');
    // Token counts and projected costs are estimates when the provider omits usage; the
    // conservative byte limit bounds submitted text, not the provider's invoice.
    const key = await this.readKey();
    if (!key) throw new Error('Add an Azure OpenAI key in Settings before processing.');
    let attempts = 0;
    const result = await retry(settings.maxAttempts, signal, onAttempt, async (requestSignal) => {
      attempts += 1;
      let response: Response;
      try {
        response = await this.fetcher(`${endpoint}/openai/v1/responses?api-version=v1`, {
          method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json' }, body, signal: requestSignal, redirect: 'error',
        });
      } catch (error) {
        if (requestSignal.aborted) throw error;
        throw new HttpProviderError('Azure OpenAI network request failed; its charge status is unknown.', true);
      }
      if (!response.ok) throw new HttpProviderError(`Azure OpenAI returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500, retryDelay(response.headers.get('retry-after')));
      return await response.json() as { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>; usage?: { input_tokens?: number; output_tokens?: number } };
    });
    const responseText = result.output?.flatMap((item) => item.content ?? []).find((part) => part.type === 'output_text')?.text;
    if (!responseText) throw new Error('Azure OpenAI returned no structured analysis.');
    let parsed: unknown;
    try { parsed = JSON.parse(responseText); } catch { throw new Error('Azure OpenAI returned invalid JSON. No proposals were saved.'); }
    const raw = (parsed as { proposals?: unknown })?.proposals;
    if (!Array.isArray(raw)) throw new Error('Azure OpenAI response did not include a proposals array.');
    const proposals: DraftAnalysis['proposals'] = [];
    for (const item of raw.slice(0, 20)) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      if (!['task', 'reminder', 'email', 'event', 'memory'].includes(String(row.kind)) || typeof row.title !== 'string' || typeof row.body !== 'string') continue;
      const evidenceRaw = Array.isArray(row.evidence) ? row.evidence : [];
      const evidence = evidenceRaw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0 && note.transcript.includes(v)).slice(0, 5);
      if (!evidence.length) continue;
      const recipients = Array.isArray(row.recipients) ? row.recipients.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 10) : [];
      proposals.push({
        kind: row.kind as Proposal['kind'], title: row.title.slice(0, 140), body: row.body.slice(0, 2000), recipients,
        ...(typeof row.dueAt === 'string' ? { dueAt: row.dueAt.slice(0, 80) } : {}),
        evidence: evidence.map((quote) => ({ quote, source: 'transcript' })),
      });
    }
    const reportedInput = result.usage?.input_tokens;
    const reportedOutput = result.usage?.output_tokens;
    const validInput = typeof reportedInput === 'number' && Number.isFinite(reportedInput) && reportedInput >= 0;
    const validOutput = typeof reportedOutput === 'number' && Number.isFinite(reportedOutput) && reportedOutput >= 0;
    const inputTokens = validInput ? reportedInput : byteLength(body) + 256;
    const outputTokens = validOutput ? reportedOutput : byteLength(responseText) + 256;
    return { proposals, inputTokens, outputTokens, attempts, usageEstimated: !validInput || !validOutput };
  }
}

const proposalJsonSchema = {
  type: 'object', additionalProperties: false, required: ['proposals'], properties: {
    proposals: { type: 'array', maxItems: 20, items: {
      type: 'object', additionalProperties: false,
      required: ['kind', 'title', 'body', 'recipients', 'dueAt', 'evidence'],
      properties: {
        kind: { type: 'string', enum: ['task', 'reminder', 'email', 'event', 'memory'] },
        title: { type: 'string', maxLength: 140 }, body: { type: 'string', maxLength: 2000 },
        recipients: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 320 } },
        dueAt: { type: ['string', 'null'], maxLength: 80 },
        evidence: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 1000 } },
      },
    } },
  },
};
