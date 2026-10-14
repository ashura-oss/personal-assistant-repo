import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyPrivateAudioFile } from '../dist/audioVerification.js';

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 9876;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

test('codec timeout requests termination but retains the serialized codec slot and file ownership until child close', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-codec-close-'));
  const filePath = join(directory, 'clip.mp3');
  writeFileSync(filePath, Buffer.from('ID3'.padEnd(32, '\0')));
  const children = [];
  let killCount = 0;
  const spawnProcess = () => {
    const child = fakeChild();
    children.push(child);
    if (children.length === 1) child.kill = () => { killCount += 1; return true; };
    else setImmediate(() => {
      child.stdout.end(children.length % 2 === 0 ? 'out_time_us=100000\n' : JSON.stringify({
        format: { format_name: 'mp3' }, streams: [{ codec_type: 'audio' }],
      }));
      child.emit('close', 0, null);
    });
    return child;
  };
  const options = { filePath, fileName: 'clip.mp3', mimeType: 'audio/mpeg', expectedFormat: 'mp3',
    ffmpegPath: process.execPath, ffprobePath: process.execPath, spawnProcess };
  try {
    let firstSettled = false;
    const first = verifyPrivateAudioFile({ ...options, timeoutMs: 15 }).finally(() => { firstSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(killCount, 1);
    assert.equal(firstSettled, false);
    const second = verifyPrivateAudioFile({ ...options, timeoutMs: 1000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(children.length, 1, 'second verification waits for the first child to actually close');
    children[0].emit('close', null, 'SIGKILL');
    await assert.rejects(first, /codec_timeout/);
    const verified = await second;
    assert.equal(verified.durationSeconds, 0.1);
    assert.equal(children.length, 3, 'only after close can ffmpeg and then ffprobe run');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a spawn error before a child has a process id is terminal without waiting for a nonexistent close event', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'still-codec-spawn-error-'));
  const filePath = join(directory, 'clip.mp3');
  writeFileSync(filePath, Buffer.from('ID3'.padEnd(32, '\0')));
  let child;
  try {
    const verification = verifyPrivateAudioFile({ filePath, fileName: 'clip.mp3', mimeType: 'audio/mpeg', expectedFormat: 'mp3',
      ffmpegPath: process.execPath, ffprobePath: process.execPath,
      spawnProcess: () => { child = fakeChild(); child.pid = undefined; setImmediate(() => child.emit('error', Object.assign(new Error('missing codec'), { code: 'ENOENT' }))); return child; } });
    await assert.rejects(verification, /codec_unavailable/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
