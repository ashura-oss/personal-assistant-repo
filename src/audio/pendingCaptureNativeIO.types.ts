import type { PendingCaptureInspection } from '../storage/pendingCapture';

export type PendingCaptureNativeProbe = Readonly<{
  inspection: PendingCaptureInspection;
  /** Process-local capability. Never persist or expose it to UI. */
  sourceRelease?: Readonly<{ retry(): void }>;
}>;

export interface PendingCaptureNativeIO {
  toRelativePath(uri: string): string;
  toUri(path: string): string;
  exists(uri: string): Promise<boolean>;
  remove(uri: string): Promise<void>;
  probe(uri: string): Promise<PendingCaptureNativeProbe>;
  export(uri: string): Promise<void>;
}
