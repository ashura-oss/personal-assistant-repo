import { describe, expect, it } from 'vitest';
import type { Account, AppState, Calendar, Proposal } from '../src/core';
import { appendDispatchReconciliation, createDispatchRecord, recordDispatchOutcome, validateDispatchRecord } from '../src/dispatch';
import { AppControllerImpl } from '../src/services/controller';
import type { StateStore } from '../src/storage/contracts';

class MemoryStore implements StateStore {
  value?: AppState;
  async load() { return this.value ? structuredClone(this.value) : undefined; }
  async save(state: AppState) { this.value = structuredClone(state); }
  async clear() { this.value = undefined; }
}

const provenance = {
  version: 1 as const,
  assistContractVersion: 'assist-v1', analysisFingerprint: 'analysis-fingerprint', noteId: 'note-1', noteRevision: 3,
  capturedAt: '2026-10-12T00:00:00.000Z', captureTimeZone: 'Asia/Singapore', intent: 'assist' as const,
  sources: [{ sourceId: 'transcript', revision: 3, sourceVersion: `3:${'a'.repeat(64)}` }],
  policySources: [], settingsFingerprint: 'settings-fingerprint',
};

function googleAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'account-1', provider: 'google', displayName: 'Work', email: 'me@example.test', connected: true, authStatus: 'connected',
    identity: { providerNamespace: 'google', clientId: 'google-client', subject: 'google-subject' },
    tokenRef: 'sensitive-token-ref', grantedScopes: ['private-scope'], capabilities: ['mail.send'], connectionGeneration: 7,
    ...overrides,
  };
}

function emailProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'proposal-1', noteId: 'note-1', kind: 'email', title: 'Agenda', body: 'Here is the agenda.', status: 'dispatching', revision: 2,
    approvedRevision: 2, approvedPayloadDigest: 'b'.repeat(64), sourceActionKey: '["note-1",3,"email",["email alex"]]',
    provenance, accountId: 'account-1', recipients: ['alex@example.test'], sourceRevision: 3, evidence: [{ quote: 'Email Alex the agenda.' }],
    email: { operation: 'send', to: ['alex@example.test'], cc: [], bcc: [], subject: 'Agenda', text: 'Here is the agenda.', attachments: [] },
    ...overrides,
  };
}

const startedAt = '2026-10-12T01:02:03.000Z';

