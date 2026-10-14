import { describe, expect, it } from 'vitest';
import type { AppState, Proposal } from '../src/core';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO, type DeepReadonly, type WorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';

const workspaceId = '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8';
const ids = [
  '42692596-d245-4c9d-bc55-e64ddc274ca1',
  '8e9d7422-7f2b-4a25-91d0-6758705d3c22',
  '6b4c9a9d-f783-49e8-b570-643f8ac33351',
  '506bc998-2760-4c7a-9855-61f7da0ca6e1',
];

function compileReadonlyExpectations(snapshot: DeepReadonly<WorkspaceSnapshotDTO>): void {
  // @ts-expect-error Public snapshots are read-only through the TypeScript contract as well as at runtime.
  snapshot.state.notes[0]!.transcript = 'cannot mutate';
  // @ts-expect-error Nested arrays are deeply read-only.
  snapshot.state.knowledge.people.push(snapshot.state.knowledge.people[0]!);
  // @ts-expect-error Approved payload content is also deeply read-only.
  snapshot.state.proposals[0]!.email!.text = 'cannot mutate';
}
void compileReadonlyExpectations;

function richState(): AppState {
  const state = createInitialWorkspaceState(() => ids[0]!);
  state.notes.push({
    id: ids[1]!, title: 'Call notes', transcript: 'The literal word tokenRef belongs in this user-authored text.',
    audioUri: 'file:///private/local/audio-secret.m4a', durationSeconds: 42, createdAt: '2026-10-14T08:00:00.000Z',
    capturedAt: '2026-10-14T07:59:00.000Z', captureTimeZone: 'Asia/Singapore', status: 'processed', revision: 3,
    processingFingerprint: 'private-processing-fingerprint',
    audioAttachment: { kind: 'user_selected_replacement', fileName: 'voice.m4a', format: 'm4a', mimeType: 'audio/mp4', byteLength: 1200,
      sha256: 'a'.repeat(64), durationStatus: 'known', durationSeconds: 42, originalMatch: 'unverified', attachedAt: '2026-10-14T08:00:00.000Z' },
  });
  state.accounts.push({
    id: ids[2]!, provider: 'google', displayName: 'Work account', email: 'user@example.test', connected: true, authStatus: 'connected',
    identity: { providerNamespace: 'google', subject: 'subject-safe-display' }, tokenRef: 'credential-secret-do-not-send',
    grantedScopes: ['mail.read'], capabilities: ['mail.read'], capabilityLimits: ['mail.read'], connectionGeneration: 4,
  });
  state.accounts.push({ id: ids[3]!, provider: 'local', displayName: 'Local', email: '', connected: false, authStatus: 'configured' });
  state.documents.push({ path: 'memory/RULES.md', content: 'Do not strip prose merely because it mentions tokenRef.', revision: 2, updatedAt: '2026-10-14T08:00:00.000Z' });
  state.usage.estimatedCostUsd = 1.75;
  state.usage.unknownCharges = 2;
  state.usage.reservedUsd = 3;
  state.usage.priceKnown = true;
  state.settings.maxOutputTokens = 1200;
  state.settings.maxContextTokens = 6000;
  state.settings.maxRequestBytes = 24000;
  state.settings.monthlyBudgetUsd = 5;
  state.settings.maxCallsPerDay = 20;
  state.settings.inputUsdPerMillionTokens = 1;
  state.settings.outputUsdPerMillionTokens = 2;
  state.settings.speechUsdPerMinute = 0.5;
  state.pendingCredentialCleanup.push({ tokenRef: 'cleanup-secret-do-not-send', reason: 'orphan', createdAt: '2026-10-14T08:00:00.000Z' });

  const mailSource = {
    version: 1 as const, accountId: ids[2]!, accountEmail: 'user@example.test', verifiedSelfEmail: 'user@example.test',
    identity: { providerNamespace: 'google' as const, subject: 'subject-safe-display' }, connectionGeneration: 4,
    localMessageId: 'local-mail-row', providerMessageId: 'provider-message-display-id', idFormat: 'gmail' as const,
    internetMessageId: '<reply@example.test>', threadId: 'thread-safe-display', subject: 'Earlier conversation',
    from: 'sender@example.test', replyMetadataComplete: true as const, observedAt: '2026-10-14T08:00:00.000Z', sourceDigest: 'b'.repeat(64),
  };
  const proposal = {
    id: 'proposal-visible-id', noteId: ids[1]!, kind: 'email' as const, title: 'Follow up', body: 'Approved reply body', status: 'approved' as const,
    revision: 5, approvedRevision: 5, approvedPayloadDigest: 'private-approval-digest', sourceActionKey: 'private-source-action-key',
    dispatchDependencyProjection: 'private-dependency-projection', dispatchRecordId: 'private-dispatch-record-link',
    recipients: ['recipient@example.test'], evidence: [{ quote: 'A cited sentence', source: 'transcript' }], accountId: ids[2]!,
    email: { operation: 'send' as const, to: ['recipient@example.test'], cc: [], bcc: [], subject: 'Follow up', text: 'Approved reply body', attachments: [],
      reply: { mode: 'reply' as const, sourceDigest: 'b'.repeat(64), localMessageId: 'local-mail-row', providerMessageId: 'provider-message-display-id', idFormat: 'gmail' as const,
        internetMessageId: '<reply@example.test>', sourceSubject: 'Earlier conversation', threadId: 'thread-safe-display' } },
    provenance: { version: 2 as const, kind: 'mail_reply' as const, sourceDigest: 'b'.repeat(64), source: mailSource, expiresAt: '2026-10-14T08:05:00.000Z' },
  } satisfies Proposal;
  state.proposals.push(proposal);

  state.transcription.attempts.push({
    id: 'speech-attempt-display-id', leaseId: 'private-speech-lease-id', noteId: ids[1]!, sourceRevision: 3,
    source: { audioUri: 'file:///private/transcription-source.m4a', durationSeconds: 42, capturedAt: '2026-10-14T07:59:00.000Z',
      captureTimeZone: 'Asia/Singapore', speechEnabled: true, maxAudioSeconds: 600, provider: 'azure' },
    endpoint: 'https://speech.example.test', createdAt: '2026-10-14T08:01:00.000Z',
    prepared: { leaseId: 'private-prepared-lease', platform: 'native', format: 'm4a', mimeType: 'audio/mp4', byteLength: 1200, sha256: 'c'.repeat(64), durationSeconds: 42 },
    dispatchStarted: true, outcome: 'completed', terminalAt: '2026-10-14T08:02:00.000Z', locale: 'en-US',
    reservation: { month: '2026-10', day: '2026-10-14', reserve: 1 }, durationMilliseconds: 42000,
  } as AppState['transcription']['attempts'][number]);
  state.transcription.attempts.push({
    id: 'openrouter-speech-attempt', leaseId: 'private-openrouter-lease', noteId: ids[1]!, sourceRevision: 3,
    source: { audioUri: 'file:///private/openrouter-source.m4a', durationSeconds: 42, capturedAt: '2026-10-14T07:59:00.000Z',
      captureTimeZone: 'Asia/Singapore', speechEnabled: true, maxAudioSeconds: 600, provider: 'openrouter' },
    endpoint: 'https://openrouter.ai/api/v1/audio/transcriptions', createdAt: '2026-10-14T08:03:00.000Z', dispatchStarted: true,
    outcome: 'completed', terminalAt: '2026-10-14T08:04:00.000Z', provider: 'openrouter', profileVersion: 1,
    model: 'openai/gpt-4o-mini-transcribe', locale: 'auto', actualUsage: { seconds: 42, inputTokens: 90, totalTokens: 90, costUsd: 0.006 }, unknownCharge: false,
  } as AppState['transcription']['attempts'][number]);
  state.transcription.cleanupLeases.push({ leaseId: 'private-cleanup-lease', attemptId: 'speech-attempt-display-id', createdAt: '2026-10-14T08:02:00.000Z', outcome: 'pending_cleanup' });
  state.transcriptionRequestCleanupPending = [{ attemptId: 'speech-request-pending-id' }];

  state.calendars.push({ id: 'calendar-local-id', accountId: ids[2]!, name: 'Work calendar', writable: true, connected: true, providerId: 'provider-calendar-id' });
  state.calendarEvents.push({ id: 'calendar-event-local-id', accountId: ids[2]!, calendarId: 'calendar-local-id', providerEventId: 'event-display-id',
    subject: 'Planning', start: '2026-10-15T09:00:00.000Z', end: '2026-10-15T09:30:00.000Z', timeZone: 'Asia/Singapore', observedAt: '2026-10-14T08:00:00.000Z',
    verifiedIdentityKey: 'calendar-identity-display', connectionGeneration: 4 });
  state.mailbox.push({ id: 'mail-local-id', accountId: ids[2]!, providerMessageId: 'mail-provider-id', identityKey: 'mail-identity-display',
    connectionGeneration: 4, idFormat: 'gmail', subject: 'Mailbox row', from: 'sender@example.test', receivedAt: '2026-10-14T08:00:00.000Z', snippet: 'Visible summary' });

  state.dispatchRecords.push({
    version: 1, id: 'dispatch-history-id', proposalId: 'proposal-visible-id', approvedRevision: 5, payloadDigest: 'd'.repeat(64),
    sourceActionKey: 'private-dispatch-source-key', duplicateKey: 'private-duplicate-key', sourceProvenance: proposal.provenance!,
    mailReplyBatchBinding: { jobId: 'private-batch-link', provenanceCanonical: 'private-canonical-binding', activationOperation: 'send' },
    operation: 'send', accountId: ids[2]!, account: { provider: 'google', identity: { providerNamespace: 'google', clientId: 'client', subject: 'subject' }, displayName: 'Work', email: 'user@example.test' },
    title: 'Sent reply', body: 'Immutable dispatch body', payload: { kind: 'email', email: { to: ['recipient@example.test'], cc: [], bcc: [], subject: 'Follow up', text: 'Immutable dispatch body', attachments: [] } },
    dispatchStartedAt: '2026-10-14T08:02:00.000Z', providerIdempotencyKey: 'private-idempotency-key', outcome: 'accepted', remoteId: 'remote-message-id',
    reconciliations: [{ id: 'reconcile-display-id', disposition: 'confirmed_present', at: '2026-10-14T08:03:00.000Z', note: 'Provider confirmed' }],
  });

  state.knowledge.people.push({
    id: 'person-display-id', revision: 2, name: 'Maya', aliases: ['May'], narrativePath: 'people/maya.md', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
    facts: [{ id: 'fact-display-id', provenance: 'user_authored', createdAt: '2026-10-01T00:00:00.000Z', statement: 'Prefers concise updates.', evidence: [{ sourceId: 'transcript', sourceVersion: 'note:3', revision: 3, quote: 'concise updates' }] }],
    sourceLinks: [{ id: 'link-display-id', provenance: 'user_authored', createdAt: '2026-10-01T00:00:00.000Z', label: 'Planning meeting', reference: { kind: 'device_calendar_event', installationId: 'private-knowledge-installation', generation: 8, calendarId: 'native-calendar', eventId: 'native-event', occurrenceStart: '2026-10-15T09:00:00.000Z' } }], contacts: [],
  });

  state.reminders.records.push({
    id: 'reminder-display-id', revision: 4, origin: { kind: 'proactive', candidate: { id: 'candidate-id', suppressionKey: 'suppression', ruleId: 'rule-id', ruleRevision: 1,
      sourceId: 'meeting-source', sourceVersion: 'source-version', sourceKind: 'meeting', namespace: 'device', providerId: 'native-event', eligibleAt: '2026-10-15T09:00:00.000Z', reasonCode: 'meeting_soon', quote: 'Planning', quoteField: 'subject' },
      rule: { id: 'rule-id', revision: 1, version: 1, name: 'Meeting reminder' },
      source: { kind: 'meeting', sourceId: 'meeting-source', namespace: 'device', providerId: 'native-event', sourceVersion: 'source-version', availability: 'available', freshness: 'fresh',
        subject: 'Planning', startAt: '2026-10-15T09:00:00.000Z', deviceBinding: { installationId: 'private-reminder-installation', generation: 8, calendarId: 'native-calendar', nativeEventId: 'native-event', occurrenceStart: '2026-10-15T09:00:00.000Z' } },
      binding: { accountId: ids[2]!, namespace: 'google', identityKey: 'private-reminder-identity', connectionGeneration: 4 },
      deviceBinding: { installationId: 'private-reminder-installation', generation: 8, calendarId: 'native-calendar', nativeEventId: 'native-event', occurrenceStart: '2026-10-15T09:00:00.000Z' },
      capturedAt: '2026-10-14T08:00:00.000Z', expiresAt: '2026-10-15T10:00:00.000Z' },
    title: 'Prepare for planning', body: 'Review notes', dueAt: '2026-10-15T08:30:00.000Z', displayTimeZone: 'Asia/Singapore', privacyMode: 'full', status: 'approved',
    createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z', approvedRevision: 4, approvedPayloadDigest: 'private-reminder-digest', currentIntentId: 'private-intent-link',
  } as AppState['reminders']['records'][number]);
  state.reminders.intents.push({ id: 'intent-display-id', reminderId: 'reminder-display-id', reminderRevision: 4, epoch: 2, identifier: 'private-native-notification-id',
    payloadDigest: 'e'.repeat(64), payload: { title: 'Prepare', body: 'Review notes', dueAt: '2026-10-15T08:30:00.000Z', displayTimeZone: 'Asia/Singapore', privacyMode: 'full' },
    desired: 'scheduled', observed: 'pending', createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z' });

  state.deviceCalendars.installationId = 'private-device-installation';
  state.deviceCalendars.generation = 8;
  state.deviceCalendars.calendars.push({ localId: 'local-calendar-row', nativeId: 'native-calendar', title: 'Personal', fingerprint: 'private-calendar-fingerprint', observedAt: '2026-10-14T08:00:00.000Z', allowsModifications: true });
  state.deviceCalendars.events.push({ id: 'device-event-display-id', calendarId: 'local-calendar-row', nativeEventId: 'native-event', occurrenceStart: '2026-10-15T09:00:00.000Z',
    title: 'Planning', notes: 'Bring the agenda', notesTruncated: false, start: '2026-10-15T09:00:00.000Z', end: '2026-10-15T09:30:00.000Z', allDay: false, cancelled: false, observedAt: '2026-10-14T08:00:00.000Z', generation: 8 });
  state.deviceCalendars.dispatchRecords.push({
    version: 1, id: 'device-dispatch-history', proposalId: 'proposal-event', revision: 2, sourceProvenance: proposal.provenance!, sourceActionKey: 'private-device-action', duplicateKey: 'private-device-duplicate', payloadDigest: 'f'.repeat(64),
    target: { installationId: 'private-device-installation', generation: 8, selectionRevision: 3, calendarLocalId: 'local-calendar-row', nativeId: 'native-calendar', fingerprint: 'private-calendar-fingerprint', title: 'Personal', sourceLabel: 'Phone' },
    payload: { title: 'Planning', notes: 'Bring the agenda', start: '2026-10-15T09:00:00.000Z', end: '2026-10-15T09:30:00.000Z', timeZone: 'Asia/Singapore', allDay: false, attendees: [], invitePolicy: 'none', alarms: [] },
    claimAt: '2026-10-14T08:00:00.000Z', outcome: 'saved', nativeEventId: 'native-event', reconciliations: [],
  });

  state.importedBackups.push({
    id: 'archive-display-id', contentHash: '1'.repeat(64), fileHash: '2'.repeat(64), sourceFormat: 'still-backup-v4', exportedAt: '2026-10-01T00:00:00.000Z', importedAt: '2026-10-02T00:00:00.000Z',
    noteLinks: [{ sourceId: 'archived-note-source', noteId: ids[1]! }], taskLinks: [], documents: [{ id: 'archive-document-id', path: 'memory/ARCHIVED.md', content: 'Archived knowledge stays visible.', revision: 1, updatedAt: '2026-10-01T00:00:00.000Z' }],
    history: [{ id: 'archive-history-id', kind: 'imported_history', sourceId: 'archived-note-source', title: 'Old note', content: 'Preserved archive text', status: 'processed', occurredAt: '2026-10-01T00:00:00.000Z' }],
  });

  state.proactiveMailAlerts.consents.push({
    id: 'consent-display-id', ruleId: 'rule-display-id', ruleVersion: 1, ruleRevision: 2, timeZone: 'Asia/Singapore',
    activatedAt: '2026-10-14T08:00:00.000Z', accounts: [{ accountId: ids[2]!, identityKey: 'private-alert-identity', connectionGeneration: 4 }], status: 'active',
  });
  state.proactiveMailAlerts.receipts.push({
    id: 'receipt-display-id', installationId: 'private-installation-id', consentId: 'private-consent-link', ruleId: 'rule-display-id',
    ruleVersion: 1, ruleRevision: 2, timeZone: 'Asia/Singapore', consentActivatedAt: '2026-10-14T08:00:00.000Z', accountId: ids[2]!,
    identityKey: 'private-receipt-identity', connectionGeneration: 4, providerMessageId: 'private-provider-message', sourceVersion: 'private-source-version',
    receivedAt: '2026-10-14T08:01:00.000Z', desired: 'cancel', observed: 'cancelled', createdAt: '2026-10-14T08:01:00.000Z', updatedAt: '2026-10-14T08:02:00.000Z',
    cancellation: { requestedAt: '2026-10-14T08:01:00.000Z', observedAt: '2026-10-14T08:02:00.000Z', result: 'absent' },
  });

  state.assistantBatchJobs = [{
    id: 'batch-job-display-id', kind: 'note_assistance', status: 'completed', createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:02:00.000Z',
    model: 'openai/gpt-6-luna:batch', effort: 'low', requestBytes: 500, costStatus: 'reported', providerReportedCostUsd: 0.015,
    promptTokens: 100, completionTokens: 40, totalTokens: 140,
  } as NonNullable<AppState['assistantBatchJobs']>[number] & { requestBody: string; privateBinding: string }];
  Object.assign(state.assistantBatchJobs[0]!, { requestBody: 'private raw request body', privateBinding: 'private batch authority' });
  state.assistantChatConversations = [{ id: 'chat-display-id', title: 'Chat history', createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:02:00.000Z', turns: [{
    id: 'turn-display-id', noteId: ids[1]!, userText: 'User question', createdAt: '2026-10-14T08:00:00.000Z', capturedAt: '2026-10-14T08:00:00.000Z',
    messageOrigin: 'saved_transcript', operation: 'chat_refinement', reasoningEffort: 'medium', parentTurnId: 'parent-turn-id',
    recoveryParentTurnId: 'recovery-parent-id', memorySuggestionIds: ['suggestion-display-id'],
    reply: { summary: 'Summary', answer: 'Answer', clarifications: [], completedAt: '2026-10-14T08:02:00.000Z' },
  }] }];

  // Unknown runtime extensions and private controller internals are deliberately not part of the DTO contract.
  Object.assign(state.accounts[0]!, { privateExtension: 'account-extension-secret' });
  return state;
}

