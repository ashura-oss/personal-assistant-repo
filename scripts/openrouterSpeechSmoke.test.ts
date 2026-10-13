import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SPEECH_SMOKE_JOURNAL_PATH,
  SPEECH_SMOKE_AUDIO_BYTES,
  SPEECH_SMOKE_AUDIO_SHA256,
  SPEECH_SMOKE_PHRASE,
  isSpeechSmokeLiveOptedIn,
  runOpenRouterSpeechSmoke,
  type SpeechSmokeFileSystem,
  type SpeechSmokePaths,
} from './openrouterSpeechSmoke';

const AUDIO = 'C:\\smoke-outside-repo\\speech-smoke-fixture.wav';
const MANIFEST = 'C:\\smoke-outside-repo\\speech-smoke-fixture.json';
const KEY = 'C:\\smoke-outside-repo\\openrouter-api-key.txt';
const JOURNAL = 'C:\\smoke-outside-repo\\openrouter-speech-smoke-v2.json';
const CWD = 'C:\\repo';
const SECRET_CANARY = 'FAKE_SPEECH_API_KEY_DO_NOT_PRINT';
const TRANSCRIPT = 'This is a fictional voice test. The sample meeting is tomorrow at 10!';

function makeWav(): Uint8Array {
  const bytes = new Uint8Array(SPEECH_SMOKE_AUDIO_BYTES);
  const view = new DataView(bytes.buffer);
  const put = (offset: number, text: string) => { for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i); };
  put(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); put(8, 'WAVE');
  put(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, bytes.byteLength - 44, true);
  return bytes;
}

