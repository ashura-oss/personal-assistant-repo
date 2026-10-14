import type { KnowledgeReference } from '../knowledge/types';
import type { KnowledgeReferenceDisplay, KnowledgeSourceChoiceDisplay } from './knowledgeDisplayTypes';

/** Private parent-side source snapshot. `binding` may contain native identities and must never reach the leaf. */
export type KnowledgeReferenceChoiceOption = Readonly<{
  reference: KnowledgeReference;
  label: string;
  binding: string;
}>;

/** Explicit stale choices are rejected; only an omitted choice preserves an existing link. */
export function resolveKnowledgeSourceLinkReference(ownership: KnowledgeReferenceChoiceOwnership, choiceId: string | undefined, current: readonly KnowledgeReferenceChoiceOption[], existingReference?: KnowledgeReference): KnowledgeReference | undefined {
  return choiceId !== undefined ? ownership.resolve(choiceId, current) : existingReference;
}

/** Keeps editable source selections tied to the exact source snapshot that was displayed. */
export class KnowledgeReferenceChoiceOwnership {
  private nextToken = 0;
  private readonly tokenByBinding = new Map<string, string>();
  private readonly bindingByToken = new Map<string, string>();

  project(options: readonly KnowledgeReferenceChoiceOption[], display: (reference: KnowledgeReference) => KnowledgeReferenceDisplay): KnowledgeSourceChoiceDisplay[] {
    const currentBindings = new Set(options.map(({ binding }) => binding));
    for (const [binding, id] of this.tokenByBinding) {
      if (!currentBindings.has(binding)) {
        this.tokenByBinding.delete(binding);
        this.bindingByToken.delete(id);
      }
    }
    return options.map(({ reference, label, binding }) => {
      let id = this.tokenByBinding.get(binding);
      if (!id) {
        id = `source-choice-${++this.nextToken}`;
        this.tokenByBinding.set(binding, id);
        this.bindingByToken.set(id, binding);
      }
      return { id, reference: display(reference), label };
    });
  }

  resolve(id: string | undefined, current: readonly KnowledgeReferenceChoiceOption[]): KnowledgeReference | undefined {
    if (!id) return undefined;
    const binding = this.bindingByToken.get(id);
    if (!binding) return undefined;
    return current.find((option) => option.binding === binding)?.reference;
  }
}
