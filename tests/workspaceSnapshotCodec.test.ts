import { describe, expect, it } from 'vitest';
import { createInitialWorkspaceState } from '../src/services/controller.shared';
import { createWorkspaceSnapshotDTO, type WorkspaceSnapshotDTO } from '../src/cloud/workspaceDto';
import { decodeWorkspaceSnapshotDTO, encodeWorkspaceSnapshotDTO, WORKSPACE_SNAPSHOT_MAX_BYTES } from '../src/cloud/workspaceSnapshotCodec';

const workspaceId = '7b906fca-65c1-4bd2-b18e-1b56cc6f48a8';
const noteId = '42692596-d245-4c9d-bc55-e64ddc274ca1';

function sample(): WorkspaceSnapshotDTO {
  const state = createInitialWorkspaceState(() => noteId);
  state.notes.push({ id: noteId, title: 'Codec note', transcript: 'User prose may mention tokenRef and uploadSecret.', durationSeconds: 1,
    createdAt: '2026-10-14T08:00:00.000Z', status: 'processed', revision: 1 });
  return createWorkspaceSnapshotDTO({ getSnapshot: () => state }, { workspaceId, privacyEpoch: 2, revision: 9 });
}

function mutableCopy(): Record<string, any> { return structuredClone(sample()) as Record<string, any>; }

function expectRejected(value: unknown): void { expect(() => decodeWorkspaceSnapshotDTO(value)).toThrow(/workspace_snapshot_invalid/); }
function compileDTOType(snapshot: WorkspaceSnapshotDTO): void {
  // @ts-expect-error Public DTOs cannot be mutated through the decoder type.
  snapshot.state.notes[0]!.transcript = 'mutable';
}
void compileDTOType;

describe('workspace snapshot codec', () => {
  it('round trips projected data into a fresh deeply frozen WorkspaceSnapshotDTO', () => {
    const original = sample();
    const decoded: WorkspaceSnapshotDTO = decodeWorkspaceSnapshotDTO(JSON.parse(JSON.stringify(original)) as unknown);
    expect(decoded).toEqual(original);
    expect(decoded).not.toBe(original);
    expect(decoded.state.notes[0]?.transcript).toContain('tokenRef');
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.state.notes)).toBe(true);
    expect(encodeWorkspaceSnapshotDTO(original)).toEqual(original);
  });

  it('omits optional undefined object members but rejects undefined required fields and array entries', () => {
    const dto = mutableCopy();
    dto.state.settings.speechRegion = undefined;
    const normalized = decodeWorkspaceSnapshotDTO(dto);
    expect(Object.hasOwn(normalized.state.settings, 'speechRegion')).toBe(false);
    const required = mutableCopy();
    required.revision = undefined;
    expectRejected(required);
    const arrayValue = mutableCopy();
    arrayValue.state.notes.push(undefined);
    expectRejected(arrayValue);
  });

  it('rejects nested unknown/private fields and invalid structural values', () => {
    const nested = mutableCopy();
    nested.state.notes[0].tokenRef = 'secret';
    expectRejected(nested);
    const upload = mutableCopy();
    upload.state.notes[0].audio = { available: false, uploadSecret: 'secret' };
    expectRejected(upload);
    const wrongDictionary = mutableCopy();
    wrongDictionary.state.syncStates['bad-key'] = 'not a sync state';
    expectRejected(wrongDictionary);
    const wrongNumber = mutableCopy();
    wrongNumber.privacyEpoch = -1;
    expectRejected(wrongNumber);
    const wrongUnion = mutableCopy();
    wrongUnion.state.reminders.records.push({ id: 'r', title: 'Reminder', body: '', dueAt: '', displayTimeZone: 'UTC', privacyMode: 'private',
      origin: { kind: 'manual', installationId: 'private-installation-id' }, status: 'draft', revision: 1, createdAt: '', updatedAt: '' });
    expectRejected(wrongUnion);
  });

  it('rejects accessors, custom prototypes, symbols and cycles without invoking accessors', () => {
    const accessor = mutableCopy();
    let invoked = false;
    Object.defineProperty(accessor.state.settings, 'timezone', { enumerable: true, get() { invoked = true; return 'UTC'; } });
    expectRejected(accessor);
    expect(invoked).toBe(false);
    const custom = mutableCopy();
    Object.setPrototypeOf(custom, { polluted: true });
    expectRejected(custom);
    const symbol = mutableCopy();
    Object.defineProperty(symbol, Symbol('hidden'), { value: 'secret' });
    expectRejected(symbol);
    const cyclic = mutableCopy();
    cyclic.state.syncStates.loop = cyclic.state.syncStates;
    expectRejected(cyclic);
  });

  it('enforces the physical byte bound and semantic media/cost/token invariants', () => {
    const oversized = mutableCopy();
    oversized.state.notes[0].transcript = 'x'.repeat(WORKSPACE_SNAPSHOT_MAX_BYTES);
    expectRejected(oversized);
    const escapedOversize = mutableCopy();
    escapedOversize.state.notes[0].transcript = '\n'.repeat(Math.ceil(WORKSPACE_SNAPSHOT_MAX_BYTES / 2));
    expectRejected(escapedOversize);
    let lateTraversal = false;
    const earlyOversize = { workspaceId: 'x'.repeat(WORKSPACE_SNAPSHOT_MAX_BYTES), state: new Proxy({}, {
      getPrototypeOf() { lateTraversal = true; return Object.prototype; },
    }) };
    expect(() => decodeWorkspaceSnapshotDTO(earlyOversize)).toThrow('workspace_snapshot_invalid:size');
    expect(lateTraversal).toBe(false);
    const media = mutableCopy();
    media.state.notes[0].audio = { available: true };
    expectRejected(media);
    const badMediaLength = mutableCopy();
    badMediaLength.state.notes[0].audio = { available: false, byteLength: -1 };
    expectRejected(badMediaLength);
    const cost = mutableCopy();
    cost.state.usage.inputTokens = -1;
    expectRejected(cost);
  });
});
