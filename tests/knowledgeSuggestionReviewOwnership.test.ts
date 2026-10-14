import { describe, expect, it } from 'vitest';
import type { KnowledgeSuggestionReview } from '../src/knowledge/types';
import { KnowledgeSuggestionReviewOwnership, prepareKnowledgeSuggestionReviewWithPrivacy } from '../src/ui/knowledgeSuggestionReviewOwnership';

const result = (id: string, revision: number, overrides: Partial<KnowledgeSuggestionReview> = {}): KnowledgeSuggestionReview => ({
  suggestion: {
    id, revision, change: { type: 'add_fact', entityKind: 'person', entityId: 'person-1', statement: 'Fact' }, targetRevision: 1,
    evidence: [], status: 'pending', createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z',
  },
  canEdit: true, canAccept: true, ...overrides,
});

describe('Knowledge review ownership used by the sheet', () => {
  it('does not publish suggestion A when the selected suggestion changes to B during preflight', async () => {
    const ownership = new KnowledgeSuggestionReviewOwnership();
    const ownerA = ownership.publish('suggestion-a', 1)!;
    let resolveA!: (value: KnowledgeSuggestionReview) => void;
    const aPreflight = new Promise<KnowledgeSuggestionReview>((resolve) => { resolveA = resolve; });
    const pendingA = ownership.prepare({ owner: ownerA, prepare: () => aPreflight });
    const ownerB = ownership.publish('suggestion-b', 4)!;
    await expect(ownership.prepare({ owner: ownerB, prepare: async () => result('suggestion-b', 4) }))
      .resolves.toMatchObject({ kind: 'prepared', review: { suggestion: { id: 'suggestion-b', revision: 4 } } });
    resolveA(result('suggestion-a', 1));
    await expect(pendingA).resolves.toEqual({ kind: 'stale' });
    expect(ownership.current(ownerB)?.suggestion.id).toBe('suggestion-b');
  });

  it('rejects a late preflight after close and reopen of the same ID at the same revision', async () => {
    const ownership = new KnowledgeSuggestionReviewOwnership();
    const first = ownership.publish('suggestion-a', 7)!;
    let resolveFirst!: (value: KnowledgeSuggestionReview) => void;
    const firstResult = new Promise<KnowledgeSuggestionReview>((resolve) => { resolveFirst = resolve; });
    const pendingFirst = ownership.prepare({ owner: first, prepare: () => firstResult });
    ownership.publish();
    const reopened = ownership.publish('suggestion-a', 7)!;
    const prepared = await ownership.prepare({ owner: reopened, prepare: async () => result('suggestion-a', 7, { canEdit: false, canAccept: false }) });
    resolveFirst(result('suggestion-a', 7));
    await expect(pendingFirst).resolves.toEqual({ kind: 'stale' });
    expect(prepared).toMatchObject({ kind: 'prepared', review: { canEdit: false, canAccept: false } });
    expect(ownership.current(reopened)?.canAccept).toBe(false);
  });

  it('rejects malformed controller replies that do not match the requested ID and revision', async () => {
    const ownership = new KnowledgeSuggestionReviewOwnership();
    const owner = ownership.publish('suggestion-a', 3)!;
    await expect(ownership.prepare({ owner, prepare: async () => result('suggestion-a', 4) })).resolves.toEqual({ kind: 'stale' });
    expect(ownership.current(owner)).toBeUndefined();
  });

  it('rechecks live workspace hard blocks after the actual preflight await', async () => {
    const ownership = new KnowledgeSuggestionReviewOwnership();
    const owner = ownership.publish('suggestion-a', 1)!;
    let blocked = false;
    let resolve!: (value: KnowledgeSuggestionReview) => void;
    const preflight = new Promise<KnowledgeSuggestionReview>((accept) => { resolve = accept; });
    const pending = ownership.prepare({ owner, isCurrent: () => !blocked, prepare: () => preflight });
    blocked = true;
    resolve(result('suggestion-a', 1));
    await expect(pending).resolves.toEqual({ kind: 'stale' });
    expect(ownership.current(owner)).toBeUndefined();
  });

  it('invalidates workspace privacy before propagating the typed preflight error to the sheet', async () => {
    const error = Object.assign(new Error('Workspace epoch changed.'), { code: 'stale_epoch' });
    const events: string[] = [];
    await expect(prepareKnowledgeSuggestionReviewWithPrivacy({
      prepare: async () => { throw error; },
      isPrivacyError: (value) => Boolean(value && typeof value === 'object' && (value as { code?: unknown }).code === 'stale_epoch'),
      onPrivacyInvalidated: (value) => { expect(value).toBe(error); events.push('invalidate'); },
    })).rejects.toBe(error);
    expect(events).toEqual(['invalidate']);
  });
});
