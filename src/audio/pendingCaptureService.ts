import type { PendingCaptureInspection, PendingCaptureRead } from '../storage/pendingCapture';
import { assertPendingCaptureTransition, validatePendingCapturePath, validatePendingCaptureRecord, validatePendingCaptureUuid } from '../storage/pendingCapture';
import * as Crypto from 'expo-crypto';
import type { PrivacyWriterScope } from '../privacy/types';
import type { PendingCaptureNativeProbe } from './pendingCaptureNativeIO.types';
import type {
  PendingCaptureAdoption, PendingCaptureJournalPort, PendingCaptureObservation, PendingCapturePrepareInput,
  PendingCaptureControllerPort, PendingCaptureReceipt, PendingCaptureSafeStatus, PendingCaptureServiceDependencies,
} from './pendingCaptureService.types';

const APP_STATE = { kind: 'app_state' as const, namespace: 'state_database' as const };
const NATIVE_RECORDINGS = { kind: 'audio_capture' as const, namespace: 'native_recordings' as const };
const GENERIC_UNAVAILABLE = 'Pending recording is unavailable. Review its status and try again.';

type RetainedRelease = {
  retry(): Promise<PendingCaptureSafeStatus>;
  completion: Promise<PendingCaptureSafeStatus>;
  operation: Promise<PendingCaptureSafeStatus>;
  complete(status: PendingCaptureSafeStatus): void;
  fail(error: unknown): void;
  detached: boolean;
  retryInFlight?: Promise<PendingCaptureSafeStatus>;
};

function cleanReceipt(value: PendingCaptureReceipt): PendingCaptureReceipt {
  return Object.freeze({ id: validatePendingCaptureUuid(value?.id), revision: validatePendingCaptureUuid(value?.revision) });
}

function safeStatus(read: PendingCaptureRead): PendingCaptureSafeStatus {
  if (read.kind === 'blocked') return Object.freeze({ kind: 'blocked', reason: read.reason === 'unsupported' ? 'unsupported' : 'unreadable' });
  if (read.kind === 'empty') return Object.freeze({ kind: 'empty' });
  const capture = read.capture;
  const inspection = capture.inspection?.outcome ?? 'not_checked';
  const canSave = capture.phase === 'inspected' && inspection === 'known' &&
    capture.inspection?.outcome === 'known' && capture.inspection.durationSeconds > 0 && capture.inspection.durationSeconds <= 600 &&
    !capture.replacementOverflow && capture.replacementPaths.length === 0;
  return Object.freeze({
    kind: 'pending', receipt: Object.freeze({ id: capture.id, revision: read.revision }), phase: capture.phase,
    capturedAt: capture.capturedAt, inspection,
    ...(capture.inspection?.outcome === 'known' ? { durationSeconds: capture.inspection.durationSeconds } : {}),
    canSave, canExport: capture.phase !== 'discarding' && inspection !== 'missing', canDiscard: true,
    replacementOverflow: capture.replacementOverflow,
  });
}

function canonicalDate(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error('Capture start time is invalid.');
  return value;
}

function canonicalTimeZone(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Capture time zone is invalid.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0); }
  catch { throw new Error('Capture time zone is invalid.'); }
  return value;
}

function copyObservation(input: PendingCaptureObservation = {}): PendingCaptureObservation {
  if (input.replacementUris !== undefined && (!Array.isArray(input.replacementUris) || input.replacementUris.length > 64 || input.replacementUris.some((uri) => typeof uri !== 'string'))) {
    throw new Error('Recording replacement observations are invalid.');
  }
  if (input.replacementOverflow !== undefined && typeof input.replacementOverflow !== 'boolean') throw new Error('Recording replacement observations are invalid.');
  return Object.freeze({ ...(input.replacementUris ? { replacementUris: Object.freeze([...input.replacementUris]) } : {}), ...(input.replacementOverflow ? { replacementOverflow: true } : {}) });
}

