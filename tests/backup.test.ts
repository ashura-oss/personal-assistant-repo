import { describe, expect, it } from 'vitest';
import type { AppState } from '../src/core';
import {
  BACKUP_LIMITS, PORTABLE_BACKUP_FORMAT, canonicalPortableContent, createPortableBackup,
  parsePortableBackup, summarizePortableBackup, validateImportedBackupArchive,
  validatePortableDocumentPath, type PortableBackupV2,
} from '../src/backup';

const at = '2026-10-12T10:00:00.000Z';

function emptyState(): AppState {
  return {
    notes: [], proposals: [], tasks: [], accounts: [], calendars: [], documents: [], activity: [],
    settings: {} as AppState['settings'], usage: {} as AppState['usage'], mailbox: [], selectedMailTexts: [], calendarEvents: [],
    syncStates: {}, pendingCredentialCleanup: [], dispatchRecords: [], dispatchRecordQuarantine: [], mailboxSchemaVersion: 2,
    proactive: { schemaVersion: 1, rules: [], candidates: [], dismissals: [], snoozes: [] },
    importedBackups: [],
  };
}

function sampleBackup(): PortableBackupV2 {
  return {
    format: PORTABLE_BACKUP_FORMAT, schemaVersion: 2, exportId: 'export-1', exportedAt: at, audioIncluded: false,
    notes: [{ sourceId: 'note-1', title: 'Walk', transcript: 'Remember the route', durationSeconds: 8, createdAt: at, audioMissing: true }],
    tasks: [{ sourceId: 'task-1', title: 'Call', body: 'Call the clinic', status: 'open', createdAt: at, sourceNoteId: 'note-1' }],
    documents: [{ path: 'memory/profile.md', content: 'Preference', revision: 2, updatedAt: at }],
    archivedDocuments: [{ sourceId: 'archived-1', path: 'memory/profile.md', content: 'Older preference', revision: 1, updatedAt: at }],
    history: [{ kind: 'dispatch', sourceId: 'dispatch:ref-' + 'x'.repeat(300), title: 'Action — imported history', content: 'Sent a message', status: 'accepted (unverified imported history)', occurredAt: at, provider: 'google', reference: 'provider-id' }],
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
      source: 'offline_preview', includedSourceIds: [], includedSources: [], omittedSourceIds: [], omittedSourceCount: 0, sourceVersions: {} };
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
  });

  it('rejects unknown v2 fields and unsupported formats while allowing archived path duplicates', () => {
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
    const dangerous = '{"format":"still-backup-v2","schemaVersion":2,"exportId":"x","exportedAt":"2026-10-12T10:00:00.000Z","audioIncluded":false,"notes":[],"tasks":[],"documents":[],"archivedDocuments":[],"history":[],"__proto__":{}}';
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
    const archive = {
      id: 'archive-1', contentHash: 'a'.repeat(64), fileHash: 'b'.repeat(64), sourceFormat: PORTABLE_BACKUP_FORMAT,
      exportedAt: at, importedAt: at, noteLinks: [{ sourceId: 'n1', noteId: 'local-n1' }], taskLinks: [],
      documents: [{ id: 'doc1', path: 'memory/profile.md', content: 'Older content', revision: 1, updatedAt: at }],
      history: [{ id: 'h1', kind: 'dispatch', sourceId: 'dispatch:provider-' + 'x'.repeat(300), title: 'Claim', content: 'Unverified', status: 'unknown' }],
    };
    expect(validateImportedBackupArchive(archive)).toMatchObject({ id: 'archive-1', history: [{ kind: 'dispatch' }] });
    expect(validateImportedBackupArchive({ ...archive, history: [...archive.history, { ...archive.history[0], sourceId: 'dispatch:different-source' }] })).toBeUndefined();
    expect(validateImportedBackupArchive({ ...archive, credentials: { token: 'secret' } })).toBeUndefined();
    expect(validateImportedBackupArchive({ ...archive, documents: [{ ...archive.documents[0], activatedPath: 'memory/../x.md' }] })).toBeUndefined();
  });
});