describe('immutable dispatch records', () => {
  it('projects an approved operation into a deeply frozen copy', () => {
    const proposal = emailProposal();
    const record = createDispatchRecord({ id: 'dispatch-1', dispatchStartedAt: startedAt, proposal, account: googleAccount() });
    proposal.email!.to[0] = 'changed@example.test';
    expect(record.payload.kind).toBe('email');
    if (record.payload.kind !== 'email') throw new Error('Expected email payload');
    expect(record.payload.email.to).toEqual(['alex@example.test']);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.payload)).toBe(true);
    expect(Object.isFrozen(record.payload.email.to)).toBe(true);
  });

  it('copies only allowlisted nonsecret account and payload fields', () => {
    const account = { ...googleAccount(), accessToken: 'access-secret', refreshToken: 'refresh-secret', clientSecret: 'client-secret' } as Account & Record<string, unknown>;
    const proposal = { ...emailProposal(), apiKey: 'proposal-secret', bearerToken: 'another-secret' } as Proposal & Record<string, unknown>;
    const record = createDispatchRecord({ id: 'dispatch-2', dispatchStartedAt: startedAt, proposal, account });
    const serialized = JSON.stringify(record);
    for (const secret of ['sensitive-token-ref', 'private-scope', 'access-secret', 'refresh-secret', 'client-secret', 'proposal-secret', 'another-secret']) {
      expect(serialized).not.toContain(secret);
    }
    expect(record.account).toEqual({ provider: 'google', identity: { providerNamespace: 'google', clientId: 'google-client', subject: 'google-subject' }, displayName: 'Work', email: 'me@example.test' });
  });

  it('rejects mismatched event destination, account, and nonwritable calendars', () => {
    const event = emailProposal({
      kind: 'event', email: undefined, calendarId: 'calendar-local', eventTransactionId: 'd4d8dddf-0f20-48d1-87d7-829a20de66be',
      event: { title: 'Planning', description: 'Plan the launch.', start: '2026-10-14T09:00:00+08:00', end: '2026-10-14T10:00:00+08:00', timeZone: 'Asia/Singapore', attendees: [], invitePolicy: 'none' },
    });
    const calendar: Calendar = { id: 'calendar-local', accountId: 'account-1', name: 'Work', providerId: 'opaque==', connected: true, writable: true };
    expect(() => createDispatchRecord({ id: 'dispatch-event', dispatchStartedAt: startedAt, proposal: event, account: googleAccount(), calendar: { ...calendar, id: 'other-calendar' } })).toThrow(/destination/i);
    expect(() => createDispatchRecord({ id: 'dispatch-event', dispatchStartedAt: startedAt, proposal: event, account: googleAccount(), calendar: { ...calendar, accountId: 'other-account' } })).toThrow(/destination/i);
    expect(() => createDispatchRecord({ id: 'dispatch-event', dispatchStartedAt: startedAt, proposal: event, account: googleAccount(), calendar: { ...calendar, writable: false } })).toThrow(/destination/i);
    const record = createDispatchRecord({ id: 'dispatch-event', dispatchStartedAt: startedAt, proposal: event, account: googleAccount(), calendar });
    expect(record.calendar).toEqual({ localId: 'calendar-local', providerId: 'opaque==', name: 'Work' });
    expect(record.providerIdempotencyKey).toBe(event.eventTransactionId);
  });

  it('keeps identity action keys stable across reconnect generations', () => {
    const proposal = emailProposal();
    const first = createDispatchRecord({ id: 'dispatch-a', dispatchStartedAt: startedAt, proposal, account: googleAccount() });
    const second = createDispatchRecord({ id: 'dispatch-b', dispatchStartedAt: startedAt, proposal, account: googleAccount({
      displayName: 'Renamed', email: 'new-display@example.test', connectionGeneration: 19,
    }) });
    expect(first.duplicateKey).toBe(second.duplicateKey);
  });

  it('preserves unknown outcomes through append-only human reconciliation and never makes them retryable', () => {
    const pending = createDispatchRecord({ id: 'dispatch-unknown', dispatchStartedAt: startedAt, proposal: emailProposal(), account: googleAccount() });
    const unknown = recordDispatchOutcome(pending, { outcome: 'unknown', at: '2026-10-12T01:02:10.000Z' });
    const reconciled = appendDispatchReconciliation(unknown, { id: 'review-1', disposition: 'not_found', at: '2026-10-12T01:10:00.000Z', note: 'Checked the destination manually.' });
    expect(reconciled.outcome).toBe('unknown');
    expect(reconciled.reconciliations).toHaveLength(1);
    expect(() => recordDispatchOutcome(reconciled, { outcome: 'rejected', at: '2026-10-12T01:11:00.000Z', rejectionCode: 'provider_rejected' })).toThrow(/terminal/i);
    expect(() => recordDispatchOutcome(recordDispatchOutcome(pending, { outcome: 'accepted', at: '2026-10-12T01:02:10.000Z' }), {
      outcome: 'rejected', at: '2026-10-12T01:11:00.000Z', rejectionCode: 'provider_rejected',
    })).toThrow(/terminal/i);
  });

  it('validates persisted snapshots and rejects injected secret fields', () => {
    const pending = createDispatchRecord({ id: 'dispatch-validate', dispatchStartedAt: startedAt, proposal: emailProposal(), account: googleAccount() });
    const unknown = recordDispatchOutcome(pending, { outcome: 'unknown', at: '2026-10-12T01:02:10.000Z' });
    const reviewed = appendDispatchReconciliation(unknown, { id: 'review-1', disposition: 'abandoned', at: '2026-10-12T01:10:00.000Z', note: 'No further action.' });
    const restored = validateDispatchRecord(JSON.parse(JSON.stringify(reviewed)));
    expect(restored.outcome).toBe('unknown');
    expect(restored.reconciliations).toHaveLength(1);
    expect(Object.isFrozen(restored.reconciliations[0])).toBe(true);
    expect(() => validateDispatchRecord({ ...pending, accessToken: 'must-not-persist' })).toThrow(/unsupported fields/i);
  });

  it('freezes and reloads mail-origin reply dispatches without invented note revisions', () => {
    const observedAt = '2026-10-12T01:00:00.000Z';
    const digest = 'd'.repeat(64);
    const source = {
      version: 1 as const, accountId: 'account-1', accountEmail: 'me@example.test', verifiedSelfEmail: 'me@example.test',
      identity: googleAccount().identity!, connectionGeneration: 7, localMessageId: 'local-message', providerMessageId: 'provider-message',
      idFormat: 'gmail' as const, threadId: 'thread-1', internetMessageId: '<original@example.test>',
      references: '<parent@example.test>', subject: 'Project update', from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test',
      replyTo: ['sam@example.test'], to: ['me@example.test', 'alex@example.test'], cc: ['casey@example.test'],
      replyMetadataComplete: true as const, observedAt, sourceDigest: digest,
    };
    const provenance = { version: 2 as const, kind: 'mail_reply' as const, sourceDigest: digest, source,
      expiresAt: '2026-10-12T01:15:00.000Z' };
    const reply = { mode: 'reply_all' as const, sourceDigest: digest, localMessageId: source.localMessageId,
      providerMessageId: source.providerMessageId, idFormat: source.idFormat, internetMessageId: source.internetMessageId,
      sourceSubject: source.subject, threadId: source.threadId, references: '<parent@example.test> <original@example.test>',
      inReplyTo: source.internetMessageId };
    const proposal: Proposal = {
      id: 'mail-reply-proposal', kind: 'email', title: 'Re: Project update', body: 'Thanks for the update.', status: 'approved',
      revision: 1, approvedRevision: 1, approvedPayloadDigest: 'e'.repeat(64), sourceActionKey: 'mail-action', provenance,
      accountId: 'account-1', recipients: ['sam@example.test', 'alex@example.test'], evidence: [],
      email: { operation: 'draft', to: ['sam@example.test', 'alex@example.test'], cc: ['casey@example.test'], bcc: [],
        subject: source.subject, text: 'Thanks for the update.', attachments: [], reply },
    };
    const record = createDispatchRecord({ id: 'mail-dispatch', dispatchStartedAt: startedAt, proposal, account: googleAccount() });
    expect(record.sourceRevision).toBeUndefined();
    expect(record.sourceProvenance.version).toBe(2);
    expect(record.payload.kind === 'email' && record.payload.email.reply).toEqual(reply);
    const restored = validateDispatchRecord(JSON.parse(JSON.stringify(record)));
    expect(restored.sourceRevision).toBeUndefined();
    expect(restored.sourceProvenance.version).toBe(2);
    expect(restored.payload.kind === 'email' && restored.payload.email.reply).toEqual(reply);
    const accepted = recordDispatchOutcome(restored, { outcome: 'accepted', at: '2026-10-12T01:02:10.000Z', remoteId: 'draft-1', replyDraftCheck: 'matches_approved' });
    const acceptedRestored = validateDispatchRecord(JSON.parse(JSON.stringify(accepted)));
    expect(acceptedRestored).toMatchObject({ outcome: 'accepted', replyDraftCheck: 'matches_approved', remoteId: 'draft-1' });
  });

  it('binds Batch reply sends to an explicit Send activation while keeping Draft receipts unchanged', () => {
    const observedAt = '2026-10-12T01:00:00.000Z';
    const digest = 'd'.repeat(64);
    const source = {
      version: 1 as const, accountId: 'account-1', accountEmail: 'me@example.test', verifiedSelfEmail: 'me@example.test',
      identity: googleAccount().identity!, connectionGeneration: 7, localMessageId: 'local-message', providerMessageId: 'provider-message',
      idFormat: 'gmail' as const, threadId: 'thread-1', internetMessageId: '<original@example.test>',
      references: '<parent@example.test>', subject: 'Project update', from: 'Sam <sam@example.test>', senderEmail: 'sam@example.test',
      replyTo: ['sam@example.test'], to: ['me@example.test'], cc: ['alex@example.test'], replyMetadataComplete: true as const,
      observedAt, sourceDigest: digest,
    };
    const mailProvenance = { version: 2 as const, kind: 'mail_reply' as const, batchJobId: 'a314260e-a539-4dfd-85c7-696e2a1ab573', sourceDigest: digest,
      source, expiresAt: '2026-10-12T01:15:00.000Z' };
    const reply = { mode: 'reply' as const, sourceDigest: digest, localMessageId: source.localMessageId,
      providerMessageId: source.providerMessageId, idFormat: source.idFormat, internetMessageId: source.internetMessageId,
      sourceSubject: source.subject, threadId: source.threadId, references: '<parent@example.test> <original@example.test>', inReplyTo: source.internetMessageId };
    const base = { ...emailProposal(), noteId: undefined, sourceRevision: undefined, provenance: mailProvenance,
      sourceActionKey: 'mail-action', email: { operation: 'draft' as const, to: ['sam@example.test'], cc: [], bcc: [],
        subject: source.subject, text: 'Approved reply.', attachments: [], reply } };
    const draft = createDispatchRecord({ id: 'batch-reply-draft', dispatchStartedAt: startedAt, proposal: base, account: googleAccount() });
    expect(draft.mailReplyBatchBinding).toEqual({ jobId: mailProvenance.batchJobId, provenanceCanonical: expect.any(String) });
    expect(JSON.stringify(draft.mailReplyBatchBinding)).not.toContain('activationOperation');
    expect(validateDispatchRecord(JSON.parse(JSON.stringify(draft)))).toMatchObject({ operation: 'draft' });

    const sendProposal = { ...base, email: { ...base.email!, operation: 'send' as const } };
    const send = createDispatchRecord({ id: 'batch-reply-send', dispatchStartedAt: startedAt, proposal: sendProposal,
      account: googleAccount(), mailReplyActivationOperation: 'send' });
    expect(send.mailReplyBatchBinding).toMatchObject({ jobId: mailProvenance.batchJobId, activationOperation: 'send' });
    expect(validateDispatchRecord(JSON.parse(JSON.stringify(send)))).toMatchObject({ operation: 'send', mailReplyBatchBinding: { activationOperation: 'send' } });
    expect(() => validateDispatchRecord({ ...send, mailReplyBatchBinding: { ...send.mailReplyBatchBinding!, activationOperation: undefined } }))
      .toThrow(/consistency proof/i);
    expect(() => validateDispatchRecord({ ...draft, mailReplyBatchBinding: { ...draft.mailReplyBatchBinding!, activationOperation: 'send' } }))
      .toThrow(/consistency proof/i);
  });

  it('captures real controller provenance with provider-sized fingerprints and multiline questions', async () => {
    const app = new AppControllerImpl(new MemoryStore());
    await app.load();
    await app.saveSettings({
      openAiEndpoint: 'https://tenant.openai.azure.com',
      openAiDeployment: `integration-${'x'.repeat(600)}`,
    });
    const transcript = `Email Alex the agenda. ${'Context for provenance. '.repeat(40)}`;
    const note = await app.saveNote({ transcript });
    const question = 'Who needs the agenda?\nWhich details should I include?';
    await app.assistNote(note.id, { intent: 'answer', question });
    const generated = app.getSnapshot().proposals.find((item) => item.noteId === note.id && item.kind === 'email');
    if (generated?.provenance?.version !== 1) throw new Error('Expected controller-created note provenance');
    expect(generated?.provenance?.analysisFingerprint.length).toBeGreaterThan(512);
    expect(generated?.provenance?.settingsFingerprint.length).toBeGreaterThan(512);
    expect(generated?.provenance?.question).toBe(question);
    const proposal: Proposal = {
      ...generated,
      status: 'approved',
      approvedRevision: generated.revision,
      approvedPayloadDigest: 'c'.repeat(64),
      accountId: 'account-1',
      email: { operation: 'send', to: ['alex@example.test'], cc: [], bcc: [], subject: 'Agenda', text: 'Here is the agenda.', attachments: [] },
    };
    const record = createDispatchRecord({ id: 'controller-dispatch', dispatchStartedAt: startedAt, proposal, account: googleAccount() });
    if (record.sourceProvenance.version !== 1) throw new Error('Expected frozen note provenance');
    expect(record.sourceProvenance.analysisFingerprint.length).toBeGreaterThan(512);
    expect(record.sourceProvenance.settingsFingerprint.length).toBeGreaterThan(512);
    expect(record.sourceProvenance.question).toContain('\n');
  });

  it('rejects source-provenance mismatch, duplicate sources, and proposals needing rebuild', () => {
    expect(() => createDispatchRecord({
      id: 'bad-source', dispatchStartedAt: startedAt,
      proposal: emailProposal({ sourceRevision: 4 }), account: googleAccount(),
    })).toThrow(/provenance/i);
    expect(() => createDispatchRecord({
      id: 'duplicate-sources', dispatchStartedAt: startedAt,
      proposal: emailProposal({ provenance: { ...provenance, sources: [...provenance.sources, ...provenance.sources] } }), account: googleAccount(),
    })).toThrow(/unique/i);
    expect(() => createDispatchRecord({
      id: 'needs-rebuild', dispatchStartedAt: startedAt,
      proposal: emailProposal({ requiresRebuild: true }), account: googleAccount(),
    })).toThrow(/rebuild/i);
  });

  it('rejects invalid outcome ordering, invalid provenance enums, and reconciliation overflow', () => {
    const pending = createDispatchRecord({ id: 'time-check', dispatchStartedAt: startedAt, proposal: emailProposal(), account: googleAccount() });
    expect(() => recordDispatchOutcome(pending, { outcome: 'pending' as never, at: '2026-10-12T01:02:10.000Z' })).toThrow(/outcome is invalid/i);
    expect(() => recordDispatchOutcome(pending, { outcome: 'bogus' as never, at: '2026-10-12T01:02:10.000Z' })).toThrow(/outcome is invalid/i);
    expect(() => recordDispatchOutcome(pending, { outcome: 'unknown', at: '2026-10-12T01:02:02.000Z' })).toThrow(/predates/i);
    expect(() => createDispatchRecord({
      id: 'bad-intent', dispatchStartedAt: startedAt,
      proposal: emailProposal({ provenance: { ...provenance, intent: 'bogus' as never } }), account: googleAccount(),
    })).toThrow(/intent/i);
    let reconciled = recordDispatchOutcome(pending, { outcome: 'unknown', at: '2026-10-12T01:02:10.000Z' });
    for (let index = 0; index < 100; index += 1) {
      reconciled = appendDispatchReconciliation(reconciled, {
        id: `review-${index}`, disposition: 'abandoned', at: '2026-10-12T01:10:00.000Z', note: 'Reviewed.',
      });
    }
    expect(() => appendDispatchReconciliation(reconciled, {
      id: 'review-overflow', disposition: 'abandoned', at: '2026-10-12T01:10:00.000Z', note: 'Reviewed.',
    })).toThrow(/full/i);
  });
});
