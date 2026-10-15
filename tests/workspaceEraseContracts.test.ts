import { describe, expect, it } from 'vitest';
import { parseWorkspaceErasePlan, parseWorkspaceEraseReceipt, parseWorkspaceEraseStatus } from '../src/cloud/workspaceEraseContracts';

const id = 'e53e7c18-4128-4e80-a55e-331db010a447';
const counts = { notes: 2, documents: 3, accounts: 1, proposals: 4, audioUploads: 5, backgroundPolicies: 6 };
const plan = { schemaVersion: 1, commandId: id, expectedRevision: 8, expectedPrivacyEpoch: 3,
  expiresAt: '2026-10-15T02:00:00.000Z', counts, status: 'prepared' } as const;
const receipt = { schemaVersion: 1, commandId: id, status: 'cleanup_pending', erasedPrivacyEpoch: 3, currentPrivacyEpoch: 4,
  createdAt: '2026-10-15T01:00:00.000Z' } as const;

describe('closed workspace erasure projections', () => {
  it('accepts canonical reviewed plans, receipts, and status recovery states', () => {
    expect(parseWorkspaceErasePlan(plan)).toEqual(plan);
    expect(parseWorkspaceEraseReceipt(receipt)).toEqual(receipt);
    expect(parseWorkspaceEraseStatus({ schemaVersion: 1, status: 'prepared', plan,
      hold: { commandId: id, status: 'drained', expectedRevision: 8, expectedPrivacyEpoch: 3 } })).toMatchObject({ status: 'prepared', plan });
    expect(parseWorkspaceEraseStatus({ schemaVersion: 1, status: 'cleanup_pending', receipt })).toMatchObject({ status: 'cleanup_pending', receipt });
    expect(parseWorkspaceEraseStatus({ schemaVersion: 1, status: 'none', hold: { commandId: id, status: 'drain_failed', expectedRevision: 9,
      expectedPrivacyEpoch: 3 } })).toMatchObject({ status: 'none', hold: { expectedRevision: 9 } });
  });

  it('rejects extra keys, symbols, accessors, nonplain objects, malformed counts, and contradictory bindings', () => {
    expect(() => parseWorkspaceErasePlan({ ...plan, privatePath: '/secret' })).toThrow('workspace_erase_plan_invalid');
    expect(() => parseWorkspaceErasePlan(Object.assign({}, plan, { [Symbol('extra')]: true }))).toThrow('workspace_erase_plan_invalid');
    const accessor = { ...plan } as Record<string, unknown>;
    Object.defineProperty(accessor, 'counts', { enumerable: true, get: () => counts });
    expect(() => parseWorkspaceErasePlan(accessor)).toThrow('workspace_erase_plan_invalid');
    expect(() => parseWorkspaceErasePlan(Object.assign(Object.create({ inherited: true }), plan))).toThrow('workspace_erase_plan_invalid');
    expect(() => parseWorkspaceErasePlan({ ...plan, counts: { ...counts, accounts: -1 } })).toThrow('workspace_erase_counts_invalid');
    expect(() => parseWorkspaceEraseReceipt({ ...receipt, currentPrivacyEpoch: 5 })).toThrow('workspace_erase_receipt_invalid');
    expect(() => parseWorkspaceEraseStatus({ schemaVersion: 1, status: 'prepared', plan,
      hold: { commandId: id, status: 'drained', expectedRevision: 9, expectedPrivacyEpoch: 3 } })).toThrow('workspace_erase_status_invalid');
  });
});
