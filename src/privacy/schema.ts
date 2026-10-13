import {
  PRIVACY_NAMESPACES,
  type PrivacyCleanupErrorCode,
  type PrivacyCleanupJournal,
  type PrivacyCleanupStep,
  type PrivacyCleanupTarget,
  type PrivacyControlState,
  type PrivacyNamespace,
  type PrivacyOwner,
  type PrivacyPlatform,
  type PrivacyWriterKind,
  type PrivacyWriterLease,
} from './types';
import { isSupportedPrivacyBundleIdentifier } from './bundleIdentity';

export const PRIVACY_CONTROL_LIMITS = Object.freeze({
  namespaces: 10,
  oauthTokenRefs: 1_024,
  legacyMarkdownPaths: 4_096,
  writerLeases: 512,
  cleanupTargets: 5_130,
  cleanupBatch: 16,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAMESPACE_SET = new Set<string>(PRIVACY_NAMESPACES);
const WRITER_KINDS = new Set<PrivacyWriterKind>([
  'app_state', 'audio_capture', 'recording_recovery', 'speech_upload', 'picker_cache',
  'markdown_mirror', 'internal_export', 'provider_credential', 'notification',
]);
const CLEANUP_ERRORS = new Set<PrivacyCleanupErrorCode>([
  'erase_failed', 'verification_failed', 'unsupported_target', 'target_unavailable',
]);
const PLATFORMS = new Set<PrivacyPlatform>(['ios', 'web', 'unsupported']);
const encoder = new TextEncoder();

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

function fail(label: string): never {
  throw new Error(`Privacy control state ${label} is invalid.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(label);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) fail(label);
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) return fail(label);
  return value.toLowerCase();
}

function text(value: unknown, label: string, max = 2_048): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || encoder.encode(value).length > max ||
      !hasWellFormedUnicode(value) || /[\u0000-\u001f\u007f]/.test(value)) return fail(label);
  return value;
}

function canonicalDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return fail(label);
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) return fail(label);
  return value;
}

function namespace(value: unknown, label: string): PrivacyNamespace {
  if (typeof value !== 'string' || !NAMESPACE_SET.has(value)) return fail(label);
  return value as PrivacyNamespace;
}

function relativeMarkdownPath(value: unknown): string {
  const path = text(value, 'legacy markdown path', 1_024);
  if (path.includes('\\') || path.startsWith('/') || path.endsWith('/') || /[:?#%<>|"*]/.test(path) ||
      !path.endsWith('.md') ||
      path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..') ||
      path.split('/').some((segment) => /[. ]$/.test(segment))) return fail('legacy markdown path');
  return path;
}

function unique<T>(items: T[], label: string): T[] {
  if (new Set(items).size !== items.length) return fail(label);
  return items;
}

function parseOwner(input: unknown): PrivacyOwner {
  const value = record(input, 'writer owner');
  exactKeys(value, ['platform', 'runtimeId', 'processLaunchId', 'bundleIdentifier'], 'writer owner');
  if (typeof value.platform !== 'string' || !PLATFORMS.has(value.platform as PrivacyPlatform)) return fail('writer platform');
  const owner: PrivacyOwner = {
    platform: value.platform as PrivacyPlatform,
    runtimeId: uuid(value.runtimeId, 'runtime id'),
  };
  if (value.processLaunchId !== undefined) owner.processLaunchId = uuid(value.processLaunchId, 'process launch id');
  if (value.bundleIdentifier !== undefined) {
    if (!isSupportedPrivacyBundleIdentifier(value.bundleIdentifier)) return fail('bundle identifier');
    owner.bundleIdentifier = value.bundleIdentifier;
  }
  if (owner.platform === 'ios' && (!owner.processLaunchId || !isSupportedPrivacyBundleIdentifier(owner.bundleIdentifier))) return fail('native writer owner');
  if (owner.platform !== 'ios' && owner.bundleIdentifier !== undefined) return fail('bundle identifier');
  return owner;
}

function parseLease(input: unknown): PrivacyWriterLease {
  const value = record(input, 'writer lease');
  exactKeys(value, ['id', 'epoch', 'owner', 'kind', 'namespace', 'createdAt'], 'writer lease');
  if (typeof value.kind !== 'string' || !WRITER_KINDS.has(value.kind as PrivacyWriterKind)) return fail('writer kind');
  const lease: PrivacyWriterLease = {
    id: uuid(value.id, 'writer lease id'),
    epoch: uuid(value.epoch, 'writer epoch'),
    owner: parseOwner(value.owner),
    kind: value.kind as PrivacyWriterKind,
    createdAt: canonicalDate(value.createdAt, 'writer timestamp'),
  };
  if (value.namespace !== undefined) lease.namespace = namespace(value.namespace, 'writer namespace');
  return lease;
}

function parseTarget(input: unknown): PrivacyCleanupTarget {
  const value = record(input, 'cleanup target');
  if (value.kind === 'namespace') {
    exactKeys(value, ['kind', 'namespace'], 'namespace cleanup target');
    return { kind: 'namespace', namespace: namespace(value.namespace, 'cleanup namespace') };
  }
  if (value.kind === 'oauth_token') {
    exactKeys(value, ['kind', 'tokenRef'], 'OAuth cleanup target');
    return { kind: 'oauth_token', tokenRef: uuid(value.tokenRef, 'OAuth token reference') };
  }
  if (value.kind === 'legacy_markdown') {
    exactKeys(value, ['kind', 'path'], 'markdown cleanup target');
    return { kind: 'legacy_markdown', path: relativeMarkdownPath(value.path) };
  }
  return fail('cleanup target kind');
}

function targetKey(target: PrivacyCleanupTarget): string {
  switch (target.kind) {
    case 'namespace': return `n:${target.namespace}`;
    case 'oauth_token': return `o:${target.tokenRef}`;
    case 'legacy_markdown': return `m:${target.path}`;
  }
}

function parseStep(input: unknown): PrivacyCleanupStep {
  const value = record(input, 'cleanup step');
  exactKeys(value, ['target', 'status', 'completedAt', 'errorCode'], 'cleanup step');
  const target = parseTarget(value.target);
  if (value.status !== 'pending' && value.status !== 'complete' && value.status !== 'failed') return fail('cleanup step status');
  const step: PrivacyCleanupStep = { target, status: value.status };
  if (value.status === 'complete') {
    if (value.errorCode !== undefined) return fail('completed step error');
    step.completedAt = canonicalDate(value.completedAt, 'cleanup completion timestamp');
  } else if (value.completedAt !== undefined) {
    return fail('unfinished step timestamp');
  }
  if (value.status === 'failed') {
    if (typeof value.errorCode !== 'string' || !CLEANUP_ERRORS.has(value.errorCode as PrivacyCleanupErrorCode)) return fail('cleanup error code');
    step.errorCode = value.errorCode as PrivacyCleanupErrorCode;
  } else if (value.errorCode !== undefined) {
    return fail('cleanup error code');
  }
  return step;
}

function parseCleanup(input: unknown, epoch: string): PrivacyCleanupJournal {
  const value = record(input, 'cleanup journal');
  exactKeys(value, ['id', 'epoch', 'startedAt', 'status', 'steps', 'coverage', 'completedAt', 'completedCounts'], 'cleanup journal');
  const cleanupEpoch = uuid(value.epoch, 'cleanup epoch');
  if (cleanupEpoch !== epoch) return fail('cleanup epoch');
  if (value.status !== 'erasing' && value.status !== 'paused' && value.status !== 'complete') return fail('cleanup status');
  if (value.coverage !== 'tracked_with_legacy_limits') return fail('cleanup coverage');
  if (!Array.isArray(value.steps) || value.steps.length > PRIVACY_CONTROL_LIMITS.cleanupTargets) return fail('cleanup steps');
  const steps = value.steps.map(parseStep);
  unique(steps.map((step) => targetKey(step.target)), 'duplicate cleanup targets');
  if (value.status !== 'complete') {
    const namespaceSteps = steps.filter((step) => step.target.kind === 'namespace');
    if (namespaceSteps.length !== PRIVACY_NAMESPACES.length ||
        new Set(namespaceSteps.map((step) => step.target.kind === 'namespace' ? step.target.namespace : '')).size !== PRIVACY_NAMESPACES.length ||
        PRIVACY_NAMESPACES.some((item) => !namespaceSteps.some((step) => step.target.kind === 'namespace' && step.target.namespace === item))) {
      return fail('fixed cleanup namespaces');
    }
  }
  if (value.status === 'complete' && steps.length !== 0) return fail('completed cleanup steps');
  if (value.status === 'erasing' && steps.some((step) => step.status === 'failed')) return fail('erasing cleanup failure');
  if (value.status === 'paused' && !steps.some((step) => step.status === 'failed')) return fail('paused cleanup state');
  const cleanup: PrivacyCleanupJournal = {
    id: uuid(value.id, 'cleanup id'),
    epoch: cleanupEpoch,
    startedAt: canonicalDate(value.startedAt, 'cleanup timestamp'),
    status: value.status,
    steps,
    coverage: 'tracked_with_legacy_limits',
  };
  if (value.status === 'complete') cleanup.completedAt = canonicalDate(value.completedAt, 'cleanup completion timestamp');
  else if (value.completedAt !== undefined) return fail('unfinished cleanup timestamp');
  if (value.completedCounts !== undefined) {
    const counts = record(value.completedCounts, 'cleanup counts');
    exactKeys(counts, ['namespaces', 'oauthTokens', 'legacyMarkdown'], 'cleanup counts');
    const parsed: NonNullable<PrivacyCleanupJournal['completedCounts']> = {
      namespaces: boundedCount(counts.namespaces, PRIVACY_CONTROL_LIMITS.namespaces, 'namespace count'),
      oauthTokens: boundedCount(counts.oauthTokens, PRIVACY_CONTROL_LIMITS.oauthTokenRefs, 'OAuth count'),
      legacyMarkdown: boundedCount(counts.legacyMarkdown, PRIVACY_CONTROL_LIMITS.legacyMarkdownPaths, 'markdown count'),
    };
    cleanup.completedCounts = parsed;
  }
  if (value.status === 'complete' && !cleanup.completedCounts) return fail('completed cleanup counts');
  if (value.status !== 'complete' && cleanup.completedCounts !== undefined) return fail('unfinished cleanup counts');
  if (value.status === 'complete' && cleanup.completedCounts?.namespaces !== PRIVACY_NAMESPACES.length) {
    return fail('completed fixed namespaces');
  }
  return cleanup;
}

function boundedCount(value: unknown, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) return fail(label);
  return value as number;
}

export function validatePrivacyControlState(input: unknown): PrivacyControlState {
  const value = record(input, 'root');
  exactKeys(value, ['schemaVersion', 'epoch', 'revision', 'ownedNamespaces', 'oauthTokenRefs', 'legacyMarkdownPaths', 'writerLeases', 'cleanup'], 'root');
  if (value.schemaVersion !== 1) return fail('schema version');
  if (!Array.isArray(value.ownedNamespaces) || value.ownedNamespaces.length > PRIVACY_CONTROL_LIMITS.namespaces) return fail('namespace manifest');
  const ownedNamespaces = unique(value.ownedNamespaces.map((entry) => namespace(entry, 'namespace manifest entry')), 'namespace manifest duplicates');
  if (!Array.isArray(value.oauthTokenRefs) || value.oauthTokenRefs.length > PRIVACY_CONTROL_LIMITS.oauthTokenRefs) return fail('OAuth manifest');
  const oauthTokenRefs = unique(value.oauthTokenRefs.map((entry) => uuid(entry, 'OAuth manifest entry')), 'OAuth manifest duplicates');
  if (!Array.isArray(value.legacyMarkdownPaths) || value.legacyMarkdownPaths.length > PRIVACY_CONTROL_LIMITS.legacyMarkdownPaths) return fail('markdown manifest');
  const legacyMarkdownPaths = unique(value.legacyMarkdownPaths.map(relativeMarkdownPath), 'markdown manifest duplicates');
  if (!Array.isArray(value.writerLeases) || value.writerLeases.length > PRIVACY_CONTROL_LIMITS.writerLeases) return fail('writer leases');
  const writerLeases = value.writerLeases.map(parseLease);
  unique(writerLeases.map((lease) => lease.id), 'writer lease duplicates');
  const epoch = uuid(value.epoch, 'epoch');
  const state: PrivacyControlState = {
    schemaVersion: 1,
    epoch,
    revision: uuid(value.revision, 'revision'),
    ownedNamespaces,
    oauthTokenRefs,
    legacyMarkdownPaths,
    writerLeases,
  };
  if (value.cleanup !== undefined) state.cleanup = parseCleanup(value.cleanup, epoch);
  if (state.cleanup && state.cleanup.status !== 'complete') {
    if (state.writerLeases.length !== 0) return fail('writer leases during cleanup');
    const pendingTargets = new Set(state.cleanup.steps
      .filter((step) => step.status !== 'complete')
      .map((step) => targetKey(step.target)));
    const manifestTargets = new Set([
      ...state.ownedNamespaces.map((item): PrivacyCleanupTarget => ({ kind: 'namespace', namespace: item })),
      ...state.oauthTokenRefs.map((item): PrivacyCleanupTarget => ({ kind: 'oauth_token', tokenRef: item })),
      ...state.legacyMarkdownPaths.map((item): PrivacyCleanupTarget => ({ kind: 'legacy_markdown', path: item })),
    ].map(targetKey));
    if (pendingTargets.size !== manifestTargets.size || [...pendingTargets].some((key) => !manifestTargets.has(key))) {
      return fail('cleanup manifest binding');
    }
  }
  return state;
}

export function createEmptyPrivacyControlState(epoch = createUuid()): PrivacyControlState {
  return {
    schemaVersion: 1,
    epoch: uuid(epoch, 'initial epoch'),
    revision: createUuid(),
    ownedNamespaces: [],
    oauthTokenRefs: [],
    legacyMarkdownPaths: [],
    writerLeases: [],
  };
}

function createUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
