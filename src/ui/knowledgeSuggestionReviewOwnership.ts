export async function prepareKnowledgeSuggestionReviewWithPrivacy<T>(input: {
  prepare: () => Promise<T>;
  isPrivacyError: (error: unknown) => boolean;
  onPrivacyInvalidated: (error: unknown) => void;
}): Promise<T> {
  try {
    return await input.prepare();
  } catch (error) {
    if (input.isPrivacyError(error)) input.onPrivacyInvalidated(error);
    throw error;
  }
}

export type KnowledgeSuggestionReviewOwner = Readonly<{ suggestionId: string; revision: number; generation: number }>;

/** Synchronous owner and result fence for local Knowledge review preflights. */
export class KnowledgeSuggestionReviewOwnership<T extends { readonly suggestion: { readonly id: string; readonly revision: number } }> {
  private generation = 0;
  private owner: KnowledgeSuggestionReviewOwner | undefined;
  private review: T | undefined;

  publish(suggestionId?: string, revision?: number): KnowledgeSuggestionReviewOwner | undefined {
    this.generation += 1;
    this.review = undefined;
    this.owner = suggestionId && revision !== undefined
      ? Object.freeze({ suggestionId, revision, generation: this.generation })
      : undefined;
    return this.owner;
  }

  owns(owner: KnowledgeSuggestionReviewOwner): boolean {
    return this.owner?.suggestionId === owner.suggestionId && this.owner.revision === owner.revision &&
      this.owner.generation === owner.generation;
  }

  async prepare(input: {
    owner: KnowledgeSuggestionReviewOwner;
    isCurrent?: () => boolean;
    prepare: () => Promise<T>;
  }): Promise<{ kind: 'stale' } | { kind: 'prepared'; review: T }> {
    if (!this.owns(input.owner) || input.isCurrent?.() === false) return { kind: 'stale' };
    const review = await input.prepare();
    if (!this.owns(input.owner) || input.isCurrent?.() === false ||
      review.suggestion.id !== input.owner.suggestionId || review.suggestion.revision !== input.owner.revision) {
      return { kind: 'stale' };
    }
    this.review = review;
    return { kind: 'prepared', review };
  }

  current(owner: KnowledgeSuggestionReviewOwner): T | undefined {
    return this.owns(owner) && this.review?.suggestion.id === owner.suggestionId &&
      this.review.suggestion.revision === owner.revision ? this.review : undefined;
  }
}
