import type { PrivacyService, PrivacyWorkspaceSession } from './service';
import type { PrivacyNamespace, PrivacyWriterScope } from './types';
import type { RecordingRecoveryService, StagedRecording, AudioRecoveryMetadata } from '../audio/recovery.types';
import { Platform } from 'react-native';
import type { NativeSpeechAudioIO, SpeechAudioService } from '../audio/speechUpload.types';

export type AudioCaptureNamespace = 'browser_audio' | 'native_recordings';

export interface PrivacyAudioBinding {
  readonly privacy: PrivacyService;
  readonly session: PrivacyWorkspaceSession;
  readonly captureNamespace: AudioCaptureNamespace;
}

export interface PrivacyCaptureSession {
  /** Resolves when permission/setup and recorder start have completed under the lease. */
  readonly ready: Promise<void>;
  /** Pause/resume operations share the active capture lease without nesting another lock. */
  runAction<T>(work: (scope: PrivacyWriterScope) => Promise<T>): Promise<T>;
  /** The writer lease remains held through the actual stop, persistence, and mode reset. */
  stop<T>(actualStopAndReset: (scope: PrivacyWriterScope) => Promise<T>): Promise<T>;
}

/** Throw when stop has not been proven to finish; the lease remains held for a retry. */
export class CaptureStillActiveError extends Error {
  constructor(message = 'The recorder may still be active. Retry stop or cancel before leaving this screen.') {
    super(message);
    this.name = 'CaptureStillActiveError';
  }
}

export interface PrivacyAudioBoundary {
  readonly binding: PrivacyAudioBinding;
  assertCurrent(): Promise<void>;
  withAudioRead<T>(actualRead: (scope: PrivacyWriterScope) => Promise<T>): Promise<T>;
  withAudioWrite<T>(actualWrite: (scope: PrivacyWriterScope) => Promise<T>): Promise<T>;
  beginCapture(actualPermissionPrepareAndStart: (scope: PrivacyWriterScope) => Promise<void>): PrivacyCaptureSession;
  withRecordingPicker<T>(pickCopyAndCleanup: () => Promise<T>): Promise<T>;
  withBackupPicker<T>(pickReadAndCleanup: () => Promise<T>): Promise<T>;
  withRecoveryIO<T>(actualIO: () => Promise<T>): Promise<T>;
}

function snapshotBinding(binding: PrivacyAudioBinding): PrivacyAudioBinding {
  const session = Object.freeze({ epoch: binding.session.epoch, runtimeId: binding.session.runtimeId });
  return Object.freeze({ privacy: binding.privacy, session, captureNamespace: binding.captureNamespace });
}