export function createPendingCaptureService(dependencies: PendingCaptureServiceDependencies): { journal: PendingCaptureJournalPort; controller: PendingCaptureControllerPort } {
  const { backend, privacy, nativeIO } = dependencies;
  const session = Object.freeze({ epoch: dependencies.session.epoch, runtimeId: dependencies.session.runtimeId });
  const uuid = dependencies.uuid ?? (() => Crypto.randomUUID());
  let queue: Promise<void> = Promise.resolve();
  let activeCaptureId: string | undefined;
  let activeCaptureIdentity: { id: string; originalPath: string; capturedAt: string; captureTimeZone: string } | undefined;
  let liveCapture = false;
  let retained: RetainedRelease | undefined;
  let retainedPublicResult: PendingCaptureSafeStatus | undefined;
  const failedPrepareUris = new Set<string>();

  const enqueue = async <T,>(work: () => Promise<T>): Promise<T> => {
    const previous = queue;
    let unlock!: () => void;
    queue = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try { return await work(); } finally { unlock(); }
  };
  const withStore = <T,>(scope: PrivacyWriterScope, work: () => Promise<T>) => privacy.withExistingWriter(scope, session.epoch, APP_STATE, work);
  const withNativeWriter = <T,>(work: (scope: PrivacyWriterScope) => Promise<T>) => privacy.withWriter(session.epoch, NATIVE_RECORDINGS, async (_lease, scope) => work(scope));
  const withNativeQueue = <T,>(scope: PrivacyWriterScope, work: () => Promise<T>) => {
    if (retained) return Promise.reject(new Error('Pending recording source cleanup must finish before another file action.'));
    return privacy.withExistingWriter(scope, session.epoch, NATIVE_RECORDINGS, () => enqueue(async () => {
      await privacy.assertWorkspaceEpoch(session.epoch);
      return work();
    }));
  };
  const getCurrent = async (scope: PrivacyWriterScope) => withStore(scope, () => backend.read());
  const requireCurrent = async (scope: PrivacyWriterScope, receipt: PendingCaptureReceipt): Promise<Extract<PendingCaptureRead, { kind: 'valid' }>> => {
    const read = await getCurrent(scope);
    if (read.kind !== 'valid' || read.capture.id !== receipt.id || read.revision !== receipt.revision) throw new Error(GENERIC_UNAVAILABLE);
    return read;
  };
  const createId = () => validatePendingCaptureUuid(uuid());

  const statusOwned = async (scope?: PrivacyWriterScope): Promise<PendingCaptureSafeStatus> => {
    if (retained) return Object.freeze({ kind: 'blocked', reason: 'cleanup_required' });
    try {
      if (scope) {
        return await privacy.withExistingWriter(scope, session.epoch, APP_STATE, () =>
          enqueue(async () => safeStatus(await getCurrent(scope))));
      }
      return await privacy.withWriter(session.epoch, APP_STATE, async (_lease, scope) => {
        return await enqueue(async () => safeStatus(await getCurrent(scope)));
      });
    } catch { return Object.freeze({ kind: 'blocked', reason: 'unavailable' }); }
  };

  const observeUnderLease = async (scope: PrivacyWriterScope, receipt: PendingCaptureReceipt, observationValue: PendingCaptureObservation, phase?: 'needs_inspection'): Promise<PendingCaptureReceipt> => {
    const observation = copyObservation(observationValue);
    const current = await getCurrent(scope);
    if (current.kind !== 'valid') throw new Error(GENERIC_UNAVAILABLE);
    if (current.capture.id !== receipt.id || current.revision !== receipt.revision) {
      const identity = activeCaptureIdentity;
      if (activeCaptureId !== receipt.id || !identity || current.capture.id !== identity.id || current.capture.originalPath !== identity.originalPath || current.capture.capturedAt !== identity.capturedAt || current.capture.captureTimeZone !== identity.captureTimeZone) throw new Error(GENERIC_UNAVAILABLE);
    }
    const effectiveReceipt = Object.freeze({ id: current.capture.id, revision: current.revision });
    let overflow = current.capture.replacementOverflow || observation.replacementOverflow === true;
    const known = new Map(current.capture.replacementPaths.map((path) => [path.toLowerCase(), path]));
    for (const uri of observation.replacementUris ?? []) {
      try {
        const path = validatePendingCapturePath(nativeIO.toRelativePath(uri));
        if (!known.has(path.toLowerCase())) known.set(path.toLowerCase(), path);
      }
      catch { overflow = true; }
    }
    if (known.has(current.capture.originalPath.toLowerCase())) { known.delete(current.capture.originalPath.toLowerCase()); overflow = true; }
    const paths = [...known.values()].slice(0, 16);
    if (known.size > 16) overflow = true;
    const desiredPhase = current.capture.phase === 'discarding' ? 'discarding' : phase ?? current.capture.phase;
    const changed = paths.length !== current.capture.replacementPaths.length || paths.some((path) => !current.capture.replacementPaths.some((old) => old.toLowerCase() === path.toLowerCase())) || overflow !== current.capture.replacementOverflow || desiredPhase !== current.capture.phase;
    if (!changed) return effectiveReceipt;
    const next = validatePendingCaptureRecord({ ...current.capture, phase: desiredPhase, replacementPaths: paths, replacementOverflow: overflow, ...(desiredPhase === 'needs_inspection' ? { inspection: undefined } : {}) });
    const result = await withStore(scope, () => backend.update(effectiveReceipt, assertPendingCaptureTransition(current.capture, next)));
    if (result.kind !== 'valid') throw new Error(GENERIC_UNAVAILABLE);
    return Object.freeze({ id: result.capture.id, revision: result.revision });
  };

  const persistInspection = async (scope: PrivacyWriterScope, receipt: PendingCaptureReceipt, inspection: PendingCaptureInspection): Promise<PendingCaptureSafeStatus> => {
    let current = await getCurrent(scope);
    if (current.kind !== 'valid' || current.capture.id !== receipt.id || current.revision !== receipt.revision) throw new Error(GENERIC_UNAVAILABLE);
    if (current.capture.phase === 'discarding') throw new Error('This recording is being discarded.');
    // Replacement files are removed and verified before their paths are cleared.
    for (const path of current.capture.replacementPaths) {
      const uri = nativeIO.toUri(path);
      if (await nativeIO.exists(uri)) await nativeIO.remove(uri);
      if (await nativeIO.exists(uri)) throw new Error('A replacement recording file could not be removed.');
    }
    current = await getCurrent(scope);
    if (current.kind !== 'valid' || current.capture.id !== receipt.id || current.revision !== receipt.revision) throw new Error(GENERIC_UNAVAILABLE);
    const capture = validatePendingCaptureRecord({ ...current.capture, phase: 'inspected', inspection, replacementPaths: [] });
    const updated = await withStore(scope, () => backend.update({ id: current.capture.id, revision: current.revision }, capture));
    return safeStatus(updated);
  };

  const discardWork = async (ownedScope: PrivacyWriterScope, receipt: PendingCaptureReceipt, observation: PendingCaptureObservation = {}): Promise<PendingCaptureSafeStatus> => {
    let current: PendingCaptureRead = await requireCurrent(ownedScope, receipt);
    let activeReceipt: PendingCaptureReceipt = receipt;
    if (current.capture.phase !== 'discarding') {
      const next = validatePendingCaptureRecord({ ...current.capture, phase: 'discarding' });
      const changed = await withStore(ownedScope, () => backend.update(receipt, next));
      if (changed.kind !== 'valid') throw new Error(GENERIC_UNAVAILABLE);
      activeReceipt = { id: changed.capture.id, revision: changed.revision };
      current = changed;
    }
    await observeUnderLease(ownedScope, activeReceipt, observation);
    current = await getCurrent(ownedScope);
    if (current.kind !== 'valid' || current.capture.id !== activeReceipt.id) throw new Error(GENERIC_UNAVAILABLE);
    const paths = [current.capture.originalPath, ...current.capture.replacementPaths];
    for (const path of paths) {
      const uri = nativeIO.toUri(path);
      if (await nativeIO.exists(uri)) await nativeIO.remove(uri);
    }
    for (const path of paths) if (await nativeIO.exists(nativeIO.toUri(path))) throw new Error('A pending recording file could not be removed.');
    if (current.capture.replacementOverflow) return safeStatus(current);
    await withStore(ownedScope, () => backend.clearAfterDiscard({ id: current.capture.id, revision: current.revision }));
    if (activeCaptureId === current.capture.id) { activeCaptureId = undefined; activeCaptureIdentity = undefined; }
    return Object.freeze({ kind: 'empty' });
  };

  const internal = Object.freeze({
    getStatus: statusOwned,
    async prepare(scope: PrivacyWriterScope, input: PendingCapturePrepareInput) {
      const inputSnapshot = Object.freeze({ uri: input.uri, capturedAt: canonicalDate(input.capturedAt), captureTimeZone: canonicalTimeZone(input.captureTimeZone) });
      return withNativeQueue(scope, async () => {
        const path = validatePendingCapturePath(nativeIO.toRelativePath(inputSnapshot.uri));
        const current = await getCurrent(scope);
        if (current.kind !== 'empty') throw new Error(GENERIC_UNAVAILABLE);
        const capture = validatePendingCaptureRecord({ version: 1, id: createId(), originalPath: path, capturedAt: inputSnapshot.capturedAt,
          captureTimeZone: inputSnapshot.captureTimeZone, phase: 'prepared', replacementPaths: [], replacementOverflow: false });
        failedPrepareUris.add(inputSnapshot.uri);
        const result = await withStore(scope, () => backend.create(current.revision, capture));
        if (result.kind !== 'valid') throw new Error(GENERIC_UNAVAILABLE);
        failedPrepareUris.delete(inputSnapshot.uri);
        activeCaptureId = result.capture.id;
        activeCaptureIdentity = { id: result.capture.id, originalPath: result.capture.originalPath, capturedAt: result.capture.capturedAt, captureTimeZone: result.capture.captureTimeZone };
        liveCapture = true;
        return Object.freeze({ id: result.capture.id, revision: result.revision });
      });
    },
    async observe(scope: PrivacyWriterScope, receiptValue: PendingCaptureReceipt, observation: PendingCaptureObservation) {
      const receipt = cleanReceipt(receiptValue);
      return withNativeQueue(scope, () => observeUnderLease(scope, receipt, observation));
    },
    async stopped(scope: PrivacyWriterScope, receiptValue: PendingCaptureReceipt, observation: PendingCaptureObservation) {
      const receipt = cleanReceipt(receiptValue);
      return withNativeQueue(scope, async () => {
        return observeUnderLease(scope, receipt, observation, 'needs_inspection');
      });
    },
    released() { liveCapture = false; activeCaptureId = undefined; activeCaptureIdentity = undefined; },
    async inspect(receiptValue: PendingCaptureReceipt) {
      const receipt = cleanReceipt(receiptValue);
      if (retained) throw new Error('Pending recording source cleanup must finish before another file action.');
      if (liveCapture) throw new Error('Stop the active recording before inspecting it.');
      let rejectInitial!: (error: unknown) => void;
      const initialFailure = new Promise<never>((_resolve, reject) => { rejectInitial = reject; });
      let resolveOperation!: (status: PendingCaptureSafeStatus) => void;
      let rejectOperation!: (error: unknown) => void;
      const operationDone = new Promise<PendingCaptureSafeStatus>((resolve, reject) => { resolveOperation = resolve; rejectOperation = reject; });
      void operationDone.catch(() => undefined);
      const operation = withNativeWriter(async (scope) => withNativeQueue(scope, async () => {
        const current = await requireCurrent(scope, receipt);
        if (liveCapture) throw new Error('Stop the active recording before inspecting it.');
        if (current.capture.phase === 'discarding') throw new Error('This recording is being discarded.');
        const needs = current.capture.phase === 'needs_inspection'
          ? current
          : await withStore(scope, () => backend.update(receipt, { ...current.capture, phase: 'needs_inspection', inspection: undefined }));
        if (needs.kind !== 'valid') throw new Error(GENERIC_UNAVAILABLE);
        const nextReceipt = Object.freeze({ id: needs.capture.id, revision: needs.revision });
        const uri = nativeIO.toUri(needs.capture.originalPath);
        let probe: PendingCaptureNativeProbe;
        if (!await nativeIO.exists(uri)) probe = { inspection: { outcome: 'missing' } };
        else probe = await nativeIO.probe(uri);
        if (probe.sourceRelease) {
          let complete!: (status: PendingCaptureSafeStatus) => void;
          let fail!: (error: unknown) => void;
          const completion = new Promise<PendingCaptureSafeStatus>((resolve, reject) => { complete = resolve; fail = reject; });
          const retainedEntry: RetainedRelease = {
            completion, complete, fail, operation: operationDone, detached: false,
            retry() {
              if (retainedEntry.retryInFlight) return retainedEntry.retryInFlight;
              const attempt = (async () => {
                // A returned release handle means detachment already failed. Only
                // an explicit user retry may invoke it.
                probe.sourceRelease!.retry();
                retainedEntry.detached = true;
                let status: PendingCaptureSafeStatus;
                try {
                  status = await persistInspection(scope, nextReceipt, probe.inspection);
                } catch (error) {
                  retainedEntry.fail(error);
                  try { await retainedEntry.operation; } catch { /* Wait for the real writer callback and lease release. */ }
                  if (retained === retainedEntry) retained = undefined;
                  retainedPublicResult = undefined;
                  throw new Error(GENERIC_UNAVAILABLE);
                }
                retainedEntry.complete(status);
                try {
                  const settled = await retainedEntry.operation;
                  if (retained === retainedEntry) retained = undefined;
                  retainedPublicResult = settled;
                  return settled;
                } catch (error) {
                  if (retained === retainedEntry && retainedEntry.detached) retained = undefined;
                  retainedPublicResult = undefined;
                  throw error;
                }
              })();
              retainedEntry.retryInFlight = attempt;
              void attempt.finally(() => { if (retainedEntry.retryInFlight === attempt) retainedEntry.retryInFlight = undefined; }).catch(() => undefined);
              return attempt;
            },
          };
          retained = retainedEntry;
          retainedPublicResult = Object.freeze({ kind: 'blocked', reason: 'cleanup_required' });
          rejectInitial(new Error('The recording source could not be released. Retry cleanup before continuing.'));
          return await retainedEntry.completion;
        }
        return await persistInspection(scope, nextReceipt, probe.inspection);
      }));
      operation.then(resolveOperation, rejectOperation);
      return Promise.race([operation, initialFailure]);
    },
    async export(receiptValue: PendingCaptureReceipt) {
      const receipt = cleanReceipt(receiptValue);
      if (retained) throw new Error('Pending recording source cleanup must finish before another file action.');
      if (liveCapture) throw new Error('Stop the active recording before exporting it.');
      return withNativeWriter(async (scope) => withNativeQueue(scope, async () => {
        const current = await requireCurrent(scope, receipt);
        if (current.capture.phase === 'discarding') throw new Error(GENERIC_UNAVAILABLE);
        const uri = nativeIO.toUri(current.capture.originalPath);
        if (!await nativeIO.exists(uri)) throw new Error('The pending recording file is missing.');
        await nativeIO.export(uri);
      }));
    },
    async discard(scope: PrivacyWriterScope | undefined, receiptValue: PendingCaptureReceipt, observation: PendingCaptureObservation = {}) {
      const receipt = cleanReceipt(receiptValue);
      if (retained) throw new Error('Pending recording source cleanup must finish before another file action.');
      const work = async (ownedScope: PrivacyWriterScope) => withNativeQueue(ownedScope, () => discardWork(ownedScope, receipt, observation));
      if (scope) {
        if (liveCapture && activeCaptureId !== receipt.id) throw new Error('Stop the active recording before discarding it.');
        return work(scope);
      }
      if (liveCapture) throw new Error('Stop the active recording before discarding it.');
      return withNativeWriter(work);
    },
    async discardUnjournaled(scope: PrivacyWriterScope | undefined, uriValue: string) {
      if (retained) throw new Error('Pending recording source cleanup must finish before another file action.');
      if (liveCapture) throw new Error('Stop the active recording before discarding it.');
      const work = async (ownedScope: PrivacyWriterScope) => withNativeQueue(ownedScope, async () => {
        validatePendingCapturePath(nativeIO.toRelativePath(uriValue));
        const read = await getCurrent(ownedScope);
        if (read.kind !== 'empty') {
          if (read.kind === 'valid' && failedPrepareUris.has(uriValue) && nativeIO.toUri(read.capture.originalPath) === uriValue) return await discardWork(ownedScope, { id: read.capture.id, revision: read.revision });
          throw new Error(GENERIC_UNAVAILABLE);
        }
        if (!failedPrepareUris.has(uriValue)) throw new Error(GENERIC_UNAVAILABLE);
        if (await nativeIO.exists(uriValue)) await nativeIO.remove(uriValue);
        if (await nativeIO.exists(uriValue)) throw new Error('The unjournaled recording could not be removed.');
        failedPrepareUris.delete(uriValue);
        return Object.freeze({ kind: 'empty' });
      });
      if (scope) return work(scope);
      return withNativeWriter(work);
    },
    async retryPendingCaptureSourceRelease() {
      const entry = retained;
      if (!entry) {
        if (retainedPublicResult) return retainedPublicResult;
        throw new Error('No pending recording cleanup needs retry.');
      }
      return entry.retry();
    },
    async readForAdoption(receiptValue: PendingCaptureReceipt): Promise<PendingCaptureAdoption> {
      const receipt = cleanReceipt(receiptValue);
      if (retained) throw new Error('Pending recording source cleanup must finish before another file action.');
      if (liveCapture) throw new Error('Stop the active recording before saving it.');
      return withNativeWriter(async (scope) => withNativeQueue(scope, async () => {
        const current = await requireCurrent(scope, receipt);
        const status = safeStatus(current);
        if (status.kind !== 'pending' || !status.canSave || current.capture.inspection?.outcome !== 'known') throw new Error('This pending recording is not ready to save. Inspect it or remove extra files first.');
        if (await nativeIO.exists(nativeIO.toUri(current.capture.originalPath)) !== true) throw new Error('The pending recording file is missing.');
        return Object.freeze({ kind: 'native' as const, capture: current.capture, uri: nativeIO.toUri(current.capture.originalPath) });
      }));
    },
    async readConsumedEvidence(idValue: string) {
      const id = validatePendingCaptureUuid(idValue);
      if (retained) throw new Error('Pending recording source cleanup must finish before reading capture state.');
      return privacy.withWriter(session.epoch, APP_STATE, async (_lease, scope) => enqueue(async () => {
        const read = await getCurrent(scope);
        return read.kind === 'empty' && read.consumedCaptureId === id;
      }));
    },
  });

  const journal: PendingCaptureJournalPort = Object.freeze({
    getStatus: internal.getStatus,
    prepare: internal.prepare,
    observe: internal.observe,
    stopped: internal.stopped,
    released: internal.released,
    discard: internal.discard,
    discardUnjournaled: internal.discardUnjournaled,
  });
  const controller: PendingCaptureControllerPort = Object.freeze({
    getStatus: internal.getStatus,
    inspect: internal.inspect,
    export: internal.export,
    discard: (receipt) => internal.discard(undefined, receipt),
    retryPendingCaptureSourceRelease: internal.retryPendingCaptureSourceRelease,
    readForAdoption: internal.readForAdoption,
    readConsumedEvidence: internal.readConsumedEvidence,
  });
  return { journal, controller };
}