function makeFixtureFs(options: { existingJournal?: boolean; malformedManifest?: boolean } = {}) {
  const values = new Map<string, Uint8Array | string>();
  const audio = makeWav();
  const actualSha = createHash('sha256').update(audio).digest('hex');
  const manifest = {
    version: 1,
    phrase: SPEECH_SMOKE_PHRASE,
    sha256: options.malformedManifest ? '0'.repeat(64) : SPEECH_SMOKE_AUDIO_SHA256,
    audioBytes: SPEECH_SMOKE_AUDIO_BYTES,
  };
  values.set(AUDIO, audio);
  values.set(MANIFEST, JSON.stringify(manifest));
  values.set(KEY, SECRET_CANARY);
  if (options.existingJournal) values.set(JOURNAL, JSON.stringify({ version: 1, profileVersion: 1, model: 'openai/gpt-4o-mini-transcribe', status: 'submission_unknown' }));
  const reads: string[] = [];
  const stats: string[] = [];
  const fs: SpeechSmokeFileSystem = {
    async readFile(path) {
      reads.push(path);
      const value = values.get(path);
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    },
    async stat(path) {
      stats.push(path);
      if (!values.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { isFile: () => true };
    },
    async mkdir() { return undefined; },
    async open(path, flags) {
      if (flags === 'wx' && values.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      let buffer = '';
      return {
        async writeFile(data) { buffer += data; values.set(path, buffer); },
        async sync() { return undefined; },
        async close() { if (buffer) values.set(path, buffer); },
      };
    },
    async rename(from, to) {
      const value = values.get(from);
      if (value === undefined) throw new Error('missing temp');
      values.set(to, value);
      values.delete(from);
    },
    async unlink(path) { values.delete(path); },
  };
  const paths: SpeechSmokePaths = { audio: AUDIO, manifest: MANIFEST, key: KEY, journal: JOURNAL };
  return { fs, paths, values, reads, stats, actualSha };
}

function depsFor(fixture: ReturnType<typeof makeFixtureFs>, fetcher: typeof fetch, output: (line: string) => void) {
  return {
    fs: fixture.fs,
    paths: fixture.paths,
    cwd: CWD,
    fetcher,
    output,
    uuid: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    now: () => new Date('2026-10-14T00:00:00.000Z'),
    sha256: () => SPEECH_SMOKE_AUDIO_SHA256,
  };
}

describe('closed OpenRouter Speech smoke runner', () => {
  it('requires exact profile-2 acknowledgement in addition to the previous live flags', () => {
    expect(isSpeechSmokeLiveOptedIn({
      STILL_OPENROUTER_SPEECH_SMOKE: 'RUN_ONCE',
      STILL_OPENROUTER_SPEECH_CONFIG: 'scripts/vitest.openrouter-speech.config.ts',
    })).toBe(false);
    for (const profile of ['1', '999', '02', '2 ']) {
      expect(isSpeechSmokeLiveOptedIn({
        STILL_OPENROUTER_SPEECH_SMOKE: 'RUN_ONCE',
        STILL_OPENROUTER_SPEECH_CONFIG: 'scripts/vitest.openrouter-speech.config.ts',
        STILL_OPENROUTER_SPEECH_PROFILE: profile,
      })).toBe(false);
    }
    expect(isSpeechSmokeLiveOptedIn({
      STILL_OPENROUTER_SPEECH_SMOKE: 'RUN_ONCE',
      STILL_OPENROUTER_SPEECH_CONFIG: 'scripts/vitest.openrouter-speech.config.ts',
      STILL_OPENROUTER_SPEECH_PROFILE: '2',
    })).toBe(true);
  });

  it('defaults to profile 2 and a separate journal without touching the legacy v1 journal', async () => {
    expect(DEFAULT_SPEECH_SMOKE_JOURNAL_PATH).toMatch(/openrouter-speech-smoke-v2\.json$/);
    const fixture = makeFixtureFs();
    const lines: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe('openai/whisper-large-v3-turbo');
      return new Response(JSON.stringify({ text: TRANSCRIPT, usage: { cost: 0 } }), { status: 200 });
    });
    const defaults = depsFor(fixture, fetcher, (line) => lines.push(line));
    const result = await runOpenRouterSpeechSmoke({
      ...defaults,
      paths: { key: KEY, audio: AUDIO, manifest: MANIFEST },
    });
    expect(result).toMatchObject({ status: 'transcription_completed', httpStatus: 200, usage: { costUsd: 0 } });
    const journal = JSON.parse(String(fixture.values.get(DEFAULT_SPEECH_SMOKE_JOURNAL_PATH))) as Record<string, unknown>;
    expect(journal).toMatchObject({ version: 2, profileVersion: 2, model: 'openai/whisper-large-v3-turbo' });
    const legacyJournal = DEFAULT_SPEECH_SMOKE_JOURNAL_PATH.replace('openrouter-speech-smoke-v2.json', 'openrouter-speech-smoke-v1.json');
    expect(fixture.stats).toContain(DEFAULT_SPEECH_SMOKE_JOURNAL_PATH);
    expect([...fixture.reads, ...fixture.stats]).not.toContain(legacyJournal);
  });

  it('keeps profile 1 only when explicitly selected by a closed compatibility test', async () => {
    const fixture = makeFixtureFs();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe('openai/gpt-4o-mini-transcribe');
      return new Response(JSON.stringify({ text: TRANSCRIPT }), { status: 200 });
    });
    await runOpenRouterSpeechSmoke({ ...depsFor(fixture, fetcher, () => undefined), profileVersion: 1 });
    const journal = JSON.parse(String(fixture.values.get(JOURNAL))) as Record<string, unknown>;
    expect(journal).toMatchObject({ version: 2, profileVersion: 1, model: 'openai/gpt-4o-mini-transcribe' });
  });

  it('captures an allowlisted HTTP status without exposing a rejected response body', async () => {
    const fixture = makeFixtureFs();
    const lines: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ message: SECRET_CANARY }), { status: 422 }));
    const result = await runOpenRouterSpeechSmoke(depsFor(fixture, fetcher, (line) => lines.push(line)));
    expect(result).toMatchObject({ status: 'submission_unknown', code: 'provider_rejected', httpStatus: 422 });
    expect(lines.join('\n')).toContain('httpStatus=422');
    expect(lines.join('\n')).not.toContain(SECRET_CANARY);
    const journal = JSON.parse(String(fixture.values.get(JOURNAL))) as Record<string, unknown>;
    expect(journal).toMatchObject({ status: 'submission_unknown', httpStatus: 422, profileVersion: 2 });
    expect(String(fixture.values.get(JOURNAL))).not.toContain(SECRET_CANARY);
  });

  it('refuses an existing mismatched-profile intent before reading key/audio or posting', async () => {
    const fixture = makeFixtureFs({ existingJournal: true });
    const lines: string[] = [];
    const fetcher = vi.fn<typeof fetch>();
    const result = await runOpenRouterSpeechSmoke(depsFor(fixture, fetcher, (line) => lines.push(line)));
    expect(result).toMatchObject({ status: 'existing_intent', code: 'journal_exists' });
    expect(fixture.reads).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(lines.join('\n')).not.toContain(SECRET_CANARY);
  });

  it('rejects a manifest mismatch before reading the key or posting', async () => {
    const fixture = makeFixtureFs({ malformedManifest: true });
    const lines: string[] = [];
    const fetcher = vi.fn<typeof fetch>();
    const result = await runOpenRouterSpeechSmoke(depsFor(fixture, fetcher, (line) => lines.push(line)));
    expect(result).toMatchObject({ status: 'precondition_unavailable', code: 'fixture_mismatch' });
    expect(fixture.reads).not.toContain(KEY);
    expect(fetcher).not.toHaveBeenCalled();
    expect(lines.join('\n')).not.toContain(SECRET_CANARY);
  });

  it('uses the production wire/client once, preserves zero actual usage, and never prints transcript or key', async () => {
    const fixture = makeFixtureFs();
    expect(fixture.actualSha).not.toBe(SPEECH_SMOKE_AUDIO_SHA256); // Test seam substitutes the known fixture digest.
    const lines: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe('openai/whisper-large-v3-turbo');
      expect(body.provider).toEqual({ zdr: true, data_collection: 'deny' });
      expect((body.input_audio as { format: string }).format).toBe('wav');
      return new Response(JSON.stringify({ text: TRANSCRIPT, usage: { seconds: 3.5, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost: 0 } }), { status: 200 });
    });
    const result = await runOpenRouterSpeechSmoke(depsFor(fixture, fetcher, (line) => lines.push(line)));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'transcription_completed', httpStatus: 200, transcriptMatched: true, usage: { seconds: 3.5, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } });
    const output = lines.join('\n');
    expect(output).toContain('transcriptMatched=true');
    expect(output).toContain('costUsd=0');
    expect(output).not.toContain(TRANSCRIPT);
    expect(output).not.toContain(SECRET_CANARY);
    const journal = String(fixture.values.get(JOURNAL));
    expect(journal).toContain('transcription_completed');
    expect(journal).toContain('"costUsd":0');
    expect(journal).not.toContain(TRANSCRIPT);
    expect(journal).not.toContain(SECRET_CANARY);

    const second = await runOpenRouterSpeechSmoke(depsFor(fixture, fetcher, (line) => lines.push(line)));
    expect(second.status).toBe('existing_intent');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('records uncertain provider failure without exposing its raw error or replaying', async () => {
    const fixture = makeFixtureFs();
    const lines: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error(SECRET_CANARY); });
    const result = await runOpenRouterSpeechSmoke(depsFor(fixture, fetcher, (line) => lines.push(line)));
    expect(result).toMatchObject({ status: 'submission_unknown', code: 'provider_unknown' });
    expect(lines.join('\n')).not.toContain(SECRET_CANARY);
    expect(String(fixture.values.get(JOURNAL))).toContain('submission_unknown');
    const second = await runOpenRouterSpeechSmoke(depsFor(fixture, fetcher, (line) => lines.push(line)));
    expect(second.status).toBe('existing_intent');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

const liveOptIn = isSpeechSmokeLiveOptedIn(process.env);
const live = liveOptIn ? it : it.skip;
live('one explicit fictional OpenRouter Speech request (manual opt-in only)', async () => {
  const output: string[] = [];
  const result = await runOpenRouterSpeechSmoke({ output: (line) => output.push(line) });
  process.stdout.write(`${output.join('\n')}\n`);
  expect(result.status).toBe('transcription_completed');
  expect(result.transcriptMatched).toBe(true);
}, 150_000);
