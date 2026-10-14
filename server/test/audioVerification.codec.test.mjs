import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDurableKernel } from '../dist/index.js';
import { PrivateAudioRepository } from '../dist/privateAudioRepository.js';

const ffmpegPath = process.env.STILL_TEST_FFMPEG_PATH;
const ffprobePath = process.env.STILL_TEST_FFPROBE_PATH;
const codecsAvailable = Boolean(ffmpegPath && ffprobePath);
const encoders = [
  { extension: 'm4a', mimeType: 'audio/mp4', format: 'ipod', codec: 'aac' },
  { extension: 'mp3', mimeType: 'audio/mpeg', format: 'mp3', codec: 'libmp3lame' },
  { extension: 'webm', mimeType: 'audio/webm', format: 'webm', codec: 'libopus' },
  { extension: 'ogg', mimeType: 'audio/ogg', format: 'ogg', codec: 'libopus' },
];

async function* chunks(bytes) {
  for (let offset = 0; offset < bytes.length; offset += 8192) yield bytes.subarray(offset, Math.min(offset + 8192, bytes.length));
}

test('configured FFmpeg fully decodes compressed formats and repository stores only verified bytes', { skip: !codecsAvailable }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-codec-integration-'));
  let kernel;
  try {
    const audioFiles = [];
    for (const item of encoders) {
      const output = join(directory, `fixture.${item.extension}`);
      const generated = spawnSync(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=16000',
        '-vn', '-ac', '1', '-c:a', item.codec, '-f', item.format, output], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 30_000 });
      assert.equal(generated.error, undefined, generated.error?.message);
      assert.equal(generated.status, 0, generated.stderr || `FFmpeg failed to encode ${item.extension}`);
      const bytes = await import('node:fs/promises').then(({ readFile }) => readFile(output));
      assert.ok(bytes.byteLength > 100 && bytes.byteLength < 1024 * 1024);
      audioFiles.push({ ...item, output, bytes });
    }

    const ownerId = randomUUID();
    kernel = createDurableKernel({ databasePath: join(directory, 'workspace.sqlite'), validateSnapshot(value) {
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    } });
    const workspace = kernel.createWorkspace(ownerId, { notes: [] });
    const actorSessionToken = kernel.createSession(workspace.workspaceId, ownerId, Date.now() + 60 * 60_000);
    const repository = new PrivateAudioRepository({ kernel, actorSessionToken, privateRoot: join(directory, 'private-audio'), processId: randomUUID(),
      ffmpegPath, ffprobePath, resolveAttachedMedia: () => undefined });

    for (const item of audioFiles) {
      const record = await repository.ingest(chunks(item.bytes), { fileName: `fixture.${item.extension}`, mimeType: item.mimeType,
        expectedByteLength: item.bytes.byteLength });
      assert.equal(record.status, 'ready');
      assert.equal(record.format, item.extension);
      assert.equal(record.byteLength, item.bytes.byteLength);
      assert.equal(typeof record.sha256, 'string');
      assert.ok(record.durationSeconds > 0.8 && record.durationSeconds < 1.2, `${item.extension} duration ${record.durationSeconds}`);

      const truncated = item.bytes.subarray(0, Math.min(32, item.bytes.byteLength));
      await assert.rejects(repository.ingest(chunks(truncated), { fileName: `broken.${item.extension}`, mimeType: item.mimeType }),
        /audio_invalid|unsupported_format|codec_failed/i, `truncated ${item.extension} must fail full-file verification`);
    }

    const wrongMime = audioFiles.find((item) => item.extension === 'mp3');
    assert.ok(wrongMime);
    writeFileSync(join(directory, 'mislabelled.wav'), wrongMime.bytes);
    await assert.rejects(repository.ingest(chunks(wrongMime.bytes), { fileName: 'mislabelled.wav', mimeType: 'audio/wav' }), /audio_invalid|unsupported_format/i);
  } finally {
    try { kernel?.close(); } catch {}
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
