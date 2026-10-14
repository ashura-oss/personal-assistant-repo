import { describe, expect, it, vi } from "vitest";
import type { DispatchRecoveryPlan, DispatchRecoveryReceiptInspection, DispatchRecoveryStatus } from "../src/dispatch/recovery";
import { closeOwnedDispatchRecovery, DispatchRecoveryOwnership, openCurrentDispatchRecoveryAfterNotVerified, runOwnedDispatchRecoveryAction } from "../src/ui/dispatchRecoveryOwnership";

const plan = (operationId: string): DispatchRecoveryPlan => ({
  operationId, expiresAt: "2026-10-14T10:00:00.000Z", evidenceBytes: 42, archiveCount: 1,
  effects: { quarantinedReceiptCount: 1, preservedValidReceiptCount: 2, remoteProposalsRetired: 3, sourceActionFencesAdded: 1, unresolvedReceiptCount: 1 },
});

function fakeApi() {
  return {
    prepareDispatchRecovery: vi.fn(async () => plan("plan-1")),
    cancelDispatchRecovery: vi.fn(async () => undefined),
    confirmDispatchRecovery: vi.fn(async ({ operationId }: { operationId: string }) => ({ status: "unknown" as const, operationId })),
    refreshPersistedWorkspace: vi.fn(async () => undefined),
    inspectDispatchRecoveryReceipt: vi.fn(async (operationId: string): Promise<DispatchRecoveryReceiptInspection> => ({ status: "applied", operationId, archivedAt: "2026-10-14T09:00:00.000Z", evidenceBytes: 42, archiveCount: 1 })),
  };
}

