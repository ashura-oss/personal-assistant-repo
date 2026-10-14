import { createReadStream, lstatSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';

export type PrivateAudioFormat = 'm4a' | 'mp3' | 'wav' | 'webm' | 'ogg';
export type VerifiedPrivateAudio = Readonly<{ format: PrivateAudioFormat; mimeType: string; durationSeconds: number }>;

const MIME_BY_FORMAT: Readonly<Record<PrivateAudioFormat, string>> = Object.freeze({
  m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg',
});
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 600;
const CODEC_TIMEOUT_MS = 60_000;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

export class AudioVerificationError extends Error {
  constructor(readonly code: 'audio_invalid' | 'unsupported_format' | 'codec_unavailable' | 'codec_failed' | 'codec_timeout' | 'cancelled') {
    super(code);
    this.name = 'AudioVerificationError';
  }
}

export interface AudioVerificationOptions {
  readonly filePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly expectedFormat: PrivateAudioFormat;
  readonly ffmpegPath?: string;
  readonly ffprobePath?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Trusted test seam; production composition leaves this unset. */
  readonly spawnProcess?: typeof spawn;
}

class StreamCursor {
  private readonly iterator: AsyncIterator<Buffer>;
  private current: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private offset = 0;
  bytesRead = 0;

  constructor(stream: AsyncIterable<Buffer>) { this.iterator = stream[Symbol.asyncIterator](); }

  private async nextBuffer(): Promise<boolean> {
    const next = await this.iterator.next();
    if (next.done) return false;
    if (!Buffer.isBuffer(next.value)) throw new AudioVerificationError('audio_invalid');
    this.current = next.value;
    this.offset = 0;
    return this.current.length > 0;
  }

  async readExact(length: number, maxAllocation = 64 * 1024): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || length > maxAllocation) throw new AudioVerificationError('audio_invalid');
    const output = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      if (this.offset >= this.current.length && !(await this.nextBuffer())) throw new AudioVerificationError('audio_invalid');
      const count = Math.min(length - written, this.current.length - this.offset);
      this.current.copy(output, written, this.offset, this.offset + count);
      this.offset += count;
      written += count;
      this.bytesRead += count;
    }
    return output;
  }

  async skip(length: number): Promise<void> {
    if (!Number.isSafeInteger(length) || length < 0) throw new AudioVerificationError('audio_invalid');
    let remaining = length;
    while (remaining > 0) {
      if (this.offset >= this.current.length && !(await this.nextBuffer())) throw new AudioVerificationError('audio_invalid');
      const count = Math.min(remaining, this.current.length - this.offset);
      this.offset += count;
      this.bytesRead += count;
      remaining -= count;
    }
  }

  async hasTrailingBytes(): Promise<boolean> {
    if (this.offset < this.current.length) return true;
    while (await this.nextBuffer()) if (this.current.length) return true;
    return false;
  }
}

function expectedFromFileName(name: string): PrivateAudioFormat | undefined {
  const ext = basename(name).toLowerCase().split('.').at(-1);
  return ext === 'm4a' || ext === 'mp3' || ext === 'wav' || ext === 'webm' || ext === 'ogg' ? ext : undefined;
}

async function verifyWav(filePath: string, size: number): Promise<number> {
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  const cursor = new StreamCursor(stream);
  try {
    const riff = await cursor.readExact(12);
    if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE' || riff.readUInt32LE(4) + 8 !== size) {
      throw new AudioVerificationError('audio_invalid');
    }
    let format: { channels: number; sampleRate: number; byteRate: number; blockAlign: number; bits: number } | undefined;
    let dataBytes = 0;
    while (cursor.bytesRead < size) {
      if (size - cursor.bytesRead < 8) throw new AudioVerificationError('audio_invalid');
      const header = await cursor.readExact(8);
      const chunkName = header.toString('ascii', 0, 4);
      const chunkSize = header.readUInt32LE(4);
      const paddedSize = chunkSize + (chunkSize % 2);
      if (paddedSize > size - cursor.bytesRead) throw new AudioVerificationError('audio_invalid');
      if (chunkName === 'fmt ') {
        if (format || chunkSize < 16 || chunkSize > 4096) throw new AudioVerificationError('audio_invalid');
        const chunk = await cursor.readExact(chunkSize, 4096);
        const encoding = chunk.readUInt16LE(0);
        const channels = chunk.readUInt16LE(2);
        const sampleRate = chunk.readUInt32LE(4);
        const byteRate = chunk.readUInt32LE(8);
        const blockAlign = chunk.readUInt16LE(12);
        const bits = chunk.readUInt16LE(14);
        if (encoding !== 1 || (channels !== 1 && channels !== 2) || sampleRate < 8_000 || sampleRate > 192_000 ||
            ![8, 16, 24, 32].includes(bits) || blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign) {
          throw new AudioVerificationError('unsupported_format');
        }
        format = { channels, sampleRate, byteRate, blockAlign, bits };
        if (chunkSize % 2) await cursor.skip(1);
      } else if (chunkName === 'data') {
        dataBytes += chunkSize;
        await cursor.skip(paddedSize);
      } else {
        await cursor.skip(paddedSize);
      }
    }
    if (cursor.bytesRead !== size || await cursor.hasTrailingBytes() || !format || dataBytes <= 0 || dataBytes % format.blockAlign !== 0) {
      throw new AudioVerificationError('audio_invalid');
    }
    const durationSeconds = dataBytes / format.byteRate;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_AUDIO_SECONDS) throw new AudioVerificationError('unsupported_format');
    return durationSeconds;
  } finally { stream.destroy(); }
}