export function createPrivacyAudioBoundary(bindingInput: PrivacyAudioBinding): PrivacyAudioBoundary {
  const binding = snapshotBinding(bindingInput);
  const { privacy, session } = binding;

  const withWriter = <T>(
    descriptor: { kind: 'audio_capture' | 'recording_recovery' | 'picker_cache'; namespace: PrivacyNamespace },
    actualIO: (scope: PrivacyWriterScope) => Promise<T>,
  ) => privacy.withWriter(session.epoch, descriptor, async (_lease, scope) => {
    let result: T;
    try {
      result = await actualIO(scope);
    } catch (error) {
      await privacy.assertWorkspaceEpoch(session.epoch);
      throw error;
    }
    await privacy.assertWorkspaceEpoch(session.epoch);
    return result;
  });

  return Object.freeze({
    binding,
    assertCurrent: () => privacy.assertWorkspaceEpoch(session.epoch),
    withAudioRead: <T>(actualRead: (scope: PrivacyWriterScope) => Promise<T>): Promise<T> => withWriter(
      { kind: 'audio_capture', namespace: binding.captureNamespace },
      async (scope) => actualRead(scope),
    ),
    withAudioWrite: <T>(actualWrite: (scope: PrivacyWriterScope) => Promise<T>): Promise<T> => withWriter(
      { kind: 'audio_capture', namespace: binding.captureNamespace },
      async (scope) => actualWrite(scope),
    ),
    beginCapture(actualStart: (scope: PrivacyWriterScope) => Promise<void>) {
      let readyResolve!: () => void;
      let readyReject!: (error: unknown) => void;
      const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      type StopRequest = { work: (scope: PrivacyWriterScope) => Promise<unknown>; rejectActive: (reason: unknown) => void };
      const stopRequests: StopRequest[] = [];
      let wakeStopLoop: (() => void) | undefined;
      let stopRequested = false;
      let leaseFinished = false;
      let completionError: unknown;
      let readyComplete = false;
      let captureScope: PrivacyWriterScope | undefined;
      let actionQueue: Promise<void> = Promise.resolve();
      let pendingStop: Promise<unknown> | undefined;
      const completion = withWriter(
        { kind: 'audio_capture', namespace: binding.captureNamespace },
        async (scope) => {
          captureScope = scope;
          let started = false;
          try {
            await actualStart(scope);
            started = true;
          } catch (error) {
            if (!(error instanceof CaptureStillActiveError)) throw error;
            completionError = error;
            // Start may have reached the device before its final status was
            // confirmed. Report this immediately, but retain the parent lease
            // and stop loop for an explicit stop proof.
            readyReject(error);
          }
          if (started) {
            try {
              await privacy.assertWorkspaceEpoch(session.epoch);
              readyComplete = true;
              readyResolve();
            } catch {
              const error = new CaptureStillActiveError('Recording started, but its workspace status could not be confirmed. Stop and verify the recorder before leaving.');
              completionError = error;
              // The recorder may be running despite an unreadable or stale
              // workspace check. Keep the writer until actual stop settles.
              readyReject(error);
            }
          }
          while (true) {
            if (!stopRequests.length) await new Promise<void>((resolve) => { wakeStopLoop = resolve; });
            const request = stopRequests.shift();
            if (!request) continue;
            await actionQueue;
            try {
              const result = await request.work(scope);
              await privacy.assertWorkspaceEpoch(session.epoch);
              leaseFinished = true;
              completionError = undefined;
              return result;
            } catch (error) {
              if (error instanceof CaptureStillActiveError) {
                request.rejectActive(error);
                continue;
              }
              leaseFinished = true;
              throw error;
            }
          }
        },
      );
      // The lease may outlive `ready`; attach a rejection handler immediately,
      // while preserving the original promise for stop() to observe.
      void completion.catch((error) => {
        leaseFinished = true;
        completionError = error;
        readyReject(error);
        for (const request of stopRequests.splice(0)) request.rejectActive(error);
        wakeStopLoop?.();
      });
      return Object.freeze({
        ready,
        async runAction<T>(work: (scope: PrivacyWriterScope) => Promise<T>): Promise<T> {
          if (stopRequested) throw new Error('The recording is already stopping.');
          if (!readyComplete) {
            await ready;
            if (stopRequested) throw new Error('The recording is already stopping.');
          }
          const scope = captureScope;
          if (!scope) throw new Error('The recording scope is no longer available.');
          let resolveResult!: (value: T) => void;
          let rejectResult!: (reason: unknown) => void;
          const resultPromise = new Promise<T>((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
          });
          actionQueue = actionQueue.then(async () => {
            try {
              await privacy.assertWorkspaceEpoch(session.epoch);
              const result = await work(scope);
              await privacy.assertWorkspaceEpoch(session.epoch);
              resolveResult(result);
            } catch (error) {
              rejectResult(error);
            }
          });
          return resultPromise;
        },
        stop<T>(actualStopAndReset: (scope: PrivacyWriterScope) => Promise<T>): Promise<T> {
          if (pendingStop) return pendingStop as Promise<T>;
          if (leaseFinished) return Promise.reject(completionError ?? new Error('The capture lease has already ended.'));
          stopRequested = true;
          let resolve!: (value: T) => void;
          let reject!: (reason: unknown) => void;
          const result = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
          pendingStop = result;
          const settle = () => {
            if (pendingStop === result) pendingStop = undefined;
          };
          // Resolve only after the entire writer callback, final epoch assertion,
          // child-scope drain, and durable lease release have completed.
          void completion.then(
            (value) => { settle(); resolve(value as T); },
            (error) => { settle(); reject(error); },
          );
          void result.catch(() => undefined);
          stopRequests.push({
            work: actualStopAndReset,
            rejectActive: (reason) => { settle(); reject(reason); },
          });
          wakeStopLoop?.(); wakeStopLoop = undefined;
          return result;
        },
      } satisfies PrivacyCaptureSession);
    },
    async withRecordingPicker<T>(pickCopyAndCleanup: () => Promise<T>): Promise<T> {
      return withWriter({ kind: 'recording_recovery', namespace: 'recovery_audio' }, async () => {
        // The OS picker writes its copy before returning the URI. Record both
        // affected namespaces while this single shared lease is already held.
        await privacy.registerNamespace(session.epoch, 'picker_cache');
        return pickCopyAndCleanup();
      });
    },
    withBackupPicker<T>(pickReadAndCleanup: () => Promise<T>): Promise<T> {
      return withWriter({ kind: 'picker_cache', namespace: 'picker_cache' }, async () => pickReadAndCleanup());
    },
    withRecoveryIO<T>(actualIO: () => Promise<T>): Promise<T> {
      return withWriter({ kind: 'recording_recovery', namespace: 'recovery_audio' }, async () => actualIO());
    },
  });
}

/**
 * Binds the speech staging area without wrapping the timeout-limited prepare call.
 * Native filesystem methods each retain their lease until the underlying promise
 * settles; web source reads and staged-blob writes have separate exact boundaries.
 */
