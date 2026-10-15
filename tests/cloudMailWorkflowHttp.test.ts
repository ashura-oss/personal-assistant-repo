import { describe, expect, it } from 'vitest';
import { createWorkspaceHttpApi } from '../src/cloud/workspaceHttp.node';
import type { WorkspaceHttpAdmission } from '../server/src/workspaceHttp';
import type { OwnedWorkspaceRuntime } from '../src/cloud/ownedWorkspaceRuntime.node';

const admission = { sessionToken: 'kernel-session', assertCurrent() {} } as WorkspaceHttpAdmission;

describe('cloud mail workflow HTTP projection', () => {
  it('returns all workspace fences and strips private account/source fields from saved review DTOs', async () => {
    const privateSentinel = 'private-provider-subject-tokenref-path-sentinel';
    const runtime = {
      async readMailReplySource() {
        return { workspaceId: 'workspace-1', privacyEpoch: 4, revision: 12, value: {
          source: { status: 'current', source: { accountId: 'acct', connectionGeneration: 3, localMessageId: 'msg', providerMessageId: 'provider-msg',
            idFormat: 'gmail', internetMessageId: '<m@example.test>', subject: 'Hello', observedAt: '2026-10-15T00:00:00.000Z', sourceDigest: 'digest',
            identity: { subject: privateSentinel }, tokenRef: privateSentinel } },
          bodyCache: { status: 'current', snapshot: { textDigest: 'body-digest', bytes: 5, completeness: 'complete_text', representation: 'plain',
            checkedAt: '2026-10-15T00:00:00.000Z', text: privateSentinel } },
        } };
      },
      async readDispatchForReview() {
        return { workspaceId: 'workspace-1', privacyEpoch: 4, revision: 12, value: { recordVersion: 'version', record: {
          id: 'dispatch-1', proposalId: 'proposal-1', accountId: 'acct', account: { provider: 'google', displayName: 'Work', email: 'me@example.test',
            identity: { subject: privateSentinel }, tokenRef: privateSentinel }, operation: 'send', title: 'Subject', body: 'Original text',
          payload: { kind: 'email', email: { to: ['alex@example.test'], cc: [], bcc: [], subject: 'Subject', text: 'Original text',
            attachments: [{ fileName: 'agenda.pdf', mimeType: 'application/pdf', sizeBytes: 8, localPath: privateSentinel }] } },
          outcome: 'unknown', dispatchStartedAt: '2026-10-15T00:00:00.000Z', reconciliations: [], sourceProvenance: { identity: privateSentinel },
        } } };
      },
    } as unknown as OwnedWorkspaceRuntime;
    const api = createWorkspaceHttpApi(runtime);
    const source = JSON.parse(JSON.stringify(await api.readMailReplySource!(admission, { messageId: 'msg', expectedRevision: 12, expectedPrivacyEpoch: 4 }))) as Record<string, unknown>;
    expect(source).toMatchObject({ schemaVersion: 1, workspaceId: 'workspace-1', privacyEpoch: 4, revision: 12,
      status: 'current', bodyCache: { status: 'current', textDigest: 'body-digest', bytes: 5 } });
    const dispatch = JSON.parse(JSON.stringify(await api.readDispatchReview!(admission, { recordId: 'dispatch-1', expectedRevision: 12, expectedPrivacyEpoch: 4 }))) as Record<string, unknown>;
    expect(dispatch).toMatchObject({ schemaVersion: 1, workspaceId: 'workspace-1', privacyEpoch: 4, revision: 12,
      record: { id: 'dispatch-1', outcome: 'unknown', payload: { kind: 'email', text: 'Original text', attachments: [{ fileName: 'agenda.pdf', sizeBytes: 8 }] } } });
    expect(JSON.stringify([source, dispatch])).not.toContain(privateSentinel);
    expect(JSON.stringify(dispatch)).not.toContain('localPath');
  });
});
