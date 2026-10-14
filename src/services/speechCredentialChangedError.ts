/** Shared error identity for stale Speech credential snapshots. */
export class SpeechCredentialChangedError extends Error {
  readonly name = 'SpeechCredentialChangedError';
  constructor() { super('The Azure Speech credential changed while the request was being prepared.'); }
}
