import { describe, expect, it } from 'vitest';
import { STATE_SNAPSHOT_READ_MAX_BYTES } from '../src/storage/contracts';
import { emptyChatLedger, selectCompletedChatContext, validateChatLedger } from '../src/chat/ledger';
import type { ChatConversation, ChatTurn } from '../src/chat/types';

const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
const ids = {
  conversation: '11111111-1111-4111-8111-111111111111',
  turn1: '22222222-2222-4222-8222-222222222222', note1: '33333333-3333-4333-8333-333333333333', job1: '44444444-4444-4444-8444-444444444444',
  turn2: '55555555-5555-4555-8555-555555555555', note2: '66666666-6666-4666-8666-666666666666', job2: '77777777-7777-4777-8777-777777777777',
  turn3: '88888888-8888-4888-8888-888888888888', note3: '99999999-9999-4999-8999-999999999999', job3: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  turn4: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', note4: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', job4: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
};

function turn(index: 1 | 2 | 3 | 4, createdSecond: number, reply?: boolean): ChatTurn {
  const result: ChatTurn = {
    id: ids[`turn${index}`], noteId: ids[`note${index}`], noteRevision: index,
    jobId: ids[`job${index}`], userText: `question ${index}`, createdAt: at(createdSecond), captureTimeZone: 'America/New_York',
    ...(reply ? { reply: {
      summary: `summary ${index}`, answer: `answer ${index}`, clarifications: index === 1 ? ['first clarification'] : [],
      completedAt: at(createdSecond + 1), requestSha256: 'a'.repeat(64), requestProfileVersion: index === 2 ? 2 : 1,
    } } : {}),
  };
  return result;
}

function conversation(turns: readonly ChatTurn[], updatedSecond = 20): ChatConversation {
  return { id: ids.conversation, title: 'Keep this title', createdAt: at(0), updatedAt: at(updatedSecond), turns };
}

