import { describe, expect, it } from 'vitest';
import { createWorkspaceHttpApi } from '../src/cloud/workspaceHttp.node';
import type { OwnedWorkspaceRuntime } from '../src/cloud/ownedWorkspaceRuntime.node';
import type { WorkspaceHttpAdmission } from '../server/src/workspaceHttp';
import {
  cloudDispatchReviewPath,
  cloudMailReadPath,
  cloudProposalReviewPath,
  cloudReplyBatchReviewPath,
  parseCloudDispatchReview,
  parseCloudMailReplySource,
  parseCloudMailReplyText,
  parseCloudProposalReview,
  parseCloudReplyBatchReview,
} from '../src/web/cloudMailClient';

const owner = { expectedRevision: 41, expectedPrivacyEpoch: 7 } as const;
const expected = { workspaceId: '10000000-0000-4000-8000-000000000001', privacyEpoch: 7, revision: 41 } as const;
const source = {
  accountId: 'acct-東京-🧭-Δ', connectionGeneration: 5, localMessageId: 'message+東京/1', providerMessageId: 'provider-message-1', idFormat: 'graph-immutable',
  internetMessageId: '<message@example.test>', subject: 'A saved message', from: 'sender@example.test', senderEmail: 'sender@example.test',
  replyTo: ['reply@example.test'], to: ['user@example.test'], cc: [], snippet: 'Saved excerpt', observedAt: '2026-10-15T10:00:00.000Z', sourceDigest: 'a'.repeat(64),
} as const;

