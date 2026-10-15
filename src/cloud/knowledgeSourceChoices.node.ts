import { createHash } from 'node:crypto';
import type { AppState } from '../core';
import { buildKnowledgeReferenceOptions, type KnowledgeReferenceChoiceOption } from '../knowledge/sourceChoices';
import { validateCanonicalKnowledgeReference } from '../knowledge';

export function knowledgeSourceChoiceId(workspaceId: string, privacyEpoch: number, binding: string): string {
  const canonical = JSON.stringify({ workspaceId, privacyEpoch, binding });
  return `knowledge-choice-${createHash('sha256').update(canonical).digest('hex')}`;
}

/** Cloud selectors must also satisfy the persisted source-reference schema. */
export function buildCloudKnowledgeSourceChoiceOptions(state: AppState): KnowledgeReferenceChoiceOption[] {
  return buildKnowledgeReferenceOptions(state).filter(({ reference }) => {
    try { validateCanonicalKnowledgeReference(reference); return true; }
    catch { return false; }
  });
}

export function resolveKnowledgeSourceChoice(state: AppState, workspaceId: string, privacyEpoch: number, choiceId: string): KnowledgeReferenceChoiceOption | undefined {
  if (!/^knowledge-choice-[a-f0-9]{64}$/.test(choiceId)) return undefined;
  return buildCloudKnowledgeSourceChoiceOptions(state).find((option) => knowledgeSourceChoiceId(workspaceId, privacyEpoch, option.binding) === choiceId);
}
