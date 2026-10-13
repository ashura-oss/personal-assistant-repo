import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { OPENROUTER_SPEECH_ENDPOINT, buildOpenRouterSpeechWireRequest, type OpenRouterSpeechUsage } from '../src/services/openRouterSpeechWire';
import { OpenRouterSpeechClient, OpenRouterSpeechError } from '../src/services/openRouterSpeech';
import { getOpenRouterSpeechProfile, OPENROUTER_SPEECH_DEFAULT_PROFILE_VERSION, type OpenRouterSpeechProfileVersion } from '../src/transcription/openRouterSpeechProfiles';

export const SPEECH_SMOKE_PHRASE = 'This is a fictional voice test. The sample meeting is tomorrow at ten.';
export const SPEECH_SMOKE_AUDIO_BYTES = 241_652;
export const SPEECH_SMOKE_AUDIO_SHA256 = '7fff35ba091b7a488bd39ff0d50be3f9ca0eea955636a1ec6c9236ff00a8ff31';
export const SPEECH_SMOKE_MAX_AUDIO_BYTES = 1_048_576;
export const SPEECH_SMOKE_MAX_MANIFEST_BYTES = 4_096;
export const SPEECH_SMOKE_MAX_KEY_BYTES = 8_192;

/** Live execution requires three exact acknowledgements; ordinary closed tests never set these. */
export function isSpeechSmokeLiveOptedIn(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.STILL_OPENROUTER_SPEECH_SMOKE === 'RUN_ONCE' &&
    env.STILL_OPENROUTER_SPEECH_CONFIG === 'scripts/vitest.openrouter-speech.config.ts' &&
    env.STILL_OPENROUTER_SPEECH_PROFILE === '2';
}

const appData = process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local');
export const DEFAULT_SPEECH_SMOKE_KEY_PATH = resolve(appData, 'Still', 'openrouter-api-key.txt');
export const DEFAULT_SPEECH_SMOKE_AUDIO_PATH = resolve(appData, 'Still', 'speech-smoke-fixture.wav');
export const DEFAULT_SPEECH_SMOKE_MANIFEST_PATH = resolve(appData, 'Still', 'speech-smoke-fixture.json');
export const DEFAULT_SPEECH_SMOKE_JOURNAL_PATH = resolve(appData, 'Still', 'openrouter-speech-smoke-v2.json');

const JOURNAL_VERSION = 2;
const JOURNAL_STATUSES = new Set([
  'submission_unknown', 'transcription_completed', 'no_speech', 'invalid_result', 'not_submitted',
]);
const ERROR_CODES = new Set([
  'invalid_request', 'pre_dispatch', 'credential_missing', 'stale_credential', 'cancelled', 'timeout',
  'provider_rejected', 'provider_unknown', 'response_too_large',
]);
const OUTPUT_FIELDS = [
  'status', 'code', 'httpStatus', 'transcriptMatched', 'seconds', 'inputTokens', 'outputTokens', 'totalTokens', 'costUsd',
] as const;

type SmokeFileHandle = {
  writeFile(data: string, options?: { encoding?: string }): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
};

export interface SpeechSmokeFileSystem {
  readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string>;
  open(path: string, flags: string, mode?: number): Promise<SmokeFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  stat(path: string): Promise<{ isFile(): boolean }>;
}

export interface SpeechSmokePaths {
  key: string;
  audio: string;
  manifest: string;
  journal: string;
}

export interface SpeechSmokeResult {
  readonly status: string;
  readonly code?: string;
  readonly httpStatus?: number;
  readonly transcriptMatched?: boolean;
  readonly usage?: OpenRouterSpeechUsage;
}

export interface SpeechSmokeDependencies {
  /** Default live profile is v2; profile 1 is available for isolated compatibility tests. */
  readonly profileVersion?: OpenRouterSpeechProfileVersion;
  readonly fs?: SpeechSmokeFileSystem;
  readonly fetcher?: typeof fetch;
  readonly output?: (line: string) => void;
  readonly paths?: Partial<SpeechSmokePaths>;
  readonly cwd?: string;
  readonly now?: () => Date;
  readonly uuid?: () => string;
  /** Test seam only; live entry always uses SHA-256. */
  readonly sha256?: (bytes: Uint8Array) => string;
}