describe('cloud saved-mail read paths', () => {
  it('round-trips real workspace HTTP projections through the browser decoders', async () => {
    const producerSource = { version: 1, accountId: source.accountId, accountEmail: 'me@example.test', identity: { providerNamespace: 'google', subject: 'private' },
      connectionGeneration: source.connectionGeneration, localMessageId: source.localMessageId, providerMessageId: source.providerMessageId, idFormat: source.idFormat,
      internetMessageId: source.internetMessageId, subject: source.subject, from: source.from, senderEmail: source.senderEmail, replyTo: [...source.replyTo],
      to: [...source.to], cc: [...source.cc], replyMetadataComplete: true, observedAt: source.observedAt, sourceDigest: source.sourceDigest };
    let proposalValue: unknown = { id: 'proposal-1', kind: 'email', title: 'Reply', body: 'Saved body', status: 'draft', revision: 2, recipients: ['sender@example.test'],
      accountId: source.accountId, email: { operation: 'draft', to: ['sender@example.test'], cc: [], bcc: [], subject: 'Saved subject', text: 'Saved body', attachments: [] },
      provenance: { version: 2, kind: 'mail_reply', sourceDigest: source.sourceDigest, source: producerSource, expiresAt: '2026-10-16T10:00:00.000Z' } };
    const dispatchValue = { recordVersion: 'c'.repeat(64), record: { id: 'dispatch-1', proposalId: 'proposal-1', accountId: source.accountId,
      account: { provider: 'google', displayName: 'Work', email: 'me@example.test', identity: { providerNamespace: 'google', subject: 'private' } }, operation: 'send',
      title: 'Saved send', body: 'Frozen content', payload: { kind: 'email', email: { to: ['sender@example.test'], cc: [], bcc: [], subject: 'Saved subject', text: 'Frozen content', attachments: [] } },
      outcome: 'unknown', dispatchStartedAt: '2026-10-15T10:00:00.000Z', reconciliations: [], sourceProvenance: {} } };
    const batchPlan = { plan: { planId: 'plan-1', jobId: 'job-1', messageId: source.localMessageId, mode: 'reply', operation: 'draft', subject: 'Reply',
      to: ['sender@example.test'], cc: [], text: 'Prepared content', expiresAt: '2026-10-15T11:00:00.000Z' }, accountId: source.accountId,
      connectionGeneration: source.connectionGeneration };
    const runtime = {
      async readMailReplySource() { return { workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision, value: {
        source: { status: 'current', source: producerSource, defaults: { reply: { to: ['sender@example.test'], cc: [] }, reply_all: { to: ['sender@example.test', 'team@example.test'], cc: [] } } },
        bodyCache: { status: 'current', snapshot: { textDigest: 'b'.repeat(64), bytes: 11, completeness: 'complete_text', representation: 'plain', checkedAt: '2026-10-15T10:00:00.000Z' } },
      } }; },
      async readMailReplyText() { return { workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision, value: { status: 'current', snapshot: {
        messageId: source.localMessageId, accountId: source.accountId, connectionGeneration: source.connectionGeneration, sourceDigest: source.sourceDigest, checkedAt: source.observedAt,
        text: 'Saved context', textDigest: 'b'.repeat(64), bytes: 13, extractionVersion: 'mail-text-v2', representation: 'plain', completeness: 'complete_text', omissionReasons: [],
      } } }; },
      async readProposalForReview() { return { workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision, value: proposalValue }; },
      async readDispatchForReview() { return { workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision, value: dispatchValue }; },
      async readMailReplyBatchReview() { return { workspaceId: expected.workspaceId, privacyEpoch: expected.privacyEpoch, revision: expected.revision, value: batchPlan }; },
    } as unknown as OwnedWorkspaceRuntime;
    const api = createWorkspaceHttpApi(runtime);
    const admission = { assertCurrent() {} } as WorkspaceHttpAdmission;
    const producedSource = await api.readMailReplySource!(admission, { messageId: source.localMessageId, expectedRevision: expected.revision, expectedPrivacyEpoch: expected.privacyEpoch });
    const parsedSource = parseCloudMailReplySource(JSON.parse(JSON.stringify(producedSource)), expected, source.localMessageId);
    const producedText = await api.readMailReplyText!(admission, { messageId: source.localMessageId, expectedRevision: expected.revision, expectedPrivacyEpoch: expected.privacyEpoch });
    expect(parseCloudMailReplyText(JSON.parse(JSON.stringify(producedText)), expected, source.localMessageId, parsedSource.source!).snapshot?.text).toBe('Saved context');
    const producedProposal = await api.readProposalReview!(admission, { proposalId: 'proposal-1', expectedRevision: expected.revision, expectedPrivacyEpoch: expected.privacyEpoch });
    expect(parseCloudProposalReview(JSON.parse(JSON.stringify(producedProposal)), expected, 'proposal-1').proposal).toMatchObject({
      editPolicy: 'source_reply_fields', sourceDigest: source.sourceDigest,
    });
    proposalValue = { ...(proposalValue as Record<string, unknown>), provenance: { version: 2, kind: 'mail_reply', sourceDigest: source.sourceDigest,
      source: producerSource, expiresAt: '2026-10-16T10:00:00.000Z', batchJobId: '11111111-1111-4111-8111-111111111111' } };
    const batchProposal = await api.readProposalReview!(admission, { proposalId: 'proposal-1', expectedRevision: expected.revision, expectedPrivacyEpoch: expected.privacyEpoch });
    expect(parseCloudProposalReview(JSON.parse(JSON.stringify(batchProposal)), expected, 'proposal-1').proposal?.editPolicy).toBe('read_only');
    proposalValue = { ...(proposalValue as Record<string, unknown>), status: 'unknown' };
    const terminalProposal = await api.readProposalReview!(admission, { proposalId: 'proposal-1', expectedRevision: expected.revision, expectedPrivacyEpoch: expected.privacyEpoch });
    expect(parseCloudProposalReview(JSON.parse(JSON.stringify(terminalProposal)), expected, 'proposal-1').proposal?.editPolicy).toBe('read_only');
    const producedDispatch = await api.readDispatchReview!(admission, { recordId: 'dispatch-1', expectedRevision: expected.revision, expectedPrivacyEpoch: expected.privacyEpoch });
    expect(parseCloudDispatchReview(JSON.parse(JSON.stringify(producedDispatch)), expected, 'dispatch-1').record?.payload.kind).toBe('email');
    const producedBatch = await api.readMailReplyBatchReview!(admission, { planId: 'plan-1', jobId: 'job-1', accountId: source.accountId,
      expectedConnectionGeneration: source.connectionGeneration, expectedRevision: expected.revision, expectedPrivacyEpoch: expected.privacyEpoch });
    expect(parseCloudReplyBatchReview(JSON.parse(JSON.stringify(producedBatch)), expected,
      { planId: 'plan-1', jobId: 'job-1', accountId: source.accountId, expectedConnectionGeneration: source.connectionGeneration }).plan?.accountId).toBe(source.accountId);
  });

  it('encodes opaque Unicode identifiers once and binds reads to the displayed workspace revision and epoch', () => {
    const messageId = 'msg+one & 東京/📨';
    const path = cloudMailReadPath('source', messageId, owner);
    const parsed = new URL(path, 'https://workspace.test');

    expect(parsed.pathname).toBe('/api/workspace/mail/source');
    expect(parsed.searchParams.getAll('messageId')).toEqual([messageId]);
    expect(parsed.searchParams.getAll('expectedRevision')).toEqual(['41']);
    expect(parsed.searchParams.getAll('expectedPrivacyEpoch')).toEqual(['7']);
    expect(parsed.search).not.toContain('%252B');
  });

  it('uses distinct saved metadata and saved-text endpoints', () => {
    expect(new URL(cloudMailReadPath('source', 'message-1', owner), 'https://workspace.test').pathname)
      .toBe('/api/workspace/mail/source');
    expect(new URL(cloudMailReadPath('source-text', 'message-1', owner), 'https://workspace.test').pathname)
      .toBe('/api/workspace/mail/source-text');
  });

  it('binds proposal, dispatch, and batch-plan reads to exact requested objects and account generation', () => {
    const proposal = new URL(cloudProposalReviewPath('proposal-α', owner), 'https://workspace.test');
    expect(proposal.searchParams.getAll('proposalId')).toEqual(['proposal-α']);
    expect(proposal.searchParams.getAll('expectedRevision')).toEqual(['41']);

    const dispatch = new URL(cloudDispatchReviewPath('dispatch/東京', owner), 'https://workspace.test');
    expect(dispatch.searchParams.getAll('recordId')).toEqual(['dispatch/東京']);

    const batch = new URL(cloudReplyBatchReviewPath({
      planId: 'plan-1', jobId: 'job-2', accountId: 'acct-東京-🧭-Δ', expectedConnectionGeneration: 9,
    }, owner), 'https://workspace.test');
    expect(batch.pathname).toBe('/api/workspace/mail/reply-batch/review');
    expect(batch.searchParams.getAll('planId')).toEqual(['plan-1']);
    expect(batch.searchParams.getAll('jobId')).toEqual(['job-2']);
    expect(batch.searchParams.getAll('accountId')).toEqual(['acct-東京-🧭-Δ']);
    expect(batch.searchParams.getAll('expectedConnectionGeneration')).toEqual(['9']);
    expect(batch.searchParams.getAll('expectedPrivacyEpoch')).toEqual(['7']);
  });

  it('rejects malformed identifiers and owner generations before a request can be built', () => {
    expect(() => cloudMailReadPath('source', 'bad\nmessage', owner)).toThrow('message_id_invalid');
    expect(() => cloudMailReadPath('source-text', 'message-1', { ...owner, expectedRevision: -1 })).toThrow('mail_read_owner_invalid');
    expect(() => cloudReplyBatchReviewPath({ planId: 'p', jobId: 'j', accountId: 'a', expectedConnectionGeneration: 1.5 }, owner))
      .toThrow('connection_generation_invalid');
  });

  it('accepts producer-compatible saved source/text including actual omission strings and Unicode IDs', () => {
    const sourceDto = parseCloudMailReplySource({ schemaVersion: 1, ...expected, status: 'current', source,
      defaults: { reply: { to: ['sender@example.test'], cc: [] }, reply_all: { to: ['sender@example.test', 'team@example.test'], cc: [] } },
      bodyCache: { status: 'current', textDigest: 'b'.repeat(64), bytes: 4, completeness: 'excerpt', representation: 'plain', checkedAt: '2026-10-15T10:01:00.000Z' } },
    expected, source.localMessageId);
    const text = '🙂'.repeat(50_000);
    const textDto = parseCloudMailReplyText({ schemaVersion: 1, ...expected, status: 'current', snapshot: {
      messageId: source.localMessageId, accountId: source.accountId, connectionGeneration: source.connectionGeneration, sourceDigest: source.sourceDigest,
      checkedAt: '2026-10-15T10:01:00.000Z', text, textDigest: 'b'.repeat(64), bytes: new TextEncoder().encode(text).byteLength,
      extractionVersion: 'mail-text-v2', representation: 'converted_html', completeness: 'excerpt',
      omissionReasons: ['mime_depth_limit', 'mime_part_limit', 'additional_text_part_omitted'],
    } }, expected, source.localMessageId, sourceDto.source!);
    expect(textDto.snapshot?.text).toBe(text);
    expect(textDto.snapshot?.omissionReasons).toEqual(['mime_depth_limit', 'mime_part_limit', 'additional_text_part_omitted']);
  });

  it('accepts producer-sized proposal and frozen dispatch content without imposing smaller text caps', () => {
    const longText = 'm'.repeat(100_000);
    const proposal = parseCloudProposalReview({ schemaVersion: 1, ...expected, proposal: {
      editPolicy: 'email_fields', id: 'proposal-1', kind: 'email', title: 'Reply', body: longText, status: 'draft', revision: 2, recipients: ['person@example.test'], accountId: 'acct-1',
      email: { operation: 'draft', to: ['person@example.test'], cc: [], bcc: [], subject: 'Saved reply', text: longText, attachments: [] },
    } }, expected, 'proposal-1');
    expect(proposal.proposal?.email?.text).toHaveLength(100_000);

    const dispatch = parseCloudDispatchReview({ schemaVersion: 1, ...expected, recordVersion: 'c'.repeat(64), record: {
      id: 'dispatch-1', proposalId: 'proposal-1', accountId: 'acct-1', account: { provider: 'google', displayName: 'Account', email: 'person@example.test' },
      operation: 'send', title: 'Reply', body: longText,
      payload: { kind: 'email', to: ['person@example.test'], cc: [], bcc: [], subject: 'Saved reply', text: longText, attachments: [] },
      outcome: 'unknown', dispatchStartedAt: '2026-10-15T10:00:00.000Z', reconciliations: [],
    } }, expected, 'dispatch-1');
    expect(dispatch.record?.payload.kind === 'email' ? dispatch.record.payload.text : '').toHaveLength(100_000);
  });

  it('accepts a bound reply Batch review with real omission codes and full producer result text', () => {
    const requested = { planId: 'plan-1', jobId: 'job-1', messageId: source.localMessageId, accountId: source.accountId, expectedConnectionGeneration: source.connectionGeneration };
    const parsed = parseCloudReplyBatchReview({ schemaVersion: 1, ...expected, plan: {
      planId: requested.planId, jobId: requested.jobId, messageId: requested.messageId, accountId: requested.accountId,
      connectionGeneration: requested.expectedConnectionGeneration, mode: 'reply_all', operation: 'draft', subject: 'Generated reply', to: ['sender@example.test'], cc: [], text: 'r'.repeat(100_000),
      expiresAt: '2026-10-15T11:00:00.000Z', contextMessages: [{ selectionId: 'selection-1', subject: 'Older message', representation: 'snippet',
        completeness: 'excerpt', bytes: 14, omissionReasons: ['mime_depth_limit', 'additional_text_part_omitted'] }],
    } }, expected, { planId: requested.planId, jobId: requested.jobId, accountId: requested.accountId, expectedConnectionGeneration: requested.expectedConnectionGeneration });
    expect(parsed.plan?.text).toHaveLength(100_000);
    expect(parsed.plan?.contextMessages?.[0]?.omissionReasons).toEqual(['mime_depth_limit', 'additional_text_part_omitted']);
  });

  it('rejects malformed UTF-16 IDs, non-string hashes, and mixed dispatch payload variants', () => {
    expect(() => cloudMailReadPath('source', 'bad\ud800id', owner)).toThrow('message_id_invalid');
    expect(() => parseCloudMailReplySource({ schemaVersion: 1, ...expected, status: 'current', source: { ...source, sourceDigest: ['a'.repeat(64)] },
      defaults: { reply: { to: [], cc: [] }, reply_all: { to: [], cc: [] } }, bodyCache: { status: 'missing' } }, expected, source.localMessageId)).toThrow();
    expect(() => parseCloudDispatchReview({ schemaVersion: 1, ...expected, recordVersion: 'c'.repeat(64), record: {
      id: 'dispatch-1', proposalId: 'proposal-1', accountId: 'acct-1', account: { provider: 'google', displayName: 'Account', email: 'person@example.test' },
      operation: 'send', title: 'Reply', body: '', payload: { kind: 'email', to: [], cc: [], bcc: [], subject: '', text: '', attachments: [], start: 'bad' },
      outcome: 'unknown', dispatchStartedAt: '2026-10-15T10:00:00.000Z', reconciliations: [],
    } }, expected, 'dispatch-1')).toThrow();
  });

  it('rejects array or object values in every closed enum field', () => {
    const sourceRead = { schemaVersion: 1, ...expected, status: 'current', source,
      defaults: { reply: { to: [], cc: [] }, reply_all: { to: [], cc: [] } }, bodyCache: { status: 'current', completeness: 'excerpt', representation: 'plain' } };
    const proposalRead = { schemaVersion: 1, ...expected, proposal: { editPolicy: 'email_fields', id: 'proposal-1', kind: 'email', title: 'Reply', body: '', status: 'draft', revision: 2,
      recipients: [], email: { operation: 'draft', to: [], cc: [], bcc: [], subject: '', text: '', attachments: [] } } };
    const dispatchRead = { schemaVersion: 1, ...expected, recordVersion: 'c'.repeat(64), record: { id: 'dispatch-1', proposalId: 'proposal-1', accountId: 'acct-1',
      account: { provider: 'google', displayName: 'Account', email: 'person@example.test' }, operation: 'send', title: 'Reply', body: '',
      payload: { kind: 'email', to: [], cc: [], bcc: [], subject: '', text: '', attachments: [] }, outcome: 'unknown', dispatchStartedAt: '2026-10-15T10:00:00.000Z',
      reconciliations: [{ disposition: 'not_found', at: '2026-10-15T10:00:00.000Z', note: 'checked' }] } };
    const requested = { planId: 'plan-1', jobId: 'job-1', messageId: source.localMessageId, accountId: source.accountId, expectedConnectionGeneration: source.connectionGeneration };
    const batchRead = { schemaVersion: 1, ...expected, plan: { planId: requested.planId, jobId: requested.jobId, messageId: requested.messageId, accountId: requested.accountId,
      connectionGeneration: requested.expectedConnectionGeneration, mode: 'reply', operation: 'draft', subject: '', to: [], cc: [], text: '', expiresAt: '2026-10-15T11:00:00.000Z',
      contextMessages: [{ selectionId: 'selection-1', subject: '', representation: 'plain', completeness: 'excerpt', bytes: 0, omissionReasons: [] }] } };
    const cases: readonly [string, () => unknown][] = [
      ['cache representation', () => parseCloudMailReplySource({ ...sourceRead, bodyCache: { status: 'current', representation: ['plain'] } }, expected, source.localMessageId)],
      ['cache completeness', () => parseCloudMailReplySource({ ...sourceRead, bodyCache: { status: 'current', completeness: { kind: 'excerpt' } } }, expected, source.localMessageId)],
      ['proposal kind', () => parseCloudProposalReview({ ...proposalRead, proposal: { ...proposalRead.proposal, kind: ['email'] } }, expected, 'proposal-1')],
      ['proposal edit policy', () => parseCloudProposalReview({ ...proposalRead, proposal: { ...proposalRead.proposal, editPolicy: ['email_fields'] } }, expected, 'proposal-1')],
      ['proposal status', () => parseCloudProposalReview({ ...proposalRead, proposal: { ...proposalRead.proposal, status: { state: 'draft' } } }, expected, 'proposal-1')],
      ['proposal operation', () => parseCloudProposalReview({ ...proposalRead, proposal: { ...proposalRead.proposal, email: { ...proposalRead.proposal.email, operation: ['draft'] } } }, expected, 'proposal-1')],
      ['dispatch provider', () => parseCloudDispatchReview({ ...dispatchRead, record: { ...dispatchRead.record, account: { ...dispatchRead.record.account, provider: ['google'] } } }, expected, 'dispatch-1')],
      ['dispatch outcome', () => parseCloudDispatchReview({ ...dispatchRead, record: { ...dispatchRead.record, outcome: { value: 'unknown' } } }, expected, 'dispatch-1')],
      ['reconciliation disposition', () => parseCloudDispatchReview({ ...dispatchRead, record: { ...dispatchRead.record, reconciliations: [{ disposition: ['not_found'], at: '2026-10-15T10:00:00.000Z', note: '' }] } }, expected, 'dispatch-1')],
      ['batch representation', () => parseCloudReplyBatchReview({ ...batchRead, plan: { ...batchRead.plan, contextMessages: [{ ...batchRead.plan.contextMessages[0], representation: ['plain'] }] } }, expected, requested)],
      ['batch completeness', () => parseCloudReplyBatchReview({ ...batchRead, plan: { ...batchRead.plan, contextMessages: [{ ...batchRead.plan.contextMessages[0], completeness: { value: 'excerpt' } }] } }, expected, requested)],
    ];
    for (const [label, parse] of cases) { expect(parse, label).toThrow(); }
  });
});
