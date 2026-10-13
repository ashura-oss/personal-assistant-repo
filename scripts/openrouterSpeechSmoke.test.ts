import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  SPEECH_SMOKE_AUDIO_BYTES,
  SPEECH_SMOKE_AUDIO_SHA256,
  SPEECH_SMOKE_PHRASE,
  runOpenRouterSpeechSmoke,
  type SpeechSmokeFileSystem,
  type SpeechSmokePaths,
} from './openrouterSpeechSmoke';

const AUDIO = 'C:\\smoke-outside-repo\\speech-smoke-fixture.wav';
const MANIFEST = 'C:\\smoke-outside-repo\\speech-smoke-fixture.json';
const KEY = 'C:\\smoke-outside-repo\\openrouter-api-key.txt';
const JOURNAL = 'C:\\smoke-outside-repo\\openrouter-speech-smoke-v1.json';
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
  if (options.existingJournal) values.set(JOURNAL, '{"existing":true}');
  const reads: string[] = [];
  const fs: SpeechSmokeFileSystem = {
    async readFile(path) {
      reads.push(path);
      const value = values.get(path);
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    },
    async stat(path) {
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
  return { fs, paths, values, reads, actualSha };
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
  it('refuses an existing intent before reading key/audio or posting', async () => {
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
      expect(body.model).toBe('openai/gpt-4o-mini-transcribe');
      expect(body.provider).toEqual({ zdr: true, data_collection: 'deny' });
      expect((body.input_audio as { format: string }).format).toBe('wav');
      return new Response(JSON.stringify({ text: TRANSCRIPT, usage: { seconds: 3.5, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost: 0 } }), { status: 200 });
    });
    const result = await runOpenRouterSpeechSmoke(depsFor(fixture, fetcher, (line) => lines.push(line)));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'transcription_completed', transcriptMatched: true, usage: { seconds: 3.5, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } });
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

const liveOptIn = process.env.STILL_OPENROUTER_SPEECH_SMOKE === 'RUN_ONCE' &&
  process.env.STILL_OPENROUTER_SPEECH_CONFIG === 'scripts/vitest.openrouter-speech.config.ts';
const live = liveOptIn ? it : it.skip;
live('one explicit fictional OpenRouter Speech request (manual opt-in only)', async () => {
  const output: string[] = [];
  const result = await runOpenRouterSpeechSmoke({ output: (line) => output.push(line) });
  process.stdout.write(`${output.join('\n')}\n`);
  expect(result.status).toBe('transcription_completed');
  expect(result.transcriptMatched).toBe(true);
}, 150_000);
