import { describe, expect, it, vi } from 'vitest';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO, type WorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import { createWebWorkspaceClient } from '../src/web/workspaceClient';

const workspaceId = '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8';
const session = Object.freeze({ authenticated: true as const, workspaceId, privacyEpoch: 3, csrfToken: 'private-csrf' });
const archiveId = '30000000-0000-4000-8000-000000000001';
const cohortId = '30000000-0000-4000-8000-000000000002';
const entityId = '018f47f6-6c2a-7abc-8def-123456789abc';
const activationTargetId = '30000000-0000-4000-8000-000000000004';
const activationSessionId = '30000000-0000-4000-8000-000000000005';

function safeResponse(body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: true, status: 200, json: async () => JSON.parse(text), arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    headers: new Headers(headers) };
}

function snapshot(): WorkspaceSnapshotDTO {
  const state = createInitialWorkspaceState(() => '00000000-0000-4000-8000-000000000001');
  return createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 3, revision: 7 });
}

function backupPreview() {
  return {
    sessionId: '40000000-0000-4000-8000-000000000001', fileHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), planHash: 'c'.repeat(64),
    sourceFormat: 'still-backup-v5', exportedAt: '2026-10-15T02:03:04.000Z', noteCount: 1, taskCount: 2, documentCount: 0,
    historyCount: 0, chatConversationCount: 0, chatTurnCount: 0, personCount: 0, projectCount: 0, knowledgeCohortCount: 0,
    missingAudioCount: 0, missingNoteCount: 1, missingTaskCount: 2, missingNoteLabels: ['A note'], missingTaskLabels: ['A task'],
    taskLinkRepairCount: 0, taskLinkRepairLabels: [], documentConflicts: [], warnings: [], ignoredFieldCount: 0,
    alreadyImported: false, prospectivePersistedBytes: 512, withinPersistedSnapshotLimit: true,
  };
}

function personPreview() {
  const sourceEntity = { id: entityId, revision: 1, name: 'Imported person', aliases: [], narrativePath: `people/${entityId}.md`,
    createdAt: '2026-10-15T02:03:04.000Z', updatedAt: '2026-10-15T02:03:04.000Z', facts: [], sourceLinks: [], contacts: [] };
  return { schemaVersion: 1, workspaceId, privacyEpoch: 3, revision: 7, preview: {
    sessionId: activationSessionId, planHash: 'd'.repeat(64), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), archiveId, cohortId,
    kind: 'person', sourceEntityId: entityId, sourceName: sourceEntity.name, sourceEntity, alreadyActivated: false,
    targetId: activationTargetId, narrativePath: `people/${activationTargetId}.md`, narrativeContent: '# Imported person',
    factCount: 0, contactCount: 0, sourceLinkCount: 0, memberCount: 0, unavailableProviderReferenceCount: 0, unresolvedMemberCount: 0,
  } };
}

describe('portable backup browser transport', () => {
  it('downloads only the authenticated JSON attachment and previews bounded raw local bytes', async () => {
    const dto = snapshot();
    const calls: { path: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (input: string, init: RequestInit = {}) => {
      const path = String(input);
      calls.push({ path, init });
      if (path.includes('/api/workspace/snapshot') || path.includes('/api/workspace/refresh')) return safeResponse(dto, { 'Content-Type': 'application/json' });
      if (path.startsWith('/api/workspace/backup/export')) return safeResponse('{"format":"still-backup-v5"}',
        { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="still-backup.json"' });
      if (path.startsWith('/api/workspace/backup/import/preview')) return safeResponse({ schemaVersion: 1, workspaceId,
        privacyEpoch: 3, revision: 7, preview: backupPreview() }, { 'Content-Type': 'application/json' });
      throw new Error(`unexpected request: ${input}`);
    });
    const client = createWebWorkspaceClient(session, { assertCurrent() {}, decodeSnapshot: (value) => value as WorkspaceSnapshotDTO, fetcher: fetcher as never });
    await client.refresh();
    const exported = await client.exportPortableBackup(7);
    expect(new TextDecoder().decode(exported)).toBe('{"format":"still-backup-v5"}');
    expect(calls[1]?.path).toBe('/api/workspace/backup/export?expectedRevision=7&expectedPrivacyEpoch=3');
    expect(calls[1]?.init).toMatchObject({ method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    const bytes = new TextEncoder().encode('{"userSelected":true}');
    const preview = await client.preparePortableBackupImport(bytes, 7);
    expect(preview.sourceFormat).toBe('still-backup-v5');
    expect(calls[2]?.path).toBe('/api/workspace/backup/import/preview?expectedRevision=7&expectedPrivacyEpoch=3');
    expect(calls[2]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', redirect: 'error' });
    expect(calls[2]?.init.headers).toEqual({ 'Content-Type': 'application/json; charset=utf-8', 'X-Still-CSRF': 'private-csrf' });
    expect(calls[2]?.init.body).toEqual(bytes);
    client.dispose();
  });

  it('rejects malformed preview envelopes and oversized local bytes before network admission', async () => {
    const dto = snapshot();
    const fetcher = vi.fn(async (input: string) => String(input).includes('/api/workspace/snapshot')
      ? safeResponse(dto)
      : safeResponse({ schemaVersion: 1, workspaceId, privacyEpoch: 3, revision: 7,
        preview: { ...backupPreview(), unexpected: 'authority' } }));
    const client = createWebWorkspaceClient(session, { assertCurrent() {}, decodeSnapshot: (value) => value as WorkspaceSnapshotDTO, fetcher: fetcher as never });
    await client.refresh();
    await expect(client.preparePortableBackupImport(new Uint8Array(32 * 1024 * 1024 + 1), 7)).rejects.toMatchObject({ kind: 'malformed' });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(client.preparePortableBackupImport(new Uint8Array([1]), 7)).rejects.toMatchObject({ kind: 'malformed' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    client.dispose();
  });

  it('validates imported knowledge preview identity, exact fields, and expiry', async () => {
    const dto = snapshot();
    let responseBody = personPreview();
    const fetcher = vi.fn(async (input: string) => String(input).includes('/api/workspace/snapshot')
      ? safeResponse(dto) : safeResponse(responseBody));
    const client = createWebWorkspaceClient(session, { assertCurrent() {}, decodeSnapshot: (value) => value as WorkspaceSnapshotDTO, fetcher: fetcher as never });
    await client.refresh();
    await expect(client.prepareImportedKnowledgeActivation({ archiveId, cohortId, kind: 'person', entityId, expectedRevision: 7 }))
      .resolves.toMatchObject({ sessionId: activationSessionId, targetId: activationTargetId });
    responseBody = { ...personPreview(), preview: { ...personPreview().preview, sourceEntity: { ...personPreview().preview.sourceEntity, id: archiveId } } };
    await expect(client.prepareImportedKnowledgeActivation({ archiveId, cohortId, kind: 'person', entityId, expectedRevision: 7 }))
      .rejects.toMatchObject({ kind: 'malformed' });
    client.dispose();
  });
});
