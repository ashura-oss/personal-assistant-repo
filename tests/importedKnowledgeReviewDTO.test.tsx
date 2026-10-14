/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import type { AppState } from '../src/core';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import type { ImportedArchiveDisplay, ImportedKnowledgePreviewDisplay, KnowledgeDisplay, KnowledgePersonDisplay } from '../src/ui/knowledgeDisplayTypes';
import { ImportedKnowledgeReview } from '../src/ui/ImportedKnowledgeReview';

vi.mock('react-native', async () => {
  const ReactModule = await import('react');
  const element = (tag: string) => ({ children, onPress, accessibilityLabel, accessibilityRole: _role, style: _style, ...props }: Record<string, unknown> & { children?: React.ReactNode; onPress?: () => void }) => ReactModule.createElement(tag, {
    ...props, ...(onPress ? { onClick: onPress } : {}), ...(accessibilityLabel ? { 'aria-label': accessibilityLabel } : {}),
  }, children);
  return { Pressable: element('button'), Text: element('span'), View: element('div') };
});
vi.mock('../src/ui/primitives', async () => {
  const ReactModule = await import('react');
  return { Button: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => ReactModule.createElement('button', { type: 'button', disabled, onClick: onPress }, label) };
});
vi.mock('../src/ui/theme', () => ({ C: { text: '#fff', muted: '#aaa', border: '#333' }, s: new Proxy({}, { get: () => ({}) }) }));

const workspaceId = '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8';
const personId = '11111111-1111-4111-8111-111111111111';
const cohortId = '22222222-2222-4222-8222-222222222222';
const archiveId = '33333333-3333-4333-8333-333333333333';
const stamp = '2026-10-14T08:00:00.000Z';

function archivesFromWorkspaceDTO(): readonly ImportedArchiveDisplay[] {
  const state = createInitialWorkspaceState(() => '44444444-4444-4444-8444-444444444444');
  const person: AppState['knowledge']['people'][number] = {
    id: personId, revision: 3, name: 'Archived Maya', aliases: ['Maya'], narrativePath: 'people/archived-maya.md', createdAt: stamp, updatedAt: stamp,
    facts: [{ id: 'fact-a', statement: 'Coordinates the field study.', provenance: 'user_authored', createdAt: stamp, evidence: [{ sourceId: 'historical:imported:v1:note', sourceVersion: 'v1', revision: 2, quote: 'Maya coordinates the field study.' }] }],
    contacts: [{ id: 'contact-a', address: 'maya@example.test', label: 'Work', provenance: 'user_authored', createdAt: stamp }], sourceLinks: [],
  };
  state.importedBackups.push({
    id: archiveId, contentHash: 'a'.repeat(64), fileHash: 'b'.repeat(64), sourceFormat: 'still-backup-v4', exportedAt: stamp, importedAt: stamp,
    noteLinks: [], taskLinks: [], documents: [], history: [], archivedKnowledge: [{ id: cohortId, sourceId: 'source-cohort', knowledge: { state: { schemaVersion: 1, people: [person], projects: [], suggestions: [] }, narratives: [{ entityKind: 'person', entityId: personId, content: 'Preserved narrative text.', revision: 2, updatedAt: stamp }] }, activationLinks: [] }],
  });
  const dto = createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 1, revision: 8 });
  const archive = dto.state.importedBackups[0]!;
  const sourceCohort = archive.archivedKnowledge![0]!;
  const sourceKnowledge = sourceCohort.knowledge.state;
  const displayPerson: KnowledgePersonDisplay = { ...sourceKnowledge.people[0]!, sourceLinks: [] };
  const knowledge: KnowledgeDisplay = { people: [displayPerson], projects: [], suggestions: [] };
  return [{ id: archive.id, sourceFormat: archive.sourceFormat,
    importedAt: archive.importedAt, noteLinks: archive.noteLinks, taskLinks: archive.taskLinks, documents: archive.documents,
    archivedKnowledge: [{ id: sourceCohort.id, sourceId: sourceCohort.sourceId, knowledge: { state: knowledge, narratives: sourceCohort.knowledge.narratives }, activatedEntities: [] }] }];
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('ImportedKnowledgeReview DTO display and commands', () => {
  it('renders archived DTO claims and narrative while sending only typed selection and confirmation', () => {
    const archives = archivesFromWorkspaceDTO();
    const cohort = archives[0]!.archivedKnowledge![0]!;
    const sourceEntity = cohort.knowledge.state.people[0]!;
    expect(cohort).not.toHaveProperty('activationLinks');
    expect(sourceEntity).not.toHaveProperty('audioUri');
    const preview: ImportedKnowledgePreviewDisplay = {
      archiveId, cohortId, kind: 'person', sourceEntityId: personId, sourceName: sourceEntity.name,
      sourceEntity, alreadyActivated: false, narrativeContent: 'Preserved narrative text.', factCount: 1, contactCount: 1,
      sourceLinkCount: 0, memberCount: 0, unavailableProviderReferenceCount: 0, unresolvedMemberCount: 0,
    };
    const onSelectionChange = vi.fn();
    const onPrepare = vi.fn();
    const onActivate = vi.fn();
    const onCancel = vi.fn();
    const props = { archives, busy: false, blocked: false, preparing: false, applying: false, canActivate: true, preview, message: '',
      onSelectionChange, onPrepare, onActivate, onCancel };
    act(() => root.render(<ImportedKnowledgeReview {...props} />));
    expect(host.textContent).toContain('1 people · 0 projects · imported, not active');
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Choose')!.click());
    expect(host.textContent).toContain('Archived Maya');

    const reviewButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Review separate copy')!;
    act(() => reviewButton.click());
    const selection = { archiveId, cohortId, kind: 'person' as const, entityId: personId };
    expect(onSelectionChange).toHaveBeenCalledWith(selection);
    expect(onPrepare).toHaveBeenCalledWith(selection);
    expect(host.textContent).toContain('Preserved narrative text.');
    expect(host.textContent).toContain('Coordinates the field study.');
    expect(host.textContent).toContain('Contact addresses are imported claims and are not verified identities.');
    expect(preview).not.toHaveProperty('sessionId');
    expect(preview).not.toHaveProperty('planHash');
    expect(preview).not.toHaveProperty('targetId');

    const activate = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Activate separate person')!;
    act(() => activate.click());
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(selection, true);
  });
});
