import type { PendingCaptureRecord } from '../storage/pendingCapture';
import type { PrivacyService, PrivacyWorkspaceSession } from '../privacy/service';
import type { PrivacyWriterScope } from '../privacy/types';
import type { PendingCaptureNativeIO } from './pendingCaptureNativeIO.types';

export type PendingCaptureReceipt = Readonly<{ id: string; revision: string }>;

export type ServerPendingCapture = Readonly<{
  id: string;
  revision: string;
  capturedAt: string;
  captureTimeZone: string;
  durationSeconds: number;
  media: Readonly<{
    uploadId: string;
    mediaId: string;
    sha256: string;
    byteLength: number;
    format: 'm4a' | 'mp3' | 'wav' | 'webm' | 'ogg';
    mimeType: string;
  }>;
}>;

export type ServerPendingCaptureAdoption = Readonly<{
  kind: 'server';
  capture: ServerPendingCapture;
  uri: `still-media:${string}`;
}>;

export type ServerPendingCaptureConsumption = Readonly<{
  id: string;
  revision: string;
  noteId: string;
  uploadId: string;
  mediaId: string;
  sha256: string;
  byteLength: number;
  format: ServerPendingCapture['media']['format'];
  mimeType: string;
  durationSeconds: number;
  capturedAt: string;
  captureTimeZone: string;
}>;

export type PendingCaptureSafeStatus =
  | Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'blocked'; reason: 'unsupported' | 'unreadable' | 'unavailable' | 'cleanup_required' }>
  | Readonly<{
      kind: 'pending'; receipt: PendingCaptureReceipt; phase: PendingCaptureRecord['phase']; capturedAt: string;
      inspection: 'not_checked' | 'known' | 'unknown' | 'invalid' | 'missing'; durationSeconds?: number;
      canSave: boolean; canExport: boolean; canDiscard: boolean; replacementOverflow: boolean;
    }>;

export type PendingCapturePrepareInput = Readonly<{ uri: string; capturedAt: string; captureTimeZone: string }>;
export type PendingCaptureObservation = Readonly<{ replacementUris?: readonly string[]; replacementOverflow?: boolean }>;
export type PendingCaptureInspectionReceipt = Readonly<{ receipt: PendingCaptureReceipt; status: PendingCaptureSafeStatus }>;
export type PendingCaptureAdoption = Readonly<
  | { kind: 'native'; capture: PendingCaptureRecord; uri: string }
  | ServerPendingCaptureAdoption
>;
export type PendingCaptureJournalPort = Readonly<{
  getStatus(scope?: PrivacyWriterScope): Promise<PendingCaptureSafeStatus>;
  prepare(scope: PrivacyWriterScope, input: PendingCapturePrepareInput): Promise<PendingCaptureReceipt>;
  observe(scope: PrivacyWriterScope, receipt: PendingCaptureReceipt, observation: PendingCaptureObservation): Promise<PendingCaptureReceipt>;
  stopped(scope: PrivacyWriterScope, receipt: PendingCaptureReceipt, observation: PendingCaptureObservation): Promise<PendingCaptureReceipt>;
  released(): void;
  discard(scope: PrivacyWriterScope | undefined, receipt: PendingCaptureReceipt, observation?: PendingCaptureObservation): Promise<PendingCaptureSafeStatus>;
  discardUnjournaled(scope: PrivacyWriterScope | undefined, uri: string): Promise<PendingCaptureSafeStatus>;
}>;

/** Private controller capability. Never expose this object to UI or portable state. */
export type PendingCaptureControllerPort = Readonly<{
  getStatus(): Promise<PendingCaptureSafeStatus>;
  inspect(receipt: PendingCaptureReceipt): Promise<PendingCaptureSafeStatus>;
  export(receipt: PendingCaptureReceipt): Promise<void>;
  discard(receipt: PendingCaptureReceipt): Promise<PendingCaptureSafeStatus>;
  retryPendingCaptureSourceRelease(): Promise<PendingCaptureSafeStatus>;
  readForAdoption(receipt: PendingCaptureReceipt): Promise<PendingCaptureAdoption>;
  readConsumedEvidence(id: string): Promise<boolean>;
}>;

export type PendingCaptureServiceDependencies = Readonly<{
  backend: import('../storage/pendingCapture').PendingCaptureBackend;
  privacy: PrivacyService;
  session: PrivacyWorkspaceSession;
  nativeIO: PendingCaptureNativeIO;
  uuid?: () => string;
  now?: () => Date;
}>;