const nodeFs: SpeechSmokeFileSystem = {
  async readFile(path, encoding) {
    if (encoding === 'utf8') return readFile(path, { encoding: 'utf8' });
    const value = await readFile(path);
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
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

/** Runs one explicit synthetic upload. Any pre-existing journal permanently prevents another POST. */
export async function runOpenRouterSpeechSmoke(dependencies: SpeechSmokeDependencies = {}): Promise<SpeechSmokeResult> {
  const fs = dependencies.fs ?? nodeFs;
  const fetcher = dependencies.fetcher ?? fetch;
  const output = dependencies.output ?? ((line: string) => process.stdout.write(`${line}\n`));
  const paths: SpeechSmokePaths = {
    key: dependencies.paths?.key ?? DEFAULT_SPEECH_SMOKE_KEY_PATH,
    audio: dependencies.paths?.audio ?? DEFAULT_SPEECH_SMOKE_AUDIO_PATH,
    manifest: dependencies.paths?.manifest ?? DEFAULT_SPEECH_SMOKE_MANIFEST_PATH,
    journal: dependencies.paths?.journal ?? DEFAULT_SPEECH_SMOKE_JOURNAL_PATH,
  };
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;
  const hash = dependencies.sha256 ?? ((bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'));
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const profileVersion = dependencies.profileVersion ?? OPENROUTER_SPEECH_DEFAULT_PROFILE_VERSION;
  const profile = getOpenRouterSpeechProfile(profileVersion);
  if (!profile) return report(output, { status: 'precondition_unavailable', code: 'profile_unavailable' });

  if (!pathsAreSafe(paths, cwd)) return report(output, { status: 'precondition_unavailable', code: 'unsafe_paths' });
  try {
    await fs.stat(paths.journal);
    return report(output, { status: 'existing_intent', code: 'journal_exists' });
  } catch (error) {
    if (!isMissingFile(error)) return report(output, { status: 'precondition_unavailable', code: 'journal_unavailable' });
  }

  let manifest: Record<string, unknown>;
  let audio: Uint8Array;
  let key: string;
  try {
    const manifestBytes = await readBytes(fs, paths.manifest, SPEECH_SMOKE_MAX_MANIFEST_BYTES);
    manifest = parseManifest(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
    audio = await readBytes(fs, paths.audio, SPEECH_SMOKE_MAX_AUDIO_BYTES);
    if (audio.byteLength !== SPEECH_SMOKE_AUDIO_BYTES || !validWave(audio)) {
      return report(output, { status: 'precondition_unavailable', code: 'fixture_invalid' });
    }
    const digest = hash(audio);
    if (digest !== SPEECH_SMOKE_AUDIO_SHA256 || manifest.sha256 !== digest || manifest.audioBytes !== audio.byteLength || manifest.phrase !== SPEECH_SMOKE_PHRASE) {
      return report(output, { status: 'precondition_unavailable', code: 'fixture_mismatch' });
    }
    const keyBytes = await readBytes(fs, paths.key, SPEECH_SMOKE_MAX_KEY_BYTES);
    key = new TextDecoder('utf-8', { fatal: true }).decode(keyBytes).trim();
    if (!key || /[\r\n]/.test(key)) return report(output, { status: 'precondition_unavailable', code: 'credential_unavailable' });
  } catch (error) {
    return report(output, { status: 'precondition_unavailable', code: safePreconditionCode(error) });
  }

  let request;
  try {
    request = buildOpenRouterSpeechWireRequest({ bytes: audio, format: 'wav', profileVersion });
  } catch {
    return report(output, { status: 'precondition_unavailable', code: 'fixture_invalid' });
  }
  if (request.endpoint !== OPENROUTER_SPEECH_ENDPOINT || request.audioBytes !== SPEECH_SMOKE_AUDIO_BYTES) {
    return report(output, { status: 'precondition_unavailable', code: 'request_invalid' });
  }

  const createdAt = canonicalNow(now);
  if (!createdAt) return report(output, { status: 'precondition_unavailable', code: 'clock_invalid' });
  const intent = {
    version: JOURNAL_VERSION,
    status: 'submission_unknown',
    createdAt,
    profileVersion: profile.version,
    model: profile.model,
    endpoint: OPENROUTER_SPEECH_ENDPOINT,
    audioBytes: audio.byteLength,
    sha256: SPEECH_SMOKE_AUDIO_SHA256,
  } as const;

  try {
    await fs.mkdir(dirname(paths.journal), { recursive: true });
    await writeExclusive(fs, paths.journal, intent);
  } catch (error) {
    return report(output, {
      status: isAlreadyExists(error) ? 'existing_intent' : 'precondition_unavailable',
      code: isAlreadyExists(error) ? 'journal_exists' : 'journal_write_failed',
    });
  }

  let observedHttpStatus: number | undefined;
  const observingFetcher: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init);
    if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) {
      observedHttpStatus = response.status;
    }
    return response;
  };
  const client = new OpenRouterSpeechClient({
    withRequestOwnership: async (actualRequest) => actualRequest(),
    fetcher: observingFetcher,
    readCredentialSnapshot: async () => ({ key, generation: 0 }),
    assertCredentialGeneration: () => undefined,
    assertBeforeStart: () => undefined,
  });
  let result: SpeechSmokeResult;
  try {
    const parsed = await client.transcribe({
      operationId: uuid(),
      request,
      onBeforeDispatch: async () => undefined,
    });
    const transcriptMatched = parsed.kind === 'transcript' && normalizeKnownPhrase(parsed.transcript) === normalizeKnownPhrase(SPEECH_SMOKE_PHRASE);
    const status = parsed.kind === 'no_speech' ? 'no_speech' : parsed.kind === 'invalid' ? 'invalid_result' : 'transcription_completed';
    result = {
      status,
      ...(parsed.kind === 'transcript' ? { transcriptMatched } : {}),
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    };
  } catch (error) {
    const safeError = error instanceof OpenRouterSpeechError ? error : undefined;
    const code = safeError && ERROR_CODES.has(safeError.code) ? safeError.code : 'provider_unknown';
    result = {
      status: safeError?.dispatched ? 'submission_unknown' : 'not_submitted',
      code,
      ...(observedHttpStatus !== undefined ? { httpStatus: observedHttpStatus } : {}),
      ...(safeError?.usage ? { usage: safeError.usage } : {}),
    };
  }
  if (observedHttpStatus !== undefined && result.httpStatus === undefined) {
    result = { ...result, httpStatus: observedHttpStatus };
  }

  const finalizedAt = canonicalNow(now);
  if (!finalizedAt) {
    return report(output, { status: 'submission_unknown', code: 'journal_update_failed' });
  }
  const terminal = {
    ...intent,
    status: JOURNAL_STATUSES.has(result.status) ? result.status : 'submission_unknown',
    finalizedAt,
    ...(result.code && ERROR_CODES.has(result.code) ? { code: result.code } : {}),
    ...(result.httpStatus !== undefined ? { httpStatus: result.httpStatus } : {}),
    ...(result.transcriptMatched !== undefined ? { transcriptMatched: result.transcriptMatched } : {}),
    ...(result.usage ? { usage: safeUsage(result.usage) } : {}),
  };
  try {
    await replaceAtomically(fs, paths.journal, terminal, uuid);
  } catch {
    return report(output, { status: 'submission_unknown', code: 'journal_update_failed' });
  }
  return report(output, result);
}

function parseManifest(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('manifest_invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'audioBytes,phrase,sha256,version' || row.version !== 1 ||
      row.phrase !== SPEECH_SMOKE_PHRASE || row.sha256 !== SPEECH_SMOKE_AUDIO_SHA256 ||
      row.audioBytes !== SPEECH_SMOKE_AUDIO_BYTES) throw new Error('manifest_invalid');
  return row;
}

async function readBytes(fs: SpeechSmokeFileSystem, path: string, maxBytes: number): Promise<Uint8Array> {
  const raw = await fs.readFile(path);
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw);
  if (bytes.byteLength > maxBytes) throw new Error('input_too_large');
  return bytes;
}

function validWave(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 44 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.byteLength - 8) return false;
  let cursor = 12;
  let hasFormat = false;
  let hasData = false;
  while (cursor + 8 <= bytes.byteLength) {
    const tag = ascii(bytes, cursor, 4);
    const length = view.getUint32(cursor + 4, true);
    const start = cursor + 8;
    const end = start + length;
    if (end > bytes.byteLength) return false;
    if (tag === 'fmt ' && length >= 16) hasFormat = true;
    if (tag === 'data' && length > 0) hasData = true;
    cursor = end + (length % 2);
  }
  return cursor === bytes.byteLength && hasFormat && hasData;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function normalizeKnownPhrase(text: string): string {
  return text.toLocaleLowerCase('en-US').replace(/\b10\b/g, 'ten').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function pathsAreSafe(paths: SpeechSmokePaths, cwd: string): boolean {
  const values = Object.values(paths).map((path) => resolve(path));
  if (values.some((path) => !isAbsolute(path) || !isOutside(path, cwd))) return false;
  return new Set(values).size === values.length;
}

function isOutside(path: string, cwd: string): boolean {
  const rel = relative(cwd, path);
  return rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel);
}

function canonicalNow(now: () => Date): string | undefined {
  try {
    const date = now();
    return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  } catch { return undefined; }
}

function safeUsage(value: OpenRouterSpeechUsage): OpenRouterSpeechUsage | undefined {
  const usage: { seconds?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number } = {};
  if (typeof value.seconds === 'number' && Number.isFinite(value.seconds) && value.seconds >= 0) usage.seconds = value.seconds;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const count = value[key];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) usage[key] = count;
  }
  if (typeof value.costUsd === 'number' && Number.isFinite(value.costUsd) && value.costUsd >= 0) usage.costUsd = value.costUsd;
  return Object.keys(usage).length ? Object.freeze(usage) : undefined;
}

