import type { AppController, ImportedKnowledgeActivationPreview } from '../core';
import type { ImportedKnowledgeSelection } from './knowledgeDisplayTypes';

export type ImportedKnowledgeActivationPort = Pick<AppController, 'prepareImportedKnowledgeActivation' | 'activateImportedKnowledgeEntity' | 'cancelImportedKnowledgeActivation'>;
export type ImportedKnowledgeActivationOwner = {
  readonly generation: number;
  readonly selection: ImportedKnowledgeSelection;
  readonly controller: ImportedKnowledgeActivationPort;
  sessionId?: string;
  planHash?: string;
  preview?: ImportedKnowledgeActivationPreview;
  operation?: Readonly<{ kind: 'prepare' | 'activate'; token: object }>;
};
export type ImportedKnowledgeOperationClaim = Readonly<{ owner: ImportedKnowledgeActivationOwner; token: object; kind: 'prepare' | 'activate' }>;
export type ImportedKnowledgeRuntimeFence = Readonly<{ controller: ImportedKnowledgeActivationPort; blocked: boolean }>;

export function importedKnowledgeSelectionMatches(left: ImportedKnowledgeSelection | null | undefined, right: ImportedKnowledgeSelection | null | undefined): boolean {
  return Boolean(left && right && left.archiveId === right.archiveId && left.cohortId === right.cohortId && left.kind === right.kind && left.entityId === right.entityId);
}

export function importedKnowledgeOwnerMatchesRuntime(ownership: ImportedKnowledgeActivationOwnership, owner: ImportedKnowledgeActivationOwner, selection: ImportedKnowledgeSelection, runtime: ImportedKnowledgeRuntimeFence): boolean {
  return !runtime.blocked && runtime.controller === owner.controller && ownership.isCurrent(owner, selection, runtime.controller);
}

/** Attach only after an awaited prepare still belongs to the current controller, view, and exact selection. */
export function attachImportedKnowledgePreviewForRuntime(ownership: ImportedKnowledgeActivationOwnership, owner: ImportedKnowledgeActivationOwner, selection: ImportedKnowledgeSelection, preview: ImportedKnowledgeActivationPreview, runtime: ImportedKnowledgeRuntimeFence, currentSelection: ImportedKnowledgeSelection | null | undefined): boolean {
  if (!ownership.attachPrepared(owner, preview)) return false;
  if (!importedKnowledgeOwnerMatchesRuntime(ownership, owner, selection, runtime) || !importedKnowledgeSelectionMatches(currentSelection, selection)) {
    ownership.invalidate(owner);
    return false;
  }
  return true;
}

/** Owns private activation plans in the native parent, fencing selection and runtime changes. */
export class ImportedKnowledgeActivationOwnership {
  private generation = 0;
  private owner?: ImportedKnowledgeActivationOwner;

  current(): ImportedKnowledgeActivationOwner | undefined { return this.owner; }

  claimPrepare(selection: ImportedKnowledgeSelection, controller: ImportedKnowledgeActivationPort): ImportedKnowledgeOperationClaim | undefined {
    if (this.owner?.operation) return undefined;
    this.invalidate();
    const owner: ImportedKnowledgeActivationOwner = { generation: ++this.generation, selection, controller };
    this.owner = owner;
    const token = {};
    owner.operation = { kind: 'prepare', token };
    return { owner, token, kind: 'prepare' };
  }

  isCurrent(owner: ImportedKnowledgeActivationOwner, selection: ImportedKnowledgeSelection, controller?: ImportedKnowledgeActivationPort): boolean {
    return this.owner === owner && importedKnowledgeSelectionMatches(owner.selection, selection) && (!controller || owner.controller === controller);
  }

  activationCredentials(owner: ImportedKnowledgeActivationOwner, selection: ImportedKnowledgeSelection, controller: ImportedKnowledgeActivationPort): Readonly<{ sessionId: string; planHash: string }> | undefined {
    if (!this.isCurrent(owner, selection, controller) || !owner.sessionId || !owner.planHash || !owner.preview || owner.preview.alreadyActivated ||
        owner.preview.archiveId !== selection.archiveId || owner.preview.cohortId !== selection.cohortId || owner.preview.kind !== selection.kind || owner.preview.sourceEntityId !== selection.entityId) return undefined;
    return { sessionId: owner.sessionId, planHash: owner.planHash };
  }

  claimActivation(selection: ImportedKnowledgeSelection, controller: ImportedKnowledgeActivationPort): (ImportedKnowledgeOperationClaim & Readonly<{ credentials: Readonly<{ sessionId: string; planHash: string }> }>) | undefined {
    const owner = this.owner;
    if (!owner || owner.operation) return undefined;
    const credentials = this.activationCredentials(owner, selection, controller);
    if (!credentials) return undefined;
    const token = {};
    owner.operation = { kind: 'activate', token };
    return { owner, token, kind: 'activate', credentials };
  }

  release(claim: ImportedKnowledgeOperationClaim): boolean {
    const { owner, token, kind } = claim;
    if (this.owner !== owner || owner.operation?.token !== token || owner.operation.kind !== kind) return false;
    owner.operation = undefined;
    return true;
  }

  attachPrepared(owner: ImportedKnowledgeActivationOwner, preview: ImportedKnowledgeActivationPreview): boolean {
    if (this.owner !== owner || preview.archiveId !== owner.selection.archiveId || preview.cohortId !== owner.selection.cohortId ||
        preview.kind !== owner.selection.kind || preview.sourceEntityId !== owner.selection.entityId) {
      void owner.controller.cancelImportedKnowledgeActivation(preview.sessionId).catch(() => undefined);
      return false;
    }
    owner.sessionId = preview.sessionId;
    owner.planHash = preview.planHash;
    owner.preview = preview;
    return true;
  }

  invalidate(owner?: ImportedKnowledgeActivationOwner): boolean {
    if (owner && this.owner !== owner) return false;
    const current = this.owner;
    this.owner = undefined;
    this.generation += 1;
    if (current?.sessionId) void current.controller.cancelImportedKnowledgeActivation(current.sessionId).catch(() => undefined);
    return Boolean(current);
  }
}
