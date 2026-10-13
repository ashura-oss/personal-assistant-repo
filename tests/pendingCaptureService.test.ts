import { describe, expect, it } from 'vitest';
import type { PendingCaptureBackend, PendingCaptureRead, PendingCaptureRecord } from '../src/storage/pendingCapture';
import { assertPendingCaptureTransition, validatePendingCaptureRecord } from '../src/storage/pendingCapture';
import type { PrivacyService } from '../src/privacy/service';
import type { PrivacyWriterScope } from '../src/privacy/types';
import type { PendingCaptureNativeIO } from '../src/audio/pendingCaptureNativeIO.types';
import { createPendingCaptureService } from '../src/audio/pendingCaptureService';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const docDir = 'file:///mock/Documents/';
const scope = {} as PrivacyWriterScope;

function fixture(options: { probe?: PendingCaptureNativeIO['probe']; randomStart?: number } = {}) {
  let id = options.randomStart ?? 10;
  let slot: { revision: string; capture?: PendingCaptureRecord; consumedCaptureId?: string } | undefined;
  const files = new Set<string>();
  const io: PendingCaptureNativeIO = {
    toRelativePath(uri) {
      if (!uri.startsWith(docDir)) throw new Error('not app-owned');
      const path = uri.slice(docDir.length);
      if (!/^ExpoAudio\/recording-[0-9a-f-]+\.m4a$/.test(path)) throw new Error('bad path');
      return path;
    },
    toUri(path) { return `${docDir}${path}`; },
    async exists(uri) { return files.has(uri); },
    async remove(uri) { files.delete(uri); },
    async probe(uri) { return options.probe ? await options.probe(uri) : { inspection: { outcome: 'known', durationSeconds: 12.375 } }; },
    async export(uri) { if (!files.has(uri)) throw new Error('missing'); },
  };
  const backend: PendingCaptureBackend = {
    async read(): Promise<PendingCaptureRead> {
      if (!slot) return { kind: 'empty', revision: null };
      if (slot.capture) return { kind: 'valid', revision: slot.revision, capture: validatePendingCaptureRecord(slot.capture) };
      return { kind: 'empty', revision: slot.revision, ...(slot.consumedCaptureId ? { consumedCaptureId: slot.consumedCaptureId } : {}) };
    },
    async create(expected, capture) {
      if (slot || expected !== null) throw new Error('stale');
      const captureSnapshot = validatePendingCaptureRecord(capture);
      slot = { revision: uuid(id++), capture: captureSnapshot };
      return { kind: 'valid', revision: slot.revision, capture: captureSnapshot };
    },
    async update(expected, next) {
      if (!slot?.capture || slot.revision !== expected.revision || slot.capture.id !== expected.id) throw new Error('stale');
      const captureSnapshot = assertPendingCaptureTransition(slot.capture, next);
      slot = { revision: uuid(id++), capture: captureSnapshot };
      return { kind: 'valid', revision: slot.revision, capture: captureSnapshot };
    },
    async clearAfterDiscard(expected) {
      if (!slot?.capture || slot.revision !== expected.revision || slot.capture.id !== expected.id || slot.capture.phase !== 'discarding' || slot.capture.replacementOverflow) throw new Error('not discardable');
      slot = { revision: uuid(id++) };
    },
  };
  const privacy = {
    async withWriter(_epoch: string, _descriptor: unknown, callback: (lease: never, ownedScope: PrivacyWriterScope) => Promise<unknown>) { return await callback({} as never, scope); },
    async withExistingWriter(_scope: PrivacyWriterScope, _epoch: string, _descriptor: unknown, work: () => Promise<unknown>) { return await work(); },
    async assertWorkspaceEpoch() {},
  } as unknown as PrivacyService;
  const service = createPendingCaptureService({ backend, privacy, session: { epoch: uuid(1), runtimeId: uuid(2) }, nativeIO: io, uuid: () => uuid(id++), now: () => new Date('2026-10-13T03:00:00.000Z') });
  const uri = `${docDir}ExpoAudio/recording-${uuid(33)}.m4a`;
  files.add(uri);
  return { ...service, backend, files, uri, nativeIO: io, getSlot: () => slot };
}

