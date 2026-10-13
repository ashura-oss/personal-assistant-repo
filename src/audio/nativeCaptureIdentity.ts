export type NativeCaptureAnchor = { capturedAt: string; captureTimeZone: string };

export type NativeCaptureIdentitySnapshot = {
  originalUri: string | null;
  anchor: NativeCaptureAnchor | null;
  originalDurationSeconds: number;
  resetObserved: boolean;
  recoveryRequired: boolean;
  replacementUris: readonly string[];
  replacementOverflow: boolean;
};

/** Tracks which recorder file and capture anchor belong to this single recording. */
export class NativeCaptureIdentity {
  private originalUri: string | null = null;
  private anchor: NativeCaptureAnchor | null = null;
  private originalDurationSeconds = 0;
  private resetObserved = false;
  private recoveryRequired = false;
  private replacementUris = new Set<string>();
  private replacementOverflow = false;

  begin(originalUri: string | null | undefined, anchor: NativeCaptureAnchor): void {
    this.originalUri = originalUri || null;
    this.anchor = { ...anchor };
    this.originalDurationSeconds = 0;
    this.resetObserved = false;
    this.recoveryRequired = !this.originalUri;
    this.replacementUris.clear();
    this.replacementOverflow = false;
  }

  observe(uri: string | null | undefined, mediaServicesDidReset = false): NativeCaptureIdentitySnapshot {
    if (!this.anchor) return this.snapshot();
    if (mediaServicesDidReset) {
      this.resetObserved = true;
      this.recoveryRequired = true;
    }
    if (!this.originalUri) {
      this.recoveryRequired = true;
    } else if (!uri || uri !== this.originalUri) {
      this.recoveryRequired = true;
      if (uri && uri !== this.originalUri) {
        if (!this.replacementUris.has(uri)) {
          if (this.replacementUris.size < 16) this.replacementUris.add(uri);
          else this.replacementOverflow = true;
        }
      }
    }
    return this.snapshot();
  }

  observeDuration(uri: string | null | undefined, durationSeconds: number): void {
    if (uri !== this.originalUri || this.recoveryRequired || !Number.isFinite(durationSeconds) || durationSeconds < 0) return;
    this.originalDurationSeconds = Math.max(this.originalDurationSeconds, durationSeconds);
  }

  markRecoveryRequired(): void {
    if (this.anchor) this.recoveryRequired = true;
  }

  snapshot(): NativeCaptureIdentitySnapshot {
    return {
      originalUri: this.originalUri,
      anchor: this.anchor ? { ...this.anchor } : null,
      originalDurationSeconds: this.originalDurationSeconds,
      resetObserved: this.resetObserved,
      recoveryRequired: this.recoveryRequired,
      replacementUris: [...this.replacementUris],
      replacementOverflow: this.replacementOverflow,
    };
  }

  clear(): void {
    this.originalUri = null;
    this.anchor = null;
    this.originalDurationSeconds = 0;
    this.resetObserved = false;
    this.recoveryRequired = false;
    this.replacementUris.clear();
    this.replacementOverflow = false;
  }
}
