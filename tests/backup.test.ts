import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/core';
import {
  BACKUP_LIMITS, PORTABLE_BACKUP_FORMAT, canonicalPortableContent, createPortableBackup, createPortableKnowledge,
  parsePortableBackup, summarizePortableBackup, validateImportedBackupArchive, legacyCanonicalPortableContentV2,
  validatePortableDocumentPath, type PortableBackupV3,
} from '../src/backup';
import { emptyKnowledgeState } from '../src/knowledge';

const at = '2026-10-12T10:00:00.000Z';

function emptyState(): AppState {
  return {
    notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [],
    settings: {} as AppState['settings'], usage: {} as AppState['usage'], mailbox: [], selectedMailTexts: [], calendarEvents: [],
    syncStates: {}, pendingCredentialCleanup: [], dispatchRecords: [], dispatchRecordQuarantine: [], mailboxSchemaVersion: 2,
    proactive: { schemaVersion: 1, rules: [], candidates: [], dismissals: [], snoozes: [] },
    importedBackups: [],
    knowledge: emptyKnowledgeState(),
  };
}

function sampleBackup(): PortableBackupV3 {
  return {
    format: PORTABLE_BACKUP_FORMAT, schemaVersion: 3, exportId: 'export-1', exportedAt: at, audioIncluded: false,
    notes: [{ sourceId: 'note-1', title: 'Walk', transcript: 'Remember the route', durationSeconds: 8, createdAt: at, audioMissing: true }],
    tasks: [{ sourceId: 'task-1', title: 'Call', body: 'Call the clinic', status: 'open', createdAt: at, sourceNoteId: 'note-1' }],
    documents: [{ path: 'memory/profile.md', content: 'Preference', revision: 2, updatedAt: at }],
    archivedDocuments: [{ sourceId: 'archived-1', path: 'memory/profile.md', content: 'Older preference', revision: 1, updatedAt: at }],
    history: [{ kind: 'dispatch', sourceId: 'dispatch:ref-' + 'x'.repeat(300), title: 'Action — imported history', content: 'Sent a message', status: 'accepted (unverified imported history)', occurredAt: at, provider: 'google', reference: 'provider-id' }],
    knowledge: { state: emptyKnowledgeState(), narratives: [] }, archivedKnowledge: [],
  };
}

const personUuid = '123e4567-e89b-42d3-a456-426614174000';
function knowledgeWithProviderReference() {
  return {
    schemaVersion: 1 as const,
    people: [{ id: personUuid, revision: 1, name: 'Ada', aliases: [], narrativePath: `people/${personUuid}.md`, createdAt: at, updatedAt: at, facts: [
      { id: '123e4567-e89b-42d3-a456-426614174001', provenance: 'accepted_inference' as const, createdAt: at,
        evidence: [{ sourceId: 'mail:private-account-key:private-message-id', sourceVersion: `0:${'c'.repeat(64)}`, revision: 0, quote: 'Exact\nclaim' }], statement: 'Works with Ada' },
    ], contacts: [], sourceLinks: [{ id: '123e4567-e89b-42d3-a456-426614174002', provenance: 'user_authored' as const, createdAt: at,
      reference: { kind: 'mail' as const, id: 'private-message-id', identityKey: 'private-account-key', connectionGeneration: 4 }, label: 'Planning message' }] }],
    projects: [], suggestions: [],
  };
}