describe('chat ledger', () => {
  it('returns a deeply frozen clone and preserves strings without normalization', () => {
    const rawTurn = structuredClone(turn(1, 1, true)) as unknown as { -readonly [Key in keyof ChatTurn]: ChatTurn[Key] };
    rawTurn.userText = '  exact text\nnext line  ';
    const raw = { version: 1, conversations: [conversation([rawTurn])] };
    const checked = validateChatLedger(raw);
    rawTurn.userText = 'mutated later';
    (raw.conversations[0] as unknown as { title: string }).title = 'also changed';
    expect(checked.conversations[0].turns[0].userText).toBe('  exact text\nnext line  ');
    expect(checked.conversations[0].title).toBe('Keep this title');
    expect(Object.isFrozen(checked)).toBe(true);
    expect(Object.isFrozen(checked.conversations[0].turns[0].reply?.clarifications)).toBe(true);
    expect(() => (checked.conversations as ChatConversation[]).push(conversation([]))).toThrow();
    expect(emptyChatLedger()).toEqual({ version: 1, conversations: [] });
  });

  it('enforces exact keys, schema version, UUIDv4, text safety, and unique references', () => {
    const valid = { version: 1, conversations: [conversation([turn(1, 1, true)])] };
    expect(() => validateChatLedger({ ...valid, unknown: true })).toThrow(/unknown or missing/i);
    expect(() => validateChatLedger({ ...valid, version: '1' })).toThrow(/version/i);
    expect(() => validateChatLedger({ version: 2, conversations: [] })).toThrow(/version/i);
    expect(() => validateChatLedger({ version: 1, conversations: [conversation([{ ...turn(1, 1), id: `${ids.turn1}\n` }])] })).toThrow(/UUIDv4/i);
    expect(() => validateChatLedger({ version: 1, conversations: [conversation([turn(1, 1, true), { ...turn(2, 3), noteId: ids.note1 }])] })).toThrow(/unique/i);
    expect(() => validateChatLedger({ version: 1, conversations: [conversation([turn(1, 1), { ...turn(2, 3), jobId: ids.job1 }])] })).toThrow(/unique/i);
    expect(() => validateChatLedger({ version: 1, conversations: [conversation([{ ...turn(1, 1), userText: 'bad\u0000text' }])] })).toThrow(/invalid/i);
    expect(() => validateChatLedger({ version: 1, conversations: [conversation([{ ...turn(1, 1), userText: '\ud800' }])] })).toThrow(/invalid/i);
    expect(() => validateChatLedger({ version: 1, conversations: [{ ...conversation([turn(1, 1, true)]), title: 'x'.repeat(161) }] })).toThrow(/title/i);
    expect(() => validateChatLedger({ version: 1, conversations: [conversation([turn(1, 3, true), turn(2, 2)])] })).toThrow(/monotonic/i);
    const undefinedReply = { ...turn(1, 1), reply: undefined };
    expect(() => validateChatLedger({ version: 1, conversations: [conversation([undefinedReply])] })).toThrow(/reply/i);
  });

  it('accepts both reply profiles and long immutable reply snapshots', () => {
    const longAnswer = 'é'.repeat(7000);
    const first = { ...turn(1, 1, true), reply: { ...turn(1, 1, true).reply!, answer: longAnswer } };
    const second = { ...turn(2, 3, true), reply: { ...turn(2, 3, true).reply!, requestProfileVersion: 2 as const } };
    const checked = validateChatLedger({ version: 1, conversations: [conversation([first, second])] });
    expect(checked.conversations[0].turns[0].reply?.answer).toHaveLength(7000);
    expect(checked.conversations[0].turns[1].reply?.requestProfileVersion).toBe(2);
  });

  it('allows earlier requests to finish after later turns were created', () => {
    const firstPending = turn(1, 1);
    const secondPending = turn(2, 2);
    const lateFirst = { ...firstPending, reply: { ...turn(1, 1, true).reply!, completedAt: at(4) } };
    const laterReply = { ...secondPending, reply: { ...turn(2, 2, true).reply!, completedAt: at(5) } };
    const checked = validateChatLedger({ version: 1, conversations: [conversation([lateFirst, laterReply], 6)] });
    expect(checked.conversations[0].turns.map((item) => item.createdAt)).toEqual([at(1), at(2)]);
    expect(checked.conversations[0].turns.map((item) => item.reply?.completedAt)).toEqual([at(4), at(5)]);
  });

  it('enforces the whole-ledger limit using UTF-8 bytes', () => {
    const oversized = { ...turn(1, 1, true), reply: { ...turn(1, 1, true).reply!, answer: 'é'.repeat(Math.floor(STATE_SNAPSHOT_READ_MAX_BYTES / 2) + 1) } };
    expect(() => validateChatLedger({ version: 1, conversations: [conversation([oversized])] })).toThrow(/size limit/i);
  });

  it('selects only eligible completed turns before the current turn in chronological order', () => {
    const prior = [turn(1, 1, true), turn(2, 3, true), turn(3, 5), turn(4, 7, true)];
    const current = { ...turn(1, 9), id: ids.turn1, noteId: ids.note1, jobId: ids.job1 };
    // The current turn is appended after history; use a separate unique id set in the test snapshot.
    const currentTurn: ChatTurn = { ...current, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', noteId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', jobId: '12345678-1234-4234-8234-123456789abc' };
    const source = conversation([...prior, currentTurn], 12);
    const selected = selectCompletedChatContext(source, currentTurn.id, new Set([ids.job1, ids.job2, ids.job4]), 100_000);
    expect(selected.turns.map((item) => item.turnId)).toEqual([ids.turn1, ids.turn2, ids.turn4]);
    expect(selected.turns[0].assistantText).toBe('answer 1\nfirst clarification');
    expect(selected.omittedTurnCount).toBe(1);
    expect(() => selectCompletedChatContext(source, ids.job1, new Set(), 100)).toThrow(/current chat turn/i);
  });

  it('counts eligible omissions and selects newest whole turns under the byte budget', () => {
    const history = [turn(1, 1, true), turn(2, 3, true), turn(3, 5, true)];
    const currentTurn: ChatTurn = { ...turn(4, 7), id: ids.turn4, noteId: ids.note4, jobId: ids.job4 };
    const source = conversation([...history, currentTurn], 10);
    const newest = { turnId: ids.turn3, jobId: ids.job3, userText: 'question 3', assistantText: 'answer 3' };
    const maxBytes = new TextEncoder().encode(JSON.stringify([newest])).length;
    const selected = selectCompletedChatContext(source, currentTurn.id, new Set([ids.job1, ids.job2, ids.job3]), maxBytes);
    expect(selected.turns.map((item) => item.turnId)).toEqual([ids.turn3]);
    expect(selected.omittedTurnCount).toBe(2);
    expect(selected.includedBytes).toBe(maxBytes);
  });
});