export function createPrivacyBoundSpeechAudioService(boundary: PrivacyAudioBoundary): SpeechAudioService {
  let servicePromise: Promise<SpeechAudioService> | undefined;
  let resolvedService: SpeechAudioService | undefined;
  let disposed = false;
  const withStaging = <T>(actual: () => Promise<T>): Promise<T> => boundary.binding.privacy.withWriter(
    boundary.binding.session.epoch,
    { kind: 'speech_upload', namespace: 'speech_staging' },
    async () => {
      let result: T;
      try { result = await actual(); }
      catch (error) { await boundary.assertCurrent(); throw error; }
      await boundary.assertCurrent();
      return result;
    },
  );
  const resolve = (): Promise<SpeechAudioService> => {
    if (disposed) return Promise.reject(new Error('Speech upload staging is no longer available in this workspace.'));
    servicePromise ??= (async () => {
      if (Platform.OS === 'web') {
        const [web, blobStore] = await Promise.all([import('../audio/speechUpload.web'), import('../audio/blobStore.web')]);
        if (disposed) throw new Error('Speech upload staging is no longer available in this workspace.');
        const service = web.createWebSpeechAudioService({
          get: (uri) => blobStore.getAudio(uri),
          withSourceRead: (actual) => boundary.withAudioRead(actual),
          withStageWrite: withStaging,
          withStageCleanup: withStaging,
        });
        if (disposed) { service.disposeMemory?.(); throw new Error('Speech upload staging is no longer available in this workspace.'); }
        resolvedService = service;
        return service;
      }
      const native = await import('../audio/speechUpload.native');
      if (disposed) throw new Error('Speech upload staging is no longer available in this workspace.');
      const io = createPrivacyBoundNativeSpeechAudioIO(native.getNativeSpeechAudioIO(), boundary, withStaging);
      const service = native.createNativeSpeechAudioService({
        io,
        withMemoryMutation: async (mutation) => boundary.binding.privacy.withWriter(
          boundary.binding.session.epoch,
          { kind: 'speech_upload', namespace: 'speech_staging' },
          async () => {
            await boundary.assertCurrent();
            if (disposed) throw new Error('Speech upload staging is no longer available in this workspace.');
            const value = mutation();
            await boundary.assertCurrent();
            return value;
          },
        ),
      });
      if (disposed) { service.disposeMemory?.(); throw new Error('Speech upload staging is no longer available in this workspace.'); }
      resolvedService = service;
      return service;
    })().catch((error) => { servicePromise = undefined; throw error; });
    return servicePromise;
  };
  return Object.freeze({
    prepare: (note, options) => resolve().then((service) => { if (disposed) throw new Error('Speech upload staging is no longer available in this workspace.'); return service.prepare(note, options); }),
    verify: (prepared, signal) => resolve().then((service) => { if (disposed) throw new Error('Speech upload staging is no longer available in this workspace.'); return service.verify(prepared, signal); }),
    release: (leaseId) => resolve().then((service) => service.release(leaseId)),
    disposeMemory() { disposed = true; resolvedService?.disposeMemory?.(); },
  });
}

/** Each native filesystem promise independently retains staging ownership to actual settlement. */
export function createPrivacyBoundNativeSpeechAudioIO(
  rawIO: NativeSpeechAudioIO,
  boundary: PrivacyAudioBoundary,
  withStaging?: <T>(actual: () => Promise<T>) => Promise<T>,
): NativeSpeechAudioIO {
  const own = withStaging ?? (<T>(actual: () => Promise<T>): Promise<T> => boundary.binding.privacy.withWriter(
    boundary.binding.session.epoch,
    { kind: 'speech_upload', namespace: 'speech_staging' },
    async () => {
      let result: T;
      try { result = await actual(); }
      catch (error) { await boundary.assertCurrent(); throw error; }
      await boundary.assertCurrent();
      return result;
    },
  ));
  return {
    cacheDirectory: rawIO.cacheDirectory,
    exists: (uri) => own(() => rawIO.exists(uri)),
    makeDirectory: (uri) => own(() => rawIO.makeDirectory(uri)),
    copy: (from, to) => own(() => rawIO.copy(from, to)),
    move: (from, to) => own(() => rawIO.move(from, to)),
    remove: (uri) => own(() => rawIO.remove(uri)),
    readHeader: (uri) => own(() => rawIO.readHeader(uri)),
    readBytes: (uri) => own(() => rawIO.readBytes(uri)),
  };
}

/** Wraps the picker+copy once; standalone inspect/remove calls receive their own leases. */
export function createPrivacyBoundRecordingRecoveryService(
  service: RecordingRecoveryService,
  boundary: PrivacyAudioBoundary,
): RecordingRecoveryService {
  return Object.freeze({
    pickAndStage: (options) => boundary.withRecordingPicker(() => service.pickAndStage(options)),
    inspect: (staged: StagedRecording, options): Promise<AudioRecoveryMetadata> =>
      boundary.withRecoveryIO(() => service.inspect(staged, options)),
    remove: (staged: StagedRecording) => boundary.withRecoveryIO(() => service.remove(staged)),
  });
}
