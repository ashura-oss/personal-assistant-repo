import { describe, expect, it } from 'vitest';
import { assistantResponseSchemaV2 } from '../src/assistant';
import { validateChatLedger } from '../src/chat/ledger';
import {
  IMPORTED_CHAT_HISTORY_ORIGIN,
  createPortableChatHistory,
  materializeInertChatHistory,
  serializePortableChatHistory,
  validatePortableChatHistory,
} from '../src/chat/portable';
import { OPENROUTER_BATCH_BODY_MODEL } from '../src/services/openRouter';
import { validateOpenRouterBatchLedger, type OpenRouterBatchJob } from '../src/services/openRouterBatchJobs';

const conversationId = '10000000-0000-4000-8000-000000000001';
const turnId = '20000000-0000-4000-8000-000000000001';
const noteId = '30000000-0000-4000-8000-000000000001';
const jobId = '40000000-0000-4000-8000-000000000001';
const at = '2026-10-13T10:00:00.000Z';

function sourceLedger(answer = 'A useful local reply.') {
  return validateChatLedger({ version: 1, conversations: [{ id: conversationId, title: 'Planning', createdAt: at, updatedAt: at,
    turns: [{ id: turnId, noteId, noteRevision: 1, jobId, userText: 'What should I bring?', createdAt: at, captureTimeZone: 'Asia/Singapore',
      reply: { summary: 'A summary.', answer, clarifications: [], completedAt: at, requestSha256: 'a'.repeat(64), requestProfileVersion: 2 }, replySha256: 'b'.repeat(64) }] }] });
}

function batchJob(overrides: Partial<OpenRouterBatchJob> = {}) {
  const requestBody = JSON.stringify({ model: OPENROUTER_BATCH_BODY_MODEL,
    messages: [{ role: 'system', content: 'Fixed system prompt.' }, { role: 'user', content: 'Fixed user source.' }],
    reasoning: { effort: 'low', exclude: true },
    response_format: { type: 'json_schema', json_schema: { name: 'note_assistance', strict: true, schema: assistantResponseSchemaV2 } }, stream: false });
  const requestBytes = new TextEncoder().encode(requestBody).byteLength;
  return {
    id: jobId, customId: jobId, kind: 'note_assistance', status: 'completed', createdAt: at, updatedAt: at,
    model: 'openai/gpt-6-luna:batch', effort: 'low', requestSha256: 'a'.repeat(64), batchId: 'batch-safe-opaque', unknownCharge: false,
    accounting: { providerReportedCostUsd: 0, byok: false, promptTokens: 0 },
    noteId, noteRevision: 1, intent: 'answer', question: 'Respond to the current user message.', capturedAt: at, captureTimeZone: 'Asia/Singapore',
    settingsFingerprint: 'c'.repeat(64), sourceFingerprint: 'd'.repeat(64), requestProfileVersion: 2, requestBytes, omittedSourceCount: 0,
    requestBody, sourceVersions: { transcript: `1:${'e'.repeat(64)}` }, appliedNoteRevision: 1,
    chatBinding: { conversationId, turnId, context: [], omittedTurnCount: 0 }, ...overrides,
  } satisfies OpenRouterBatchJob;
}

function batchLedger(overrides: Partial<OpenRouterBatchJob> = {}) {
  return validateOpenRouterBatchLedger({ version: 1, jobs: [{ ...batchJob(), ...overrides }] });
}

