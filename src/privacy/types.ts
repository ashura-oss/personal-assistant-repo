export const PRIVACY_NAMESPACES = [
  'state_database',
  'browser_audio',
  'native_recordings',
  'recovery_audio',
  'speech_staging',
  'picker_cache',
  'markdown_mirrors',
  'internal_export',
  'provider_credentials',
  'notifications',
] as const;

export type PrivacyNamespace = (typeof PRIVACY_NAMESPACES)[number];
export type PrivacyPlatform = 'ios' | 'web' | 'unsupported';
export type PrivacyWriterKind =
  | 'app_state'
  | 'audio_capture'
  | 'recording_recovery'
  | 'speech_upload'
  | 'picker_cache'
  | 'markdown_mirror'
  | 'internal_export'
  | 'provider_credential'
  | 'notification';

export interface PrivacyOwner {
  platform: PrivacyPlatform;
  runtimeId: string;
  processLaunchId?: string;
  bundleIdentifier?: 'com.still.voiceassistant';
}

export interface PrivacyWriterDescriptor {
  kind: PrivacyWriterKind;
  namespace?: PrivacyNamespace;
  /** Exact credential reference to register before a credential write. Never a credential value. */
  oauthTokenRef?: string;
  /** Exact canonical mirror path to register before a mirror write. */
  legacyMarkdownPath?: string;
}

export interface PrivacyWriterLease {
  id: string;
  epoch: string;
  owner: PrivacyOwner;
  kind: PrivacyWriterKind;
  namespace?: PrivacyNamespace;
  createdAt: string;
}

declare const privacyWriterScopeBrand: unique symbol;
/** Opaque process-local capability issued only during an active writer callback. */
export interface PrivacyWriterScope {
  readonly [privacyWriterScopeBrand]: true;
}

export type PrivacyCleanupTarget =
  | { kind: 'namespace'; namespace: PrivacyNamespace }
  | { kind: 'oauth_token'; tokenRef: string }
  | { kind: 'legacy_markdown'; path: string };

export type PrivacyCleanupErrorCode =
  | 'erase_failed'
  | 'verification_failed'
  | 'unsupported_target'
  | 'target_unavailable';

export interface PrivacyCleanupStep {
  target: PrivacyCleanupTarget;
  status: 'pending' | 'complete' | 'failed';
  completedAt?: string;
  errorCode?: PrivacyCleanupErrorCode;
}

export interface PrivacyCleanupJournal {
  id: string;
  epoch: string;
  startedAt: string;
  status: 'erasing' | 'paused' | 'complete';
  steps: PrivacyCleanupStep[];
  coverage: 'tracked_with_legacy_limits';
  completedAt?: string;
  completedCounts?: {
    namespaces: number;
    oauthTokens: number;
    legacyMarkdown: number;
  };
}

export interface PrivacyControlState {
  schemaVersion: 1;
  epoch: string;
  revision: string;
  ownedNamespaces: PrivacyNamespace[];
  oauthTokenRefs: string[];
  legacyMarkdownPaths: string[];
  writerLeases: PrivacyWriterLease[];
  cleanup?: PrivacyCleanupJournal;
}

export interface PrivacyControlStore {
  /** Atomically initializes an absent record, validates persisted state, and rejects corruption. */
  read(): Promise<PrivacyControlState>;
  /** Atomically validates and replaces the record iff its current revision matches. */
  compareAndSwap(expectedRevision: string, next: PrivacyControlState): Promise<void>;
}

export interface PrivacyWriterArbitration {
  withWriterLock<T>(work: () => Promise<T>): Promise<T>;
  withCleanupLock<T>(work: () => Promise<T>): Promise<T>;
  getRuntimeOwner(): Promise<PrivacyOwner>;
}

export interface PrivacyEraseAdapter {
  erase(target: PrivacyCleanupTarget, cleanupEpoch: string): Promise<void>;
  verifyGone(target: PrivacyCleanupTarget, cleanupEpoch: string): Promise<boolean>;
}

export interface PrivacyEngineDependencies {
  controlStore: PrivacyControlStore;
  arbitration: PrivacyWriterArbitration;
  adapter: PrivacyEraseAdapter;
  now?: () => Date;
  uuid?: () => string;
}

export interface PrivacyErasePlan {
  operation: 'erase_local_data';
  sessionId: string;
  planHash: string;
  expiresAt: string;
  targetCount: number;
  coverage: 'tracked_with_legacy_limits';
}

export interface PrivacyCleanupPassResult {
  phase: 'idle' | 'erasing' | 'paused' | 'complete' | 'blocked';
  attempted: number;
  completed: number;
  remaining: number;
}

export interface PrivacyPublicStatus {
  phase: 'ready' | 'writer_active' | 'erasing' | 'paused' | 'complete' | 'blocked';
  epoch: string;
  activeWriterCount: number;
  pendingCleanupCount: number;
  failedCleanupCount: number;
  limits: {
    namespaces: number;
    oauthTokenRefs: number;
    legacyMarkdownPaths: number;
    writerLeases: number;
    cleanupTargets: number;
    cleanupBatch: number;
  };
  coverage: 'tracked_with_legacy_limits';
  categoryStates?: Record<PrivacyCleanupCategory, 'pending' | 'verified' | 'paused'>;
  completedAt?: string;
}

export type PrivacyCleanupCategory =
  | 'notes_context'
  | 'action_history_recovery'
  | 'recordings_caches'
  | 'credentials'
  | 'notifications';
