import type { Readable } from 'node:stream';
import type { WorkspaceHttpAdmission } from './workspaceHttp.js';
import type { AudioUploadHistoryPage } from './audioUploadHistory.js';

export interface AudioUploadCaptureHeader {
  readonly id: string;
  readonly capturedAt: string;
  readonly timeZone: string;
}

export interface AudioUploadReceiptDTO {
  readonly schemaVersion: 1;
  readonly uploadId: string;
  readonly status: 'receiving' | 'ready' | 'failed' | 'inspect_required' | 'consumed' | 'discarded';
  readonly capture: Readonly<{
    id: string;
    revision: string;
    capturedAt: string;
    timeZone: string;
  }>;
  readonly consumption?: Readonly<{ commandId: string; noteId: string; noteRevision: number }>;
  readonly media?: Readonly<{
    mediaId: `still-media:${string}`;
    sha256: string;
    byteLength: number;
    durationSeconds: number;
    format: 'm4a' | 'mp3' | 'wav' | 'webm' | 'ogg';
    mimeType: string;
  }>;
}

export interface AudioHttpMediaResponse {
  readonly status: 200 | 206 | 416;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Readable;
}

/** Per-workspace private media owner. This is only one part of the top-level audio gateway. */
export interface AudioStorageHttpApi {
  upload(admission: WorkspaceHttpAdmission, input: Readonly<{
    uploadId: string;
    capture: AudioUploadCaptureHeader;
    mimeType: string;
    expectedByteLength?: number;
    source: AsyncIterable<Uint8Array>;
  }>): Promise<AudioUploadReceiptDTO>;
  inspectUpload(admission: WorkspaceHttpAdmission, uploadId: string): Promise<AudioUploadReceiptDTO>;
  openMedia(admission: WorkspaceHttpAdmission, mediaId: string, input: Readonly<{
    method: 'GET' | 'HEAD';
    range?: string;
    download?: boolean;
    signal?: AbortSignal;
  }>): Promise<AudioHttpMediaResponse>;
}

/** Trusted server-to-runtime bridge. History is read directly from the owned kernel, without loading a workspace. */
export interface AudioHttpApi extends AudioStorageHttpApi {
  listUploads(admission: WorkspaceHttpAdmission, cursor?: string): Promise<AudioUploadHistoryPage>;
}