let codecTail: Promise<void> = Promise.resolve();
async function withCodecSlot<T>(run: () => Promise<T>): Promise<T> {
  const previous = codecTail;
  let finish!: () => void;
  codecTail = new Promise<void>((resolve) => { finish = resolve; });
  await previous;
  try { return await run(); }
  finally { finish(); }
}

async function runTool(path: string, args: readonly string[], signal?: AbortSignal, timeoutMs = CODEC_TIMEOUT_MS, spawnProcess: typeof spawn = spawn): Promise<string> {
  if (!isAbsolute(path) || signal?.aborted) throw new AudioVerificationError(signal?.aborted ? 'cancelled' : 'codec_unavailable');
  return await new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawnProcess(path, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { reject(new AudioVerificationError('codec_unavailable')); return; }
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let stopReason: AudioVerificationError | undefined;
    const finish = (error?: AudioVerificationError, value = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const requestStop = (reason: AudioVerificationError) => {
      if (settled || stopReason) return;
      stopReason = reason;
      child.kill('SIGKILL');
    };
    const abort = () => requestStop(new AudioVerificationError('cancelled'));
    const timer = setTimeout(() => requestStop(new AudioVerificationError('codec_timeout')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (child.stdout) child.stdout.on('data', (chunk: Buffer) => {
      if (stopReason) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_TOOL_OUTPUT_BYTES) { requestStop(new AudioVerificationError('codec_failed')); return; }
      stdout.push(chunk);
    });
    else requestStop(new AudioVerificationError('codec_failed'));
    child.stderr?.on('data', () => undefined);
    child.once('error', () => {
      // A spawn error before a PID exists proves no child owns codec/file resources.
      if (child.pid === undefined) finish(new AudioVerificationError('codec_unavailable'));
      else requestStop(new AudioVerificationError('codec_unavailable'));
    });
    child.once('close', (code) => {
      if (stopReason) finish(stopReason);
      else if (code !== 0) finish(new AudioVerificationError('codec_failed'));
      else finish(undefined, Buffer.concat(stdout).toString('utf8'));
    });
  });
}

async function verifyWithFfmpeg(options: AudioVerificationOptions): Promise<number> {
  if (!options.ffmpegPath || !options.ffprobePath) throw new AudioVerificationError('codec_unavailable');
  return withCodecSlot(async () => {
    const inputFormat: Readonly<Record<PrivateAudioFormat, string>> = { m4a: 'mov', mp3: 'mp3', wav: 'wav', webm: 'matroska', ogg: 'ogg' };
    const decoded = await runTool(options.ffmpegPath!, ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe',
      '-progress', 'pipe:1', '-nostats', '-f', inputFormat[options.expectedFormat], '-i', options.filePath, '-map', '0:a:0', '-f', 'null', '-'],
    options.signal, options.timeoutMs, options.spawnProcess);
    const decodedTimes = [...decoded.matchAll(/(?:^|\r?\n)out_time_us=(\d+)(?:\r?\n|$)/g)];
    const decodedDuration = decodedTimes.length ? Number(decodedTimes[decodedTimes.length - 1]![1]) / 1_000_000 : Number.NaN;
    if (!Number.isFinite(decodedDuration) || decodedDuration <= 0 || decodedDuration > MAX_AUDIO_SECONDS) throw new AudioVerificationError('unsupported_format');
    const output = await runTool(options.ffprobePath!, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', inputFormat[options.expectedFormat],
      '-show_entries', 'format=format_name:stream=codec_type', '-of', 'json', options.filePath], options.signal, options.timeoutMs, options.spawnProcess);
    let parsed: unknown;
    try { parsed = JSON.parse(output); } catch { throw new AudioVerificationError('codec_failed'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AudioVerificationError('codec_failed');
    const row = parsed as { format?: { format_name?: unknown }; streams?: unknown };
    const streams = row.streams;
    if (!Array.isArray(streams) || streams.length < 1 || streams.length > 16) throw new AudioVerificationError('unsupported_format');
    const audioStreams = streams.filter((item) => item && typeof item === 'object' && !Array.isArray(item) && (item as { codec_type?: unknown }).codec_type === 'audio');
    if (audioStreams.length !== 1 || typeof row.format?.format_name !== 'string') throw new AudioVerificationError('unsupported_format');
    const names: Readonly<Record<PrivateAudioFormat, readonly string[]>> = {
      m4a: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'], mp3: ['mp3'], wav: ['wav'], webm: ['matroska', 'webm'], ogg: ['ogg'],
    };
    if (!row.format.format_name.split(',').some((name) => names[options.expectedFormat].includes(name))) throw new AudioVerificationError('unsupported_format');
    return decodedDuration;
  });
}

export async function verifyPrivateAudioFile(options: AudioVerificationOptions): Promise<VerifiedPrivateAudio> {
  if (options.signal?.aborted) throw new AudioVerificationError('cancelled');
  const format = expectedFromFileName(options.fileName);
  if (!format || format !== options.expectedFormat || options.mimeType !== MIME_BY_FORMAT[format]) throw new AudioVerificationError('unsupported_format');
  if (!isAbsolute(options.filePath)) throw new AudioVerificationError('audio_invalid');
  const stat = lstatSync(options.filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 12 || stat.size > MAX_AUDIO_BYTES) throw new AudioVerificationError('audio_invalid');
  let durationSeconds: number;
  if (format === 'wav') {
    durationSeconds = await verifyWav(options.filePath, stat.size);
  } else {
    durationSeconds = await verifyWithFfmpeg(options);
  }
  return Object.freeze({ format, mimeType: MIME_BY_FORMAT[format], durationSeconds });
}
