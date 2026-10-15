import type { PendingCaptureControllerPort, PendingCaptureReceipt, PendingCaptureSafeStatus,
  ServerPendingCaptureAdoption } from '../audio/pendingCaptureService.types';
import type { CaptureUploadReceipt, PrivateAudioRepository } from '../../server/src/privateAudioRepository.js';

function receipt(id: string, revision: string): PendingCaptureReceipt {
  return Object.freeze({ id, revision });
}

function statusFor(value: CaptureUploadReceipt | undefined): PendingCaptureSafeStatus {
  if (value === undefined || value.status === 'consumed' || value.status === 'discarded') return Object.freeze({ kind: 'empty' });
  const ready = value.status === 'ready' && value.media !== undefined;
  const inspection = ready ? 'known' : value.status === 'failed' ? 'invalid' : value.status === 'inspect_required' ? 'unknown' : 'not_checked';
  return Object.freeze({ kind: 'pending', receipt: receipt(value.capture.id, value.capture.revision),
    phase: ready ? 'inspected' : 'needs_inspection', capturedAt: value.capture.capturedAt,
    inspection, ...(ready ? { durationSeconds: value.media!.durationSeconds } : {}), canSave: ready,
    canExport: false, canDiscard: value.status !== 'receiving', replacementOverflow: false });
}

/** Server-owned capture view. It never materializes a filesystem or Expo URI. */
export function createNodePendingCaptureController(repository: PrivateAudioRepository): PendingCaptureControllerPort {
  const readReceipt = (value: PendingCaptureReceipt) => repository.inspectCaptureById(value.id, value.revision);
  return Object.freeze({
    async getStatus() { return statusFor(repository.getLatestCaptureUploadReceipt()); },
    async inspect(value) { return statusFor(readReceipt(value)); },
    async export() { throw new Error('Server recordings are private and cannot be exported through this action.'); },
    async discard(value) {
      const current = readReceipt(value);
      if (current.status !== 'consumed' && current.status !== 'discarded') await repository.discardCaptureUpload(value.id, value.revision);
      return statusFor(repository.getLatestCaptureUploadReceipt());
    },
    async retryPendingCaptureSourceRelease() { throw new Error('No server capture source cleanup needs retry.'); },
    async readForAdoption(value): Promise<ServerPendingCaptureAdoption> {
      const current = repository.readCaptureForAdoption(value.id, value.revision);
      if (!current.media) throw new Error('The uploaded recording is not ready to save. Check its status.');
      return Object.freeze({ kind: 'server', capture: Object.freeze({
        id: current.capture.id, revision: current.capture.revision, capturedAt: current.capture.capturedAt,
        captureTimeZone: current.capture.timeZone, durationSeconds: current.media.durationSeconds,
        media: Object.freeze({ uploadId: current.uploadId, mediaId: current.media.mediaId.slice('still-media:'.length),
          sha256: current.media.sha256, byteLength: current.media.byteLength, format: current.media.format, mimeType: current.media.mimeType }),
      }), uri: current.media.mediaId });
    },
    async readConsumedEvidence(id) { return repository.readConsumedCaptureEvidence(id); },
  });
}
