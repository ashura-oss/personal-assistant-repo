import type { PrivacyCleanupTarget, PrivacyControlStore, PrivacyNamespace } from './types';

export class PrivacyEraseAdapterError extends Error {
  constructor(readonly code: 'target_unavailable' | 'unsupported_target') {
    super(code === 'unsupported_target' ? 'This local data target is unavailable on this platform.' : 'Local data cleanup could not verify its authorization or target.');
    this.name = 'PrivacyEraseAdapterError';
  }
}

/** Recheck the durable, independent cleanup journal before each destructive operation. */
export async function assertCleanupTarget(
  store: PrivacyControlStore,
  target: PrivacyCleanupTarget,
  cleanupEpoch: string,
): Promise<void> {
  let state;
  try { state = await store.read(); }
  catch { throw new PrivacyEraseAdapterError('target_unavailable'); }
  if (!state.cleanup || state.cleanup.status !== 'erasing' || state.epoch !== cleanupEpoch ||
      state.cleanup.epoch !== cleanupEpoch || state.writerLeases.length !== 0 ||
      !state.cleanup.steps.some((step) => step.status === 'pending' && sameTarget(step.target, target))) {
    throw new PrivacyEraseAdapterError('target_unavailable');
  }
}

export function sameTarget(a: PrivacyCleanupTarget, b: PrivacyCleanupTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'namespace' && b.kind === 'namespace') return a.namespace === b.namespace;
  if (a.kind === 'oauth_token' && b.kind === 'oauth_token') return a.tokenRef === b.tokenRef;
  return a.kind === 'legacy_markdown' && b.kind === 'legacy_markdown' && a.path === b.path;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function safeRelativeMarkdownPath(value: string): boolean {
  return value.length > 0 && hasWellFormedUnicode(value) && new TextEncoder().encode(value).byteLength <= 1024 && value.endsWith('.md') &&
    !value.includes('\\') && !value.startsWith('/') && !value.endsWith('/') &&
    !/[:?#%<>|"*\u0000-\u001f]/.test(value) &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && !/[. ]$/.test(segment));
}

function hasWellFormedUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

export function namespaceIsKnown(value: string): value is PrivacyNamespace {
  return ['state_database', 'browser_audio', 'native_recordings', 'recovery_audio', 'speech_staging', 'picker_cache', 'markdown_mirrors', 'internal_export', 'provider_credentials', 'notifications'].includes(value);
}

export function validateCleanupEpoch(value: string): void {
  if (!isUuid(value)) throw new PrivacyEraseAdapterError('target_unavailable');
}
