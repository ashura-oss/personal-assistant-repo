import type { DurableKernel } from './kernel.js';
import { assertApplicationOwnership, claimApplicationStartup, transitionApplicationStartup,
  type ApplicationOwnershipHandle, type ApplicationStartupPhase } from './applicationOwnership.js';

interface StartupBinding {
  readonly ownership: ApplicationOwnershipHandle;
  readonly kernel: DurableKernel;
  readonly databasePath: string;
  readonly processInstanceId: string;
  phase: ApplicationStartupPhase;
}

const capabilities = new WeakMap<object, StartupBinding>();
const kernels = new WeakMap<object, StartupBinding>();
const cursors = new WeakMap<object, Readonly<{ capability: object; kind: 'workspace' | 'intent'; workspaceId?: string; afterId: string }>>();

/** Identity-only token. Its authority exists only in this module's WeakMap. */
export type ApplicationStartupCapability = object;
export type ApplicationStartupCursor = object;

/** Private lifecycle carried only by openServerFoundationInternal's private context. */
export interface ApplicationStartup {
  readonly capability: ApplicationStartupCapability;
  readonly processInstanceId: string;
  beginRecovery(): void;
  seal(): void;
  close(): void;
}

export function registerApplicationStartup(kernel: DurableKernel, ownership: ApplicationOwnershipHandle,
  databasePath: string, processInstanceId: string): ApplicationStartup {
  const canonicalPath = assertApplicationOwnership(ownership, databasePath);
  kernel.assertApplicationStartupBinding(ownership, canonicalPath);
  const ownerBinding = claimApplicationStartup(ownership, kernel, canonicalPath, processInstanceId);
  const binding: StartupBinding = { ownership, kernel, databasePath: ownerBinding.databasePath,
    processInstanceId: ownerBinding.processInstanceId, phase: 'initializing' };
  const capability = Object.freeze({});
  capabilities.set(capability, binding);
  kernels.set(kernel, binding);
  const transition = (phase: ApplicationStartupPhase) => {
    transitionApplicationStartup(ownership, kernel, phase);
    binding.phase = phase;
  };
  return Object.freeze({ capability, processInstanceId,
    beginRecovery: () => { if (binding.phase === 'initializing') transition('recovering');
      else if (binding.phase !== 'recovering') throw new Error('application_startup_transition_invalid'); },
    seal: () => { if (binding.phase === 'recovering') transition('sealed');
      else if (binding.phase !== 'sealed' && binding.phase !== 'closed') throw new Error('application_startup_transition_invalid'); },
    close: () => {
      if (binding.phase === 'initializing') transition('recovering');
      if (binding.phase === 'recovering') transition('sealed');
      if (binding.phase === 'sealed') transition('closed');
    },
  });
}

/** Cold recovery must present the exact capability for the exact kernel and live owner. */
export function assertApplicationStartupCapability(capability: ApplicationStartupCapability, kernel: DurableKernel,
  phase: ApplicationStartupPhase = 'recovering', processInstanceId?: string): void {
  if (!capability || typeof capability !== 'object') throw new Error('application_startup_capability_invalid');
  const binding = capabilities.get(capability);
  if (!binding || binding.kernel !== kernel || binding.phase !== phase ||
      (processInstanceId !== undefined && binding.processInstanceId !== processInstanceId)) throw new Error('application_startup_capability_invalid');
  assertApplicationOwnership(binding.ownership, binding.databasePath);
}

export function createApplicationStartupCursor(capability: ApplicationStartupCapability, afterWorkspaceId = ''): ApplicationStartupCursor {
  if (!capabilities.has(capability) || typeof afterWorkspaceId !== 'string') throw new Error('application_startup_cursor_invalid');
  const cursor = Object.freeze({});
  cursors.set(cursor, Object.freeze({ capability, kind: 'workspace', afterId: afterWorkspaceId }));
  return cursor;
}

export function readApplicationStartupCursor(capability: ApplicationStartupCapability, cursor: ApplicationStartupCursor): string {
  const state = cursor && typeof cursor === 'object' ? cursors.get(cursor) : undefined;
  if (!state || state.capability !== capability || state.kind !== 'workspace') throw new Error('application_startup_cursor_invalid');
  return state.afterId;
}

export function createApplicationStartupIntentCursor(capability: ApplicationStartupCapability, workspaceId: string,
  afterIntentId = ''): ApplicationStartupCursor {
  if (!capabilities.has(capability) || typeof workspaceId !== 'string' || typeof afterIntentId !== 'string') throw new Error('application_startup_cursor_invalid');
  const cursor = Object.freeze({});
  cursors.set(cursor, Object.freeze({ capability, kind: 'intent', workspaceId, afterId: afterIntentId }));
  return cursor;
}

export function readApplicationStartupIntentCursor(capability: ApplicationStartupCapability, cursor: ApplicationStartupCursor,
  workspaceId: string): string {
  const state = cursor && typeof cursor === 'object' ? cursors.get(cursor) : undefined;
  if (!state || state.capability !== capability || state.kind !== 'intent' || state.workspaceId !== workspaceId) throw new Error('application_startup_cursor_invalid');
  return state.afterId;
}

/** Managed runtime actors and private services may exist only after cold recovery is sealed. */
export function assertApplicationRuntimeStartupSealed(kernel: DurableKernel): void {
  const binding = kernels.get(kernel);
  if (!binding) { kernel.assertOwnedStartupStateSealed(); return; }
  if (binding.phase !== 'sealed') throw new Error('application_startup_not_sealed');
  assertApplicationOwnership(binding.ownership, binding.databasePath);
  kernel.assertOwnedStartupStateSealed();
}

export function applicationStartupPhaseForTesting(kernel: DurableKernel): ApplicationStartupPhase | 'sealed' {
  return kernels.get(kernel)?.phase ?? 'sealed';
}