describe('pending capture service', () => {
  it('persists before returning, inspects only the original, and exposes no file locator', async () => {
    const { journal, controller, uri, files } = fixture();
    const receipt = await journal.prepare(scope, { uri, capturedAt: '2026-10-13T02:03:04.125Z', captureTimeZone: 'Asia/Singapore' });
    expect(await journal.getStatus()).toMatchObject({ kind: 'pending', phase: 'prepared', canSave: false });
    const stopped = await journal.stopped(scope, receipt, {});
    journal.released();
    const result = await controller.inspect(stopped);
    expect(result).toMatchObject({ kind: 'pending', phase: 'inspected', inspection: 'known', durationSeconds: 12.375, canSave: true });
    expect(JSON.stringify(result)).not.toContain(uri);
    expect(files.has(uri)).toBe(true);
  });

  it('retains the native writer and file queue until a failed source detach is retried', async () => {
    let attempts = 0;
    let writerHeld = 0;
    const original = fixture({ probe: async () => ({ inspection: { outcome: 'known', durationSeconds: 4.25 }, sourceRelease: { retry() { attempts += 1; if (attempts === 1) throw new Error('detach'); } } }) });
    const privacy = {
      async withWriter(_epoch: string, _descriptor: unknown, callback: (lease: never, ownedScope: PrivacyWriterScope) => Promise<unknown>) {
        writerHeld += 1;
        try { return await callback({} as never, scope); } finally { writerHeld -= 1; }
      },
      async withExistingWriter(_scope: PrivacyWriterScope, _epoch: string, _descriptor: unknown, work: () => Promise<unknown>) { return await work(); },
      async assertWorkspaceEpoch() {},
    } as unknown as PrivacyService;
    const better = createPendingCaptureService({ backend: original.backend, privacy, session: { epoch: uuid(1), runtimeId: uuid(2) }, nativeIO: original.nativeIO, uuid: () => uuid(101) });
    const receipt = await better.journal.prepare(scope, { uri: original.uri, capturedAt: '2026-10-13T02:03:04.125Z', captureTimeZone: 'UTC' });
    const stopped = await better.journal.stopped(scope, receipt, {});
    better.journal.released();
    await expect(better.controller.inspect(stopped)).rejects.toThrow(/source could not be released/i);
    expect(await better.controller.getStatus()).toEqual({ kind: 'blocked', reason: 'cleanup_required' });
    expect(writerHeld).toBe(1);
    expect(attempts).toBe(0);
    await expect(better.controller.retryPendingCaptureSourceRelease()).rejects.toThrow('detach');
    expect(writerHeld).toBe(1);
    const recovered = await better.controller.retryPendingCaptureSourceRelease();
    expect(recovered).toMatchObject({ kind: 'pending', inspection: 'known', canSave: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writerHeld).toBe(0);
    expect(attempts).toBe(2);
  });

  it('makes discard sticky until every tracked file is absent', async () => {
    const { journal, controller, uri, files } = fixture();
    const receipt = await journal.prepare(scope, { uri, capturedAt: '2026-10-13T02:03:04.125Z', captureTimeZone: 'UTC' });
    const stopped = await journal.stopped(scope, receipt, {});
    journal.released();
    const replacement = `${uri.slice(0, uri.lastIndexOf('/'))}/recording-${uuid(34)}.m4a`;
    files.add(replacement);
    const observed = await journal.observe(scope, stopped, { replacementUris: [replacement] });
    const result = await controller.discard(observed);
    expect(result).toEqual({ kind: 'empty' });
    expect(files.size).toBe(0);
    expect(await controller.getStatus()).toEqual({ kind: 'empty' });
  });

  it('allows the active capture scope to discard its own capture and rejects arbitrary unjournaled paths', async () => {
    const { journal, controller, uri, files } = fixture();
    const receipt = await journal.prepare(scope, { uri, capturedAt: '2026-10-13T02:03:04.125Z', captureTimeZone: 'UTC' });
    await expect(journal.discard(scope, receipt)).resolves.toEqual({ kind: 'empty' });
    expect(files.size).toBe(0);
    const forged = `${docDir}ExpoAudio/recording-${uuid(66)}.m4a`;
    files.add(forged);
    await expect(journal.discardUnjournaled(scope, forged)).rejects.toThrow(/active recording/i);
    expect(files.has(forged)).toBe(true);
    journal.released();
    expect(await controller.getStatus()).toEqual({ kind: 'empty' });
  });

  it('recovers an internal observation whose update committed but acknowledgement was lost', async () => {
    const { journal, backend, uri, getSlot } = fixture();
    const receipt = await journal.prepare(scope, { uri, capturedAt: '2026-10-13T02:03:04.125Z', captureTimeZone: 'UTC' });
    const stopped = await journal.stopped(scope, receipt, {});
    const replacement = `${docDir}ExpoAudio/recording-${uuid(77)}.m4a`;
    const update = backend.update.bind(backend);
    let loseAck = true;
    backend.update = async (...args) => {
      const result = await update(...args);
      if (loseAck) { loseAck = false; throw new Error('lost acknowledgement'); }
      return result;
    };
    await expect(journal.observe(scope, stopped, { replacementUris: [replacement] })).rejects.toThrow('lost acknowledgement');
    const recovered = await journal.observe(scope, stopped, { replacementUris: [replacement] });
    expect(recovered.revision).toBe(getSlot()?.revision);
    expect(getSlot()?.capture?.replacementPaths).toHaveLength(1);
  });
});
