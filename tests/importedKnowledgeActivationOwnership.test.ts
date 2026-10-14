import { describe, expect, it, vi } from 'vitest';
import type { AppController, ImportedKnowledgeActivationPreview } from '../src/core';
import type { ImportedKnowledgeSelection } from '../src/ui/knowledgeDisplayTypes';
import { attachImportedKnowledgePreviewForRuntime, ImportedKnowledgeActivationOwnership, importedKnowledgeOwnerMatchesRuntime } from '../src/ui/importedKnowledgeActivationOwnership';
import { runWithBusyLock } from '../src/ui/busyActionRunner';

const selection = (entityId = 'archived-person'): ImportedKnowledgeSelection => ({ archiveId: 'archive-a', cohortId: 'cohort-a', kind: 'person', entityId });
const preview = (sessionId: string, selected = selection()): ImportedKnowledgeActivationPreview => ({
  sessionId, planHash: `hash-${sessionId}`, expiresAt: '2026-10-15T00:00:00.000Z', archiveId: selected.archiveId, cohortId: selected.cohortId,
  kind: selected.kind, sourceEntityId: selected.entityId, sourceName: 'Archived person',
  sourceEntity: { id: selected.entityId, revision: 1, name: 'Archived person', aliases: [], narrativePath: 'people/archived.md', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', facts: [], contacts: [], sourceLinks: [] },
  alreadyActivated: false, targetId: 'private-target', narrativePath: 'people/private-target.md', narrativeContent: 'Archived narrative', factCount: 0, contactCount: 0,
  sourceLinkCount: 0, memberCount: 0, unavailableProviderReferenceCount: 0, unresolvedMemberCount: 0,
});
const port = () => ({
  prepareImportedKnowledgeActivation: vi.fn(), activateImportedKnowledgeEntity: vi.fn(), cancelImportedKnowledgeActivation: vi.fn(async () => undefined),
}) as unknown as Pick<AppController, 'prepareImportedKnowledgeActivation' | 'activateImportedKnowledgeEntity' | 'cancelImportedKnowledgeActivation'>;

describe('imported knowledge activation ownership', () => {
  it('cancels a late prepared plan through its originating controller after selection and controller switch', () => {
    const ownership = new ImportedKnowledgeActivationOwnership();
    const originalController = port();
    const replacementController = port();
    const firstClaim = ownership.claimPrepare(selection(), originalController)!;
    const first = firstClaim.owner;
    const nextSelection = selection('other-entity');
    const duplicate = ownership.claimPrepare(selection(), originalController);
    expect(duplicate).toBeUndefined();
    ownership.release(firstClaim);
    const replacementClaim = ownership.claimPrepare(nextSelection, replacementController)!;
    const replacement = replacementClaim.owner;

    expect(ownership.attachPrepared(first, preview('late-session'))).toBe(false);
    expect(originalController.cancelImportedKnowledgeActivation).toHaveBeenCalledExactlyOnceWith('late-session');
    expect(replacementController.cancelImportedKnowledgeActivation).not.toHaveBeenCalled();
    expect(ownership.attachPrepared(replacement, preview('replacement-session', nextSelection))).toBe(true);
    expect(ownership.isCurrent(replacement, nextSelection, replacementController)).toBe(true);
    expect(ownership.isCurrent(replacement, selection(), replacementController)).toBe(false);
    expect(ownership.activationCredentials(replacement, selection(), replacementController)).toBeUndefined();
    expect(replacementController.activateImportedKnowledgeEntity).not.toHaveBeenCalled();
    ownership.release(replacementClaim);
  });

  it('cancels only the active exact plan when the review closes', () => {
    const ownership = new ImportedKnowledgeActivationOwnership();
    const controller = port();
    const claim = ownership.claimPrepare(selection(), controller)!;
    const owner = claim.owner;
    expect(ownership.attachPrepared(owner, preview('prepared-session'))).toBe(true);
    ownership.release(claim);
    expect(ownership.invalidate(owner)).toBe(true);
    expect(ownership.invalidate(owner)).toBe(false);
    expect(controller.cancelImportedKnowledgeActivation).toHaveBeenCalledExactlyOnceWith('prepared-session');
    expect(ownership.current()).toBeUndefined();
  });

  it('claims before the parent busy runner: a synchronous duplicate cannot replace the first owner or its completed preview', async () => {
    const ownership = new ImportedKnowledgeActivationOwnership();
    const controller = port();
    const selected = selection();
    const selectedRef = { current: selected };
    const busyLock = { current: false };
    const parentRun = <T,>(action: () => Promise<T>) => runWithBusyLock(busyLock, action);
    const prepareAtParentBoundary = async () => {
      const claim = ownership.claimPrepare(selected, controller);
      if (!claim) return;
      try {
        const result = await parentRun(() => controller.prepareImportedKnowledgeActivation({ archiveId: selected.archiveId, cohortId: selected.cohortId, kind: selected.kind, entityId: selected.entityId }));
        if (result) attachImportedKnowledgePreviewForRuntime(ownership, claim.owner, selected, result as ImportedKnowledgeActivationPreview, { controller, blocked: false }, selectedRef.current);
      } finally { ownership.release(claim); }
    };
    const firstPlan = preview('parent-plan');
    vi.mocked(controller.prepareImportedKnowledgeActivation).mockResolvedValueOnce(firstPlan);
    const first = prepareAtParentBoundary();
    const duplicate = prepareAtParentBoundary();
    await Promise.all([first, duplicate]);
    expect(controller.prepareImportedKnowledgeActivation).toHaveBeenCalledTimes(1);
    expect(ownership.current()?.preview).toBe(firstPlan);

    const activation = ownership.claimActivation(selected, controller);
    expect(activation?.credentials).toEqual({ sessionId: 'parent-plan', planHash: 'hash-parent-plan' });
    expect(ownership.claimActivation(selected, controller)).toBeUndefined();
    if (activation) ownership.release(activation);
  });

  it('fences an awaited parent prepare against a controller or blocked-view change and cancels through the origin port', async () => {
    const ownership = new ImportedKnowledgeActivationOwnership();
    const controller = port();
    const replacement = port();
    const selected = selection();
    let currentController = controller;
    let blocked = false;
    const claim = ownership.claimPrepare(selected, controller)!;
    let resolve!: (value: ImportedKnowledgeActivationPreview) => void;
    vi.mocked(controller.prepareImportedKnowledgeActivation).mockImplementationOnce(() => new Promise((accept) => { resolve = accept; }));
    const pending = (async () => {
      try {
        const prepared = await controller.prepareImportedKnowledgeActivation({ archiveId: selected.archiveId, cohortId: selected.cohortId, kind: selected.kind, entityId: selected.entityId });
        attachImportedKnowledgePreviewForRuntime(ownership, claim.owner, selected, prepared, { controller: currentController, blocked }, selected);
      } finally { ownership.release(claim); }
    })();
    currentController = replacement;
    blocked = true;
    resolve(preview('stale-after-render'));
    await pending;
    expect(ownership.current()).toBeUndefined();
    expect(controller.cancelImportedKnowledgeActivation).toHaveBeenCalledWith('stale-after-render');
    expect(replacement.cancelImportedKnowledgeActivation).not.toHaveBeenCalled();
    expect(importedKnowledgeOwnerMatchesRuntime(ownership, claim.owner, selected, { controller: replacement, blocked: false })).toBe(false);
  });
});
