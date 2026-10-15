/** Throw when stop has not been proven to finish; the lease remains held for a retry. */
export class CaptureStillActiveError extends Error {
  constructor(message = 'The recorder may still be active. Retry stop or cancel before leaving this screen.') {
    super(message);
    this.name = 'CaptureStillActiveError';
  }
}