describe("dispatch recovery ownership used by App", () => {
  it("rejects a delayed close from an old Settings owner without clearing the reopened review", () => {
    const ownership = new DispatchRecoveryOwnership();
    const oldOwner = ownership.open(() => true)!;
    expect(closeOwnedDispatchRecovery(ownership, oldOwner)).toEqual({ operationId: undefined });
    const newOwner = ownership.open(() => true)!;
    expect(closeOwnedDispatchRecovery(ownership, oldOwner)).toBeUndefined();
    expect(ownership.isCurrent(newOwner)).toBe(true);
    expect(ownership.isOpen).toBe(true);
  });

  it("does not let a rejected duplicate App action release the first action's shared busy state", async () => {
    let resolve!: (value: DispatchRecoveryPlan) => void;
    const api = fakeApi();
    api.prepareDispatchRecovery.mockReturnValue(new Promise((accept) => { resolve = accept; }));
    const ownership = new DispatchRecoveryOwnership();
    const owner = ownership.open(() => true)!;
    const busy: boolean[] = [];
    const invokeAppPrepare = () => runOwnedDispatchRecoveryAction(
      (onAdmitted) => ownership.prepare(owner, api, () => true, onAdmitted),
      (value) => busy.push(value),
    );

    const first = invokeAppPrepare();
    expect(busy).toEqual([true]);
    await expect(invokeAppPrepare()).resolves.toBeUndefined();
    expect(busy).toEqual([true]);
    expect(ownership.isBusy).toBe(true);

    resolve(plan("plan-1"));
    await expect(first).resolves.toMatchObject({ operationId: "plan-1" });
    expect(busy).toEqual([true, false]);
    expect(ownership.isBusy).toBe(false);
  });

  it("cancels the exact plan returned after its review owner closed during prepare", async () => {
    let resolve!: (value: DispatchRecoveryPlan) => void;
    const api = fakeApi();
    api.prepareDispatchRecovery.mockReturnValue(new Promise((accept) => { resolve = accept; }));
    const ownership = new DispatchRecoveryOwnership();
    const owner = ownership.open(() => true)!;
    const pending = ownership.prepare(owner, api, () => true);
    expect(ownership.isBusy).toBe(true);
    ownership.invalidate(owner);
    resolve(plan("late-plan"));
    await expect(pending).resolves.toBeUndefined();
    expect(api.cancelDispatchRecovery).toHaveBeenCalledExactlyOnceWith("late-plan");
    expect(ownership.plan).toBeUndefined();
    expect(ownership.isBusy).toBe(false);
  });

  it("rejects old plan callbacks after a new review opens without locking or touching the new plan", async () => {
    const api = fakeApi();
    const ownership = new DispatchRecoveryOwnership();
    const oldOwner = ownership.open(() => true)!;
    await ownership.prepare(oldOwner, api, () => true);
    ownership.invalidate(oldOwner);
    const newOwner = ownership.open(() => true)!;
    api.prepareDispatchRecovery.mockResolvedValueOnce(plan("new-plan"));
    await ownership.prepare(newOwner, api, () => true);

    await expect(ownership.confirm(oldOwner, "plan-1", api, () => true)).resolves.toBeUndefined();
    await expect(ownership.cancel(oldOwner, "plan-1", api, () => true)).resolves.toBe(false);
    expect(api.confirmDispatchRecovery).not.toHaveBeenCalled();
    expect(api.cancelDispatchRecovery).not.toHaveBeenCalled();
    expect(ownership.plan?.operationId).toBe("new-plan");
    expect(ownership.isBusy).toBe(false);
  });

  it("claims a plan before awaiting confirmation so a double tap sends one local confirmation", async () => {
    let resolve!: (value: { status: "unknown"; operationId: string }) => void;
    const api = fakeApi();
    api.confirmDispatchRecovery.mockReturnValue(new Promise((accept) => { resolve = accept; }));
    const ownership = new DispatchRecoveryOwnership();
    const owner = ownership.open(() => true)!;
    await ownership.prepare(owner, api, () => true);

    const first = ownership.confirm(owner, "plan-1", api, () => true);
    const second = await ownership.confirm(owner, "plan-1", api, () => true);
    expect(second).toBeUndefined();
    expect(api.confirmDispatchRecovery).toHaveBeenCalledExactlyOnceWith({ operationId: "plan-1", confirmation: "RETIRE ACTIONS" });
    resolve({ status: "unknown", operationId: "plan-1" });
    await expect(first).resolves.toEqual({ status: "unknown", operationId: "plan-1" });
    expect(ownership.plan).toBeUndefined();
  });

  it("keeps unresolved outcomes on an explicit refresh-then-read-only-inspect path", async () => {
    let mutationAllowed = true;
    let readAllowed = true;
    const api = fakeApi();
    api.confirmDispatchRecovery.mockImplementation(async ({ operationId }) => {
      mutationAllowed = false; // The controller publishes refresh_required after an unknown commit.
      return { status: "unknown", operationId };
    });
    const ownership = new DispatchRecoveryOwnership();
    const owner = ownership.open(() => mutationAllowed)!;
    await ownership.prepare(owner, api, () => mutationAllowed);
    await expect(ownership.confirm(owner, "plan-1", api, () => mutationAllowed, () => readAllowed)).resolves.toMatchObject({ status: "unknown" });
    expect(mutationAllowed).toBe(false);
    expect(ownership.isCurrent(owner)).toBe(true);

    const expected = () => true;
    await expect(ownership.refresh(owner, "plan-1", api, () => readAllowed, expected)).resolves.toBe(true);
    await expect(ownership.inspect(owner, "plan-1", "plan-1", api, () => readAllowed, expected))
      .resolves.toMatchObject({ status: "applied", operationId: "plan-1" });
    expect(api.refreshPersistedWorkspace).toHaveBeenCalledOnce();
    expect(api.inspectDispatchRecoveryReceipt).toHaveBeenCalledExactlyOnceWith("plan-1");
    expect(api.confirmDispatchRecovery).toHaveBeenCalledOnce();
  });

  it("does not inspect a stale operation or leak its busy lock when admission changes", async () => {
    let allowed = true;
    const api = fakeApi();
    const ownership = new DispatchRecoveryOwnership();
    const owner = ownership.open(() => allowed)!;
    await ownership.prepare(owner, api, () => allowed);
    const callsBefore = api.inspectDispatchRecoveryReceipt.mock.calls.length;
    allowed = false;
    await expect(ownership.inspect(owner, "wrong-operation", "wrong-operation", api, () => allowed, () => false)).resolves.toBeUndefined();
    expect(api.inspectDispatchRecoveryReceipt).toHaveBeenCalledTimes(callsBefore);
    expect(ownership.isBusy).toBe(false);
  });

  it("requires a completed refresh and exact not-verified inspection before a fresh current-history review", async () => {
    const api = fakeApi();
    api.confirmDispatchRecovery.mockRejectedValueOnce(new Error("save failed before commit"));
    api.inspectDispatchRecoveryReceipt.mockResolvedValueOnce({ status: "not_verified", operationId: "plan-1" });
    const ownership = new DispatchRecoveryOwnership();
    const owner = ownership.open(() => true)!;
    await ownership.prepare(owner, api, () => true);
    await expect(ownership.confirm(owner, "plan-1", api, () => true)).rejects.toThrow("save failed before commit");
    await expect(ownership.refresh(owner, "plan-1", api, () => true, () => true)).resolves.toBe(true);
    await expect(ownership.inspect(owner, "plan-1", "plan-1", api, () => true, () => true))
      .resolves.toEqual({ status: "not_verified", operationId: "plan-1" });
    expect(ownership.currentNotVerifiedOperationId(owner)).toBe("plan-1");

    let currentStatus: DispatchRecoveryStatus = { status: "available", archiveCount: 1, archiveBytes: 42 };
    let mutationAllowed = true;
    // This is the same status-reading admission helper used by the Settings callback.
    const chooseCurrentReview = () => openCurrentDispatchRecoveryAfterNotVerified(
      ownership, owner, "plan-1", () => currentStatus, () => mutationAllowed,
    );
    const ineligibleStatuses: DispatchRecoveryStatus[] = [
      { status: "unavailable", reason: "archive_invalid", archiveCount: null, archiveBytes: null },
      { status: "unavailable", archiveCount: 1, archiveBytes: 42 },
      { status: "not_needed", archiveCount: 1, archiveBytes: 42 },
      { status: "busy", archiveCount: 1, archiveBytes: 42 },
      { status: "refresh_required", archiveCount: 1, archiveBytes: 42 },
    ];
    for (const status of ineligibleStatuses) {
      currentStatus = status;
      expect(chooseCurrentReview()).toBeUndefined();
      expect(ownership.isCurrent(owner)).toBe(true);
    }
    mutationAllowed = false;
    expect(chooseCurrentReview()).toBeUndefined();
    mutationAllowed = true;
    currentStatus = { status: "available", archiveCount: 1, archiveBytes: 42 };
    const newOwner = chooseCurrentReview();
    expect(newOwner).toBeDefined();
    expect(newOwner).not.toBe(owner);
    expect(ownership.isCurrent(newOwner!)).toBe(true);
    expect(ownership.plan).toBeUndefined();
    expect(ownership.currentNotVerifiedOperationId(newOwner!)).toBeUndefined();

    await expect(ownership.confirm(owner, "plan-1", api, () => true)).resolves.toBeUndefined();
    expect(closeOwnedDispatchRecovery(ownership, owner)).toBeUndefined();
    api.prepareDispatchRecovery.mockResolvedValueOnce(plan("plan-2"));
    await expect(ownership.prepare(newOwner!, api, () => true)).resolves.toMatchObject({ operationId: "plan-2" });
    expect(api.confirmDispatchRecovery).toHaveBeenCalledOnce();
    expect(ownership.plan?.operationId).toBe("plan-2");

    // A click handler rendered while eligible must still read live status and gates.
    currentStatus = { status: "unavailable", archiveCount: 1, archiveBytes: 42 };
    expect(chooseCurrentReview()).toBeUndefined();
    currentStatus = { status: "available", archiveCount: 1, archiveBytes: 42 };
    mutationAllowed = false;
    expect(chooseCurrentReview()).toBeUndefined();
    expect(ownership.plan?.operationId).toBe("plan-2");
  });

  it("does not issue a fresh-review proof for unavailable or failed receipt inspection", async () => {
    for (const inspectResult of [
      { status: "unavailable" as const, operationId: "plan-1" },
      new Error("inspection failed"),
    ]) {
      const api = fakeApi();
      api.confirmDispatchRecovery.mockRejectedValueOnce(new Error("save failed"));
      if (inspectResult instanceof Error) api.inspectDispatchRecoveryReceipt.mockRejectedValueOnce(inspectResult);
      else api.inspectDispatchRecoveryReceipt.mockResolvedValueOnce(inspectResult);
      const ownership = new DispatchRecoveryOwnership();
      const owner = ownership.open(() => true)!;
      await ownership.prepare(owner, api, () => true);
      await expect(ownership.confirm(owner, "plan-1", api, () => true)).rejects.toThrow("save failed");
      await ownership.refresh(owner, "plan-1", api, () => true, () => true);
      if (inspectResult instanceof Error) {
        await expect(ownership.inspect(owner, "plan-1", "plan-1", api, () => true, () => true)).rejects.toThrow("inspection failed");
      } else {
        await ownership.inspect(owner, "plan-1", "plan-1", api, () => true, () => true);
      }
      expect(ownership.currentNotVerifiedOperationId(owner)).toBeUndefined();
      expect(openCurrentDispatchRecoveryAfterNotVerified(
        ownership, owner, "plan-1", () => ({ status: "available", archiveCount: 1, archiveBytes: 42 }), () => true,
      )).toBeUndefined();
    }
  });
});