describe('workspace snapshot DTO', () => {
  it('projects a frozen independent public snapshot while retaining user content, provenance, and actual accounting', () => {
    const state = richState();
    const getSnapshot = () => state;
    const dto = createWorkspaceSnapshotDTO({ getSnapshot }, { workspaceId, privacyEpoch: 2, revision: 19 });

    expect(dto).toMatchObject({ schemaVersion: 1, workspaceId, privacyEpoch: 2, revision: 19 });
    expect(dto.state.accounts[0]).toMatchObject({ email: 'user@example.test', credentialConfigured: true });
    expect(dto.state.accounts[1]?.credentialConfigured).toBe(false);
    expect(dto.state.notes[0]?.transcript).toContain('The literal word tokenRef');
    expect(dto.state.documents[0]?.content).toContain('tokenRef');
    expect(dto.state.proposals[0]).toMatchObject({ id: 'proposal-visible-id', status: 'approved', revision: 5, approvedRevision: 5, body: 'Approved reply body' });
    expect(dto.state.proposals[0]?.provenance).toMatchObject({ kind: 'mail_reply', source: { providerMessageId: 'provider-message-display-id' } });
    expect(dto.state.usage.unknownCharges).toBe(2);
    expect(dto.state.usage).not.toHaveProperty('estimatedCostUsd');
    expect(dto.state.usage).not.toHaveProperty('reservedUsd');
    expect(dto.state.usage).not.toHaveProperty('priceKnown');
    for (const setting of ['maxOutputTokens', 'maxContextTokens', 'maxRequestBytes', 'monthlyBudgetUsd', 'maxCallsPerDay', 'inputUsdPerMillionTokens', 'outputUsdPerMillionTokens', 'speechUsdPerMinute', 'openAiEndpoint', 'openAiDeployment', 'model']) {
      expect(dto.state.settings).not.toHaveProperty(setting);
    }
    expect(dto.state.assistantBatchJobs[0]).toMatchObject({ id: 'batch-job-display-id', providerReportedCostUsd: 0.015, totalTokens: 140 });
    expect(dto.state.assistantChatConversations[0]?.turns[0]).toMatchObject({ userText: 'User question', recoveryParentTurnId: 'recovery-parent-id' });
    expect(dto.state.proactiveMailAlerts.consents[0]).toMatchObject({ id: 'consent-display-id', accountIds: [ids[2]] });
    expect(dto.state.proactiveMailAlerts.receipts[0]).toMatchObject({ id: 'receipt-display-id', observed: 'cancelled', cancellation: { result: 'absent' } });
    expect(dto.state.calendars[0]).toMatchObject({ name: 'Work calendar', providerId: 'provider-calendar-id' });
    expect(dto.state.calendarEvents[0]).toMatchObject({ subject: 'Planning', start: '2026-10-15T09:00:00.000Z' });
    expect(dto.state.mailbox[0]).toMatchObject({ subject: 'Mailbox row', snippet: 'Visible summary' });
    expect(dto.state.dispatchRecords[0]).toMatchObject({ id: 'dispatch-history-id', body: 'Immutable dispatch body', outcome: 'accepted', reconciliations: [{ note: 'Provider confirmed' }] });
    expect(dto.state.knowledge.people[0]?.facts[0]?.statement).toBe('Prefers concise updates.');
    expect(dto.state.knowledge.people[0]?.sourceLinks[0]).toMatchObject({ label: 'Planning meeting', reference: { kind: 'historical', originalKind: 'device_calendar_event' } });
    expect(dto.state.reminders.records[0]).toMatchObject({ id: 'reminder-display-id', status: 'approved', title: 'Prepare for planning' });
    expect(dto.state.reminders.intents[0]).toMatchObject({ id: 'intent-display-id', observed: 'pending' });
    expect(dto.state.deviceCalendars.events[0]).toMatchObject({ title: 'Planning', notes: 'Bring the agenda' });
    expect(dto.state.deviceCalendars.dispatchHistory[0]).toMatchObject({ id: 'device-dispatch-history', outcome: 'saved', body: 'Bring the agenda' });
    expect(dto.state.importedBackups[0]?.history[0]?.content).toBe('Preserved archive text');
    expect(dto.state.importedBackups[0]?.documents[0]?.content).toBe('Archived knowledge stays visible.');

    const serialized = JSON.stringify(dto);
    for (const secret of [
      'credential-secret-do-not-send', 'cleanup-secret-do-not-send', 'file:///private/local/audio-secret.m4a',
      'private-processing-fingerprint', 'private-speech-lease-id', 'private-prepared-lease', 'private-cleanup-lease',
      'private-installation-id', 'private-alert-identity', 'private-receipt-identity', 'private-provider-message',
      'private-source-version', 'private raw request body', 'private batch authority', 'account-extension-secret',
      'private-reminder-installation', 'private-reminder-identity', 'private-device-installation', 'private-device-action',
      'private-device-duplicate', 'private-calendar-fingerprint', 'private-native-notification-id', 'private-reminder-digest',
      'private-knowledge-installation', 'private-intent-link',
    ]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('The literal word tokenRef belongs in this user-authored text.');
    expect(serialized).toContain('Do not strip prose merely because it mentions tokenRef.');

    expect(dto.state.transcription.attempts[0]).toMatchObject({ id: 'speech-attempt-display-id', noteId: ids[1], sourceRevision: 3, durationMilliseconds: 42000 });
    expect(dto.state.transcription.attempts[0]).toMatchObject({ costStatus: 'unknown' });
    expect(dto.state.transcription.attempts[0]).not.toHaveProperty('billedEstimateSeconds');
    expect(dto.state.transcription.attempts[0]).not.toHaveProperty('rateEstimated');
    expect(dto.state.transcription.attempts[1]).toMatchObject({ id: 'openrouter-speech-attempt', costStatus: 'reported', actualUsage: { costUsd: 0.006, seconds: 42 } });
    expect(dto.state.transcription.cleanup).toMatchObject({ pendingCount: 2, pendingAttemptIds: ['speech-attempt-display-id', 'speech-request-pending-id'] });
    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(dto.state.notes[0])).toBe(true);
    expect(Reflect.set(dto.state.notes[0]!, 'transcript', 'changed')).toBe(false);
    state.notes[0]!.transcript = 'updated after projection';
    expect(dto.state.notes[0]?.transcript).toContain('The literal word tokenRef');
  });

  it('exposes audio only through an opaque trusted mapping and validates identity metadata', () => {
    const state = richState();
    const controller = { getSnapshot: () => state };
    const absent = createWorkspaceSnapshotDTO(controller, { workspaceId, privacyEpoch: 0, revision: 0 });
    expect(absent.state.notes[0]?.audio).toMatchObject({ available: false, format: 'm4a', mimeType: 'audio/mp4', byteLength: 1200 });
    expect(JSON.stringify(absent.state.notes[0])).not.toContain('file:///');

    const mapped = createWorkspaceSnapshotDTO(controller, { workspaceId, privacyEpoch: 0, revision: 0 }, {
      resolveMediaId: () => 'b1a6df46-90c0-4af3-b08d-90e072a5cb16',
    });
    expect(mapped.state.notes[0]?.audio).toMatchObject({ available: true, mediaId: 'b1a6df46-90c0-4af3-b08d-90e072a5cb16' });
    const invalidMapping = createWorkspaceSnapshotDTO(controller, { workspaceId, privacyEpoch: 0, revision: 0 }, { resolveMediaId: () => 'file:///not-an-id' });
    expect(invalidMapping.state.notes[0]?.audio).toMatchObject({ available: false });
    expect(JSON.stringify(invalidMapping)).not.toContain('file:///');

    expect(() => createWorkspaceSnapshotDTO(controller, { workspaceId: 'not-a-uuid', privacyEpoch: 0, revision: 0 })).toThrow('workspace_snapshot_identity_invalid');
    expect(() => createWorkspaceSnapshotDTO(controller, { workspaceId, privacyEpoch: -1, revision: 0 })).toThrow('workspace_snapshot_identity_invalid');
    expect(() => createWorkspaceSnapshotDTO(controller, { workspaceId, privacyEpoch: 0, revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow('workspace_snapshot_identity_invalid');
  });
});