async function writeExclusive(fs: SpeechSmokeFileSystem, path: string, value: unknown): Promise<void> {
  const handle = await fs.open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceAtomically(fs: SpeechSmokeFileSystem, path: string, value: unknown, uuid: () => string): Promise<void> {
  const temp = `${path}.${uuid()}.tmp`;
  let handle: SmokeFileHandle | undefined;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, path);
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(temp).catch(() => undefined);
    throw new Error('journal_update_failed');
  }
}

function report(output: (line: string) => void, value: SpeechSmokeResult): SpeechSmokeResult {
  const safe: Record<string, string | number | boolean> = { status: value.status };
  if (value.code && ERROR_CODES.has(value.code)) safe.code = value.code;
  if (Number.isInteger(value.httpStatus) && (value.httpStatus as number) >= 100 && (value.httpStatus as number) <= 599) safe.httpStatus = value.httpStatus as number;
  if (value.transcriptMatched !== undefined) safe.transcriptMatched = value.transcriptMatched;
  const usage = value.usage;
  if (usage) {
    const cleaned = safeUsage(usage);
    if (cleaned) Object.assign(safe, cleaned);
  }
  output(OUTPUT_FIELDS.filter((field) => safe[field] !== undefined).map((field) => `${field}=${String(safe[field])}`).join(' '));
  return Object.freeze({ ...value, ...(usage ? { usage: safeUsage(usage) } : {}) });
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'EEXIST';
}

function safePreconditionCode(error: unknown): string {
  if (error instanceof Error && error.message === 'input_too_large') return 'fixture_too_large';
  if (error instanceof Error && error.message === 'manifest_invalid') return 'fixture_mismatch';
  return 'precondition_unavailable';
}