describe('portable backup schema', () => {
  it('projects only portable content and strips local audio paths and authority fields', () => {
    const state = emptyState();
    state.notes.push({ id: 'n1', title: 'Note', transcript: 'Useful transcript', audioUri: 'file:///private/device/clip.m4a', durationSeconds: 15,
      createdAt: at, capturedAt: at, captureTimeZone: 'Asia/Singapore', status: 'processed', revision: 4,
      processingFingerprint: 'secret-fingerprint', importOrigin: { kind: 'backup_import', archiveId: 'archive-1', sourceNoteId: 'old-note', audioMissing: true, originalTimeZoneUnknown: true } });
    state.notes[0]!.analysis = { noteId: 'n1', sourceRevision: 4, intent: 'assist', fingerprint: 'analysis-fingerprint', analyzedAt: '', capturedAt: at,
      captureTimeZone: 'UTC', summary: 'Short summary', answer: 'Short answer', decisions: [], citations: [], clarifications: ['Confirm the location'], proposalIds: [],
      source: 'offline_preview', includedSourceIds: [], includedSources: [], omittedSourceIds: [], omittedSourceCount: 0, sourceVersions: {}, knowledgeSelection: [] };
    state.accounts.push({ id: 'a1', provider: 'google', displayName: 'Me', email: 'me@example.com', connected: true, authStatus: 'connected',
      tokenRef: 'opaque-token-ref', identity: { providerNamespace: 'google', clientId: 'private-client', subject: 'private-subject' }, grantedScopes: ['mail.send'] });
    state.proposals.push({ id: 'p1', noteId: 'n1', kind: 'email', title: 'Email', body: 'Draft body', status: 'approved', revision: 2,
      approvedRevision: 2, approvedPayloadDigest: 'private-digest', recipients: ['x@example.com'], evidence: [], email: {
        to: ['x@example.com'], cc: [], bcc: [], subject: 'Hi', text: 'Email text', attachments: [],
      } });
    state.proposals.push({ id: 'p2', kind: 'reminder', title: 'Appointment', body: 'Prepare paperwork', status: 'draft', revision: 1,
      dueAt: at, recipients: [], evidence: [] });
    state.documents.push({ path: 'memory/profile.md', content: 'A preference', revision: 1, updatedAt: at });
    const backup = createPortableBackup(state, { exportId: 'portable-1', exportedAt: at });
    const encoded = JSON.stringify(backup);
    expect(backup.notes[0]).toMatchObject({ sourceId: 'n1', audioMissing: true });
    expect(backup.notes[0]).toMatchObject({ originalTimeZoneUnknown: true });
    expect(backup.notes[0]?.captureTimeZone).toBeUndefined();
    expect(encoded).not.toContain('file:///private');
    expect(encoded).not.toContain('opaque-token-ref');
    expect(encoded).not.toContain('private-client');
    expect(encoded).not.toContain('private-digest');
    expect(backup.history.some((entry) => entry.kind === 'proposal' && entry.content.includes('Email text'))).toBe(true);
    expect(backup.history.some((entry) => entry.kind === 'proposal' && entry.content.includes(`Due: ${at}`))).toBe(true);
    expect(backup.history.some((entry) => entry.kind === 'analysis' && entry.content === 'Confirm the location')).toBe(true);
    expect(backup.history.find((entry) => entry.kind === 'proposal' && entry.sourceId === 'proposal:p2')?.occurredAt).toBeUndefined();
    expect(parsePortableBackup(encoded).backup).toEqual(backup);
    const another = createPortableBackup(state, { exportId: 'portable-2', exportedAt: '2026-10-13T12:00:00.000Z' });
    expect(canonicalPortableContent(backup)).toBe(canonicalPortableContent(another));
  });

  it('adapts the exact v1 marker as content and historical claims only', () => {
    const legacy = {
      format: 'voice-assistant-export-v1', exportedAt: at, tokenRef: 'opaque-secret', executableThing: { token: 'secret' },
      notes: [{ id: 'n1', title: 'Old note', transcript: 'Keep this', durationSeconds: 12, createdAt: at,
        audioUri: 'content://device/clip', analysis: { summary: 'Old summary', clarifications: ['Check the date'] } }],
      tasks: [{ id: 't1', title: 'Task', body: 'Do it', status: 'completed', createdAt: at, sourceNoteId: 'missing-note' }],
      documents: [{ path: 'logs/daily/2026-10-12.md', content: 'Journal', revision: 3, updatedAt: at }],
      proposals: [{ id: 'p1', title: 'Draft', body: 'Never execute', dueAt: at, status: 'approved', approvedPayloadDigest: 'secret-digest', noteId: 'n1' }],
    };
    const parsed = parsePortableBackup(JSON.stringify(legacy));
    expect(parsed.migratedFromV1).toBe(true);
    expect(parsed.ignoredFieldCount).toBe(2);
    expect(parsed.backup.notes[0]?.audioMissing).toBe(true);
    expect(parsed.backup.tasks[0]?.sourceNoteId).toBeUndefined();
    expect(parsed.backup.tasks[0]?.unresolvedSourceNoteId).toBe('missing-note');
    expect(parsed.backup.history.some((entry) => entry.kind === 'proposal' && entry.status.includes('unverified'))).toBe(true);
    const legacyProposal = parsed.backup.history.find((entry) => entry.kind === 'proposal');
    expect(legacyProposal?.occurredAt).toBeUndefined();
    expect(legacyProposal?.content).toContain(`Due: ${at}`);
    expect(parsed.backup.history.some((entry) => entry.kind === 'analysis' && entry.content === 'Check the date' && !entry.occurredAt)).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('opaque-secret');
    expect(JSON.stringify(parsed)).not.toContain('secret-digest');
    expect(parsed.warnings).toContain('Account connections, credentials, and executable approvals are not restored.');
    expect(parsed.sourceFormat).toBe('voice-assistant-export-v1');
    expect(parsed.backup.format).toBe(PORTABLE_BACKUP_FORMAT);
    expect(parsed.backup.knowledge.state).toEqual(emptyKnowledgeState());
  });

  it('adapts strict v2 input to v3 with empty knowledge and records the actual source marker', () => {
    const { knowledge: _knowledge, archivedKnowledge: _archivedKnowledge, format: _format, schemaVersion: _version, ...fields } = sampleBackup();
    const v2 = { ...fields, format: 'still-backup-v2', schemaVersion: 2 };
    const parsed = parsePortableBackup(JSON.stringify(v2));
    expect(parsed.sourceFormat).toBe('still-backup-v2');
    expect(parsed.backup.format).toBe(PORTABLE_BACKUP_FORMAT);
    expect(parsed.backup.schemaVersion).toBe(3);
    expect(parsed.backup.knowledge.state).toEqual(emptyKnowledgeState());
    expect(parsed.backup.archivedKnowledge).toEqual([]);
    expect(legacyCanonicalPortableContentV2(parsed.backup)).toContain('"format":"still-backup-v2","schemaVersion":2');
    expect(legacyCanonicalPortableContentV2({ ...parsed.backup, knowledge: createPortableKnowledge(knowledgeWithProviderReference()) })).toBeUndefined();
    const emptyV2 = parsePortableBackup(JSON.stringify({ format: 'still-backup-v2', schemaVersion: 2, exportId: 'legacy', exportedAt: at, audioIncluded: false,
      notes: [], tasks: [], documents: [], archivedDocuments: [], history: [] })).backup;
    expect(legacyCanonicalPortableContentV2(emptyV2)).toBe(JSON.stringify({ format: 'still-backup-v2', schemaVersion: 2, audioIncluded: false,
      notes: [], tasks: [], documents: [], archivedDocuments: [], history: [] }));
  });

  it('keeps the combined active and archived knowledge cohort count within 50', () => {
    const knowledge = createPortableKnowledge(knowledgeWithProviderReference());
    const backup = { ...sampleBackup(), knowledge, archivedKnowledge: Array.from({ length: 49 }, (_, index) => ({ sourceId: `prior-${index}`, knowledge: { state: emptyKnowledgeState(), narratives: [] } })) };
    expect(parsePortableBackup(JSON.stringify(backup)).backup.archivedKnowledge).toHaveLength(49);
    expect(() => parsePortableBackup(JSON.stringify({ ...backup, archivedKnowledge: [...backup.archivedKnowledge, { sourceId: 'prior-50', knowledge: { state: emptyKnowledgeState(), narratives: [] } }] }))).toThrow(/cohorts/i);
  });

  it('counts knowledge text in the same total restore budget as notes and documents', () => {
    const people = Array.from({ length: 100 }, (_, index) => {
      const id = `123e4567-e89b-42d3-a456-${String(index + 1000).padStart(12, '0')}`;
      return { id, revision: 1, name: `Person ${index}`, aliases: [], narrativePath: `people/${id}.md`, createdAt: at, updatedAt: at, facts: [], contacts: [], sourceLinks: [] };
    });
    const knowledge = { state: { schemaVersion: 1, people, projects: [], suggestions: [] },
      narratives: people.map((person) => ({ entityKind: 'person' as const, entityId: person.id, content: 'x'.repeat(16 * 1024), revision: 1, updatedAt: at })) };
    const documents = Array.from({ length: 90 }, (_, index) => ({ path: `memory/profile-${index}.md`, content: 'x'.repeat(BACKUP_LIMITS.textBytes), revision: 1, updatedAt: at }));
    expect(() => parsePortableBackup(JSON.stringify({ ...sampleBackup(), documents, archivedDocuments: [], knowledge }))).toThrow(/total restore limit/i);
  });

  it('redacts provider identity from active knowledge and retains explicit narrative snapshots', () => {
    const portable = createPortableKnowledge(knowledgeWithProviderReference(), [{ path: `people/${personUuid}.md`, content: 'Canonical narrative', revision: 7, updatedAt: at }]);
    const encoded = JSON.stringify(portable);
    expect(portable.narratives).toEqual([{ entityKind: 'person', entityId: personUuid, content: 'Canonical narrative', revision: 7, updatedAt: at }]);
    expect(encoded).not.toContain('private-account-key');
    expect(encoded).not.toContain('private-message-id');
    expect(encoded).toContain(`historical:mail:0:${'c'.repeat(64)}`);
    expect(portable.state.people[0]?.sourceLinks[0]?.reference).toEqual({ kind: 'historical', label: 'Planning message', originalKind: 'mail' });
    const withRuntimeAuthority = { ...sampleBackup(), knowledge: { ...portable, state: { ...portable.state, people: [{ ...portable.state.people[0], importOrigin: { kind: 'backup_knowledge' } }] } } };
    expect(() => parsePortableBackup(JSON.stringify(withRuntimeAuthority))).toThrow(/runtime import authority/i);
  });

  it('rejects unknown v3 fields and unsupported formats while allowing archived path duplicates', () => {
    const backup = sampleBackup();
    expect(parsePortableBackup(JSON.stringify(backup)).backup.archivedDocuments).toHaveLength(1);
    expect(() => parsePortableBackup(JSON.stringify({ ...backup, runtimeState: {} }))).toThrow(/unsupported field/i);
    expect(() => parsePortableBackup(JSON.stringify({ ...backup, notes: [{ ...backup.notes[0], audioUri: 'file://x' }] }))).toThrow(/unsupported field/i);
    expect(() => parsePortableBackup(JSON.stringify({ ...backup, format: 'unknown' }))).toThrow(/not supported/i);
  });

  it('rejects duplicate source IDs, bad dates/statuses, bad text totals, and unsafe document paths', () => {
    const backup = sampleBackup();
    expect(() => parsePortableBackup(JSON.stringify({ ...backup, notes: [backup.notes[0], backup.notes[0]] }))).toThrow(/duplicate source IDs/i);
    expect(() => parsePortableBackup(JSON.stringify({ ...backup, tasks: [{ ...backup.tasks[0], status: 'scheduled' }] }))).toThrow(/Task status/i);
    expect(() => parsePortableBackup(JSON.stringify({ ...backup, exportedAt: 'yesterday' }))).toThrow(/valid date/i);
    expect(() => parsePortableBackup(JSON.stringify({ ...backup, documents: [{ ...backup.documents[0], content: 'x'.repeat(BACKUP_LIMITS.maxRestoredTextBytes + 1) }], archivedDocuments: [] }))).toThrow(/text size|total restore limit/i);
    for (const path of ['/memory/a.md', 'C:/memory/a.md', 'memory/../a.md', 'memory\\a.md', 'memory/CON.md', 'memory/%2e%2e/a.md', 'other/a.md', 'memory/a.txt']) {
      expect(() => validatePortableDocumentPath(path)).toThrow();
    }
    expect(() => parsePortableBackup(JSON.stringify({ ...backup, documents: [backup.documents[0], { ...backup.documents[0], path: 'memory/Profile.md' }] }))).toThrow(/duplicate or case-colliding/i);
  });

  it('bounds UTF-8, nesting, dangerous keys, and rejects malformed UTF-8', () => {
    expect(() => parsePortableBackup(new Uint8Array([0xc3, 0x28]))).toThrow(/UTF-8/i);
    expect(() => parsePortableBackup(' '.repeat(BACKUP_LIMITS.maxBytes + 1))).toThrow(/size/i);
    expect(() => parsePortableBackup('['.repeat(BACKUP_LIMITS.maxDepth + 1) + '0' + ']'.repeat(BACKUP_LIMITS.maxDepth + 1))).toThrow(/nesting/i);
    const dangerous = '{"format":"still-backup-v3","schemaVersion":3,"exportId":"x","exportedAt":"2026-10-12T10:00:00.000Z","audioIncluded":false,"notes":[],"tasks":[],"documents":[],"archivedDocuments":[],"history":[],"knowledge":{"state":{"schemaVersion":1,"people":[],"projects":[],"suggestions":[]},"narratives":[]},"archivedKnowledge":[],"__proto__":{}}';
    expect(() => parsePortableBackup(dangerous)).toThrow(/forbidden object key/i);
    const malformedScalar = JSON.stringify({ ...sampleBackup(), notes: [{ ...sampleBackup().notes[0], title: '\ud800' }] });
    expect(() => parsePortableBackup(malformedScalar)).toThrow(/invalid Unicode|title is invalid/i);
  });

  it('summarizes conflicts and produces content canonicalization without export metadata', () => {
    const backup = sampleBackup();
    const other = { ...backup, exportId: 'export-2', exportedAt: '2026-10-13T10:00:00.000Z' };
    expect(canonicalPortableContent(backup)).toBe(canonicalPortableContent(other));
    expect(summarizePortableBackup(backup, [{ path: 'MEMORY/PROFILE.md', content: 'Preference' }])).toMatchObject({
      noteCount: 1, taskCount: 1, documentCount: 2, archivedDocumentCount: 1, historyCount: 1, missingAudioCount: 1,
      documentConflicts: [{ path: 'memory/profile.md', identical: false }],
    });
  });

  it('preserves orphan task provenance without attaching it to a colliding current note ID', () => {
    const state = emptyState();
    state.notes.push({ id: 'same-source-id', title: 'Unrelated current note', transcript: 'Current content', durationSeconds: 0, createdAt: at, status: 'recorded', revision: 1 });
    state.tasks.push({ id: 'orphan-task', title: 'Orphan', body: 'Keep the provenance', status: 'open', createdAt: at,
      importOrigin: { kind: 'backup_import', archiveId: 'archive-a', sourceTaskId: 'old-task', originalSourceNoteId: 'same-source-id' } });
    const backup = createPortableBackup(state, { exportId: 'portable-a', exportedAt: at });
    const task = backup.tasks[0]!;
    expect(task.sourceNoteId).toBeUndefined();
    expect(task.unresolvedSourceNoteId).toBe('same-source-id');
    const restored = parsePortableBackup(JSON.stringify(backup)).backup.tasks[0]!;
    expect(restored.sourceNoteId).toBeUndefined();
    expect(restored.unresolvedSourceNoteId).toBe('same-source-id');
    expect(parsePortableBackup(JSON.stringify(sampleBackup())).backup.tasks[0]?.sourceNoteId).toBe('note-1');
  });

  it('validates persistent inert archive rows and rejects malformed or unknown fields', () => {
    const portableKnowledge = createPortableKnowledge(knowledgeWithProviderReference());
    const archive = {
      id: 'archive-1', contentHash: 'a'.repeat(64), fileHash: 'b'.repeat(64), sourceFormat: PORTABLE_BACKUP_FORMAT,
      exportedAt: at, importedAt: at, noteLinks: [{ sourceId: 'n1', noteId: 'local-n1' }], taskLinks: [],
      documents: [{ id: 'doc1', path: 'memory/profile.md', content: 'Older content', revision: 1, updatedAt: at }],
      history: [{ id: 'h1', kind: 'dispatch', sourceId: 'dispatch:provider-' + 'x'.repeat(300), title: 'Claim', content: 'Unverified', status: 'unknown' }],
      archivedKnowledge: [{ id: 'cohort-1', sourceId: 'active-knowledge', knowledge: portableKnowledge,
        activationLinks: [{ entityKind: 'person', sourceEntityId: personUuid, entityId: '123e4567-e89b-42d3-a456-426614174009', sourceDigest: 'd'.repeat(64), activatedAt: at }] }],
    };
    expect(validateImportedBackupArchive(archive)).toMatchObject({ id: 'archive-1', history: [{ kind: 'dispatch' }], archivedKnowledge: [{ sourceId: 'active-knowledge', activationLinks: [{ entityKind: 'person' }] }] });
    expect(validateImportedBackupArchive({ ...archive, history: [...archive.history, { ...archive.history[0], sourceId: 'dispatch:different-source' }] })).toBeUndefined();
    expect(validateImportedBackupArchive({ ...archive, credentials: { token: 'secret' } })).toBeUndefined();
    expect(validateImportedBackupArchive({ ...archive, documents: [{ ...archive.documents[0], activatedPath: 'memory/../x.md' }] })).toBeUndefined();
    expect(validateImportedBackupArchive({ ...archive, archivedKnowledge: [{ ...archive.archivedKnowledge[0], activationLinks: [{ ...archive.archivedKnowledge[0].activationLinks[0], sourceDigest: 'bad' }] }] })).toBeUndefined();

    const state = emptyState();
    state.importedBackups.push(validateImportedBackupArchive(archive)!);
    const exportedAgain = createPortableBackup(state, { exportId: 'portable-archive', exportedAt: at });
    expect(exportedAgain.archivedKnowledge).toHaveLength(1);
    expect(exportedAgain.archivedKnowledge[0]?.knowledge.state.people[0]?.sourceLinks[0]?.reference).toEqual({ kind: 'historical', label: 'Planning message', originalKind: 'mail' });
    expect(JSON.stringify(exportedAgain)).not.toContain('private-account-key');
  });
});