describe('inert portable Chat history', () => {
  it('exports only content and actual accounting, retaining reported zero distinctly from missing cost', async () => {
    const exported = await createPortableChatHistory(sourceLedger(), batchLedger(), async (_reply, digest) => digest === 'b'.repeat(64));
    expect(exported).toEqual({ version: 1, conversations: [{ title: 'Planning', createdAt: at, updatedAt: at, turns: [{
      userText: 'What should I bring?', createdAt: at, capturedAt: at, captureTimeZone: 'Asia/Singapore',
      reply: { summary: 'A summary.', answer: 'A useful local reply.', clarifications: [], completedAt: at },
      accounting: { costUsd: 0, isByok: false, promptTokens: 0 },
    }] }] });
    const serialized = serializePortableChatHistory(exported);
    expect(serialized).not.toContain(conversationId);
    expect(serialized).not.toContain(turnId);
    expect(serialized).not.toContain(noteId);
    expect(serialized).not.toContain(jobId);
    expect(serialized).not.toContain('batch-safe-opaque');
    expect(serialized).not.toContain('requestSha256');
    const absentCost = validatePortableChatHistory({ version: 1, conversations: [{ title: 'No receipt', createdAt: at, updatedAt: at, turns: [{
      userText: 'A message with no cost receipt.', createdAt: at, capturedAt: at, captureTimeZone: 'UTC', accounting: { promptTokens: 1 },
    }] }] });
    expect(absentCost.conversations[0]?.turns[0]?.accounting).toEqual({ promptTokens: 1 });
    expect(absentCost.conversations[0]?.turns[0]?.accounting).not.toHaveProperty('costUsd');
  });

  it('requires matching private links and reply digest verification before export', async () => {
    await expect(createPortableChatHistory(sourceLedger(), batchLedger(), async () => false)).rejects.toThrow(/digest/i);
    const wrongBinding = batchLedger({ chatBinding: { conversationId, turnId: '20000000-0000-4000-8000-000000000002', context: [], omittedTurnCount: 0 } });
    await expect(createPortableChatHistory(sourceLedger(), wrongBinding, async () => true)).rejects.toThrow(/linked/i);
    await expect(createPortableChatHistory(sourceLedger(), batchLedger(), undefined as never)).rejects.toThrow(/verification/i);
  });

  it('materializes inert history with fresh local IDs and no runnable note or job linkage', async () => {
    const payload = await createPortableChatHistory(sourceLedger(), batchLedger(), async () => true);
    const ids = [
      '50000000-0000-4000-8000-000000000001',
      '60000000-0000-4000-8000-000000000001',
    ];
    const imported = materializeInertChatHistory(payload, () => ids.shift()!);
    expect(imported[0]).toMatchObject({ id: '50000000-0000-4000-8000-000000000001', origin: IMPORTED_CHAT_HISTORY_ORIGIN,
      title: 'Planning', turns: [{ id: '60000000-0000-4000-8000-000000000001', origin: IMPORTED_CHAT_HISTORY_ORIGIN,
        userText: 'What should I bring?', reply: { answer: 'A useful local reply.' }, accounting: { costUsd: 0 } }] });
    const flattened = JSON.stringify(imported);
    expect(flattened).not.toContain(conversationId);
    expect(flattened).not.toContain(turnId);
    expect(flattened).not.toContain(noteId);
    expect(flattened).not.toContain(jobId);
    expect(flattened).not.toContain('jobId');
    expect(flattened).not.toContain('noteId');
    expect(() => materializeInertChatHistory(payload, () => '50000000-0000-4000-8000-000000000001')).toThrow(/collided/i);
    expect(() => materializeInertChatHistory(payload, () => '50000000-0000-4000-8000-000000000001', new Set(['50000000-0000-4000-8000-000000000001']))).toThrow(/collided/i);
  });

  it('strictly rejects authority fields, malformed accounting, invalid Unicode and invalid time zones', () => {
    const minimal = { version: 1, conversations: [{ title: 'Plain', createdAt: at, updatedAt: at, turns: [{ userText: 'A message.', capturedAt: at, captureTimeZone: 'UTC' }] }] };
    expect(() => validatePortableChatHistory({ ...minimal, providerBatchId: 'provider-id' })).toThrow(/unknown|missing/i);
    expect(() => validatePortableChatHistory({ version: 1, conversations: [{ title: 'Plain', createdAt: at, updatedAt: at, turns: [{
      userText: 'A message.', createdAt: at, capturedAt: at, captureTimeZone: 'UTC', accounting: { costUsd: -0.01 },
    }] }] })).toThrow(/cost/i);
    expect(() => validatePortableChatHistory({ version: 1, conversations: [{ title: 'Plain', createdAt: at, updatedAt: at, turns: [{
      userText: 'A message.', createdAt: at, capturedAt: at, captureTimeZone: 'Not/AZone',
    }] }] })).toThrow(/time zone/i);
    expect(() => validatePortableChatHistory({ version: 1, conversations: [{ title: 'Plain', createdAt: at, updatedAt: at, turns: [{
      userText: '\ud800', createdAt: at, capturedAt: at, captureTimeZone: 'UTC',
    }] }] })).toThrow(/message/i);
  });

  it('keeps long valid Unicode text intact until the physical byte limit is reached', () => {
    const userText = '🧭'.repeat(50_000);
    const payload = validatePortableChatHistory({ version: 1, conversations: [{ title: 'Long note', createdAt: at, updatedAt: at, turns: [{
      userText, createdAt: at, capturedAt: at, captureTimeZone: 'UTC',
    }] }] });
    expect(payload.conversations[0]?.turns[0]?.userText).toBe(userText);
    expect(() => serializePortableChatHistory(payload, 1024)).toThrow(/size limit/i);
  });

  it('rejects custom array prototypes and accessor indices without executing getters', () => {
    const payload = { version: 1, conversations: [{ title: 'Plain', createdAt: at, updatedAt: at, turns: [{
      userText: 'A message.', createdAt: at, capturedAt: at, captureTimeZone: 'UTC',
    }] }] };
    const customTurns = [payload.conversations[0]!.turns[0]];
    Object.setPrototypeOf(customTurns, Object.create(Array.prototype, { map: { value: () => { throw new Error('must not run'); } } }));
    expect(() => validatePortableChatHistory({ ...payload, conversations: [{ ...payload.conversations[0]!, turns: customTurns }] })).toThrow(/plain array/i);

    let getterCalls = 0;
    const accessorTurns = [] as unknown[];
    Object.defineProperty(accessorTurns, '0', { enumerable: true, configurable: false, get: () => { getterCalls += 1; throw new Error('must not run'); } });
    Object.defineProperty(accessorTurns, 'length', { value: 1 });
    expect(() => validatePortableChatHistory({ ...payload, conversations: [{ ...payload.conversations[0]!, turns: accessorTurns }] })).toThrow(/dense array/i);
    expect(getterCalls).toBe(0);
  });

  it('exports source-removed user turns and receipts without restoring reply content', async () => {
    const sourceRemovedLedger = validateChatLedger({ version: 1, conversations: [{ id: conversationId, title: 'Planning', createdAt: at, updatedAt: at,
      turns: [{ id: turnId, noteId, noteRevision: 1, jobId, userText: 'Keep my question.', createdAt: at, captureTimeZone: 'Asia/Singapore' }] }] });
    const { noteId: _noteId, noteRevision: _noteRevision, intent: _intent, question: _question, knowledgeSelection: _selection,
      capturedAt: _capturedAt, captureTimeZone: _zone, settingsFingerprint: _settings, sourceFingerprint: _source,
      requestBytes: _bytes, omittedSourceCount: _omitted, requestBody: _body, sourceVersions: _versions, appliedNoteRevision: _applied,
      chatBinding: _binding, ...receipt } = batchJob();
    const sourceRemovedJob: OpenRouterBatchJob = { ...receipt, status: 'source_removed', sourceRemoved: true, requestProfileVersion: 2,
      accounting: { providerReportedCostUsd: 0, byok: true, completionTokens: 3 } };
    const payload = await createPortableChatHistory(sourceRemovedLedger, validateOpenRouterBatchLedger({ version: 1, jobs: [sourceRemovedJob] }), async () => true);
    expect(payload.conversations[0]?.turns[0]).toEqual({ userText: 'Keep my question.', createdAt: at, capturedAt: at,
      captureTimeZone: 'Asia/Singapore', accounting: { costUsd: 0, isByok: true, completionTokens: 3 } });
  });

  it('preserves submission order when replies complete out of order and capture anchors move backward', async () => {
    const secondAt = '2026-10-13T10:00:02.000Z';
    const secondCompletedAt = '2026-10-13T10:00:03.000Z';
    const firstCompletedAt = '2026-10-13T10:00:04.000Z';
    const firstTurn = '20000000-0000-4000-8000-000000000011';
    const secondTurn = '20000000-0000-4000-8000-000000000012';
    const firstNote = '30000000-0000-4000-8000-000000000011';
    const secondNote = '30000000-0000-4000-8000-000000000012';
    const firstJobId = '40000000-0000-4000-8000-000000000011';
    const secondJobId = '40000000-0000-4000-8000-000000000012';
    const chat = validateChatLedger({ version: 1, conversations: [{ id: conversationId, title: 'Parallel replies', createdAt: at, updatedAt: firstCompletedAt,
      turns: [
        { id: firstTurn, noteId: firstNote, noteRevision: 1, jobId: firstJobId, userText: 'First question.', createdAt: at, captureTimeZone: 'UTC',
          reply: { summary: 'Done first.', answer: 'First answer.', clarifications: [], completedAt: firstCompletedAt, requestSha256: 'a'.repeat(64), requestProfileVersion: 2 },
          replySha256: 'c'.repeat(64) },
        { id: secondTurn, noteId: secondNote, noteRevision: 1, jobId: secondJobId, userText: 'Second question.', createdAt: secondAt, captureTimeZone: 'UTC',
          reply: { summary: 'Done second.', answer: 'Second answer.', clarifications: [], completedAt: secondCompletedAt, requestSha256: 'a'.repeat(64), requestProfileVersion: 2 },
          replySha256: 'b'.repeat(64) },
      ] }] });
    const firstJob = { ...batchJob(), id: firstJobId, customId: firstJobId, updatedAt: firstCompletedAt, batchId: 'first-batch',
      noteId: firstNote, captureTimeZone: 'UTC', chatBinding: { conversationId, turnId: firstTurn, context: [], omittedTurnCount: 0 } };
    const secondJob = { ...batchJob(), id: secondJobId, customId: secondJobId, createdAt: secondAt, updatedAt: secondAt,
      batchId: 'second-batch', noteId: secondNote, capturedAt: secondAt, captureTimeZone: 'UTC',
      chatBinding: { conversationId, turnId: secondTurn, context: [], omittedTurnCount: 0 } };
    const exported = await createPortableChatHistory(chat, validateOpenRouterBatchLedger({ version: 1, jobs: [firstJob, secondJob] }),
      async (_reply, digest) => digest === 'b'.repeat(64) || digest === 'c'.repeat(64));
    expect(exported.conversations[0]?.turns.map((turn) => turn.createdAt)).toEqual([at, secondAt]);
    expect(exported.conversations[0]?.turns.map((turn) => turn.reply?.answer)).toEqual(['First answer.', 'Second answer.']);
    expect(Date.parse(exported.conversations[0]!.turns[0]!.reply!.completedAt)).toBeGreaterThan(Date.parse(exported.conversations[0]!.turns[1]!.reply!.completedAt));

    const thirdAt = '2026-10-13T10:00:03.000Z';
    const parentCapturedAt = '2026-10-13T10:00:01.000Z';
    const childCapturedAt = at;
    const importedShape = validatePortableChatHistory({ version: 1, conversations: [{ title: 'Delayed child', createdAt: at, updatedAt: thirdAt, turns: [
      { userText: 'Parent.', createdAt: secondAt, capturedAt: parentCapturedAt, captureTimeZone: 'UTC' },
      { userText: 'More reasoning.', createdAt: thirdAt, capturedAt: childCapturedAt, captureTimeZone: 'UTC' },
    ] }] });
    expect(importedShape.conversations[0]?.turns.map((turn) => turn.capturedAt)).toEqual([parentCapturedAt, childCapturedAt]);
  });
});
