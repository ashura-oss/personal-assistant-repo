import type { AppController } from "../core";
import type { DispatchRecoveryPlan, DispatchRecoveryResult, DispatchRecoveryReceiptInspection, DispatchRecoveryStatus } from "../dispatch/recovery";

type DispatchRecoveryPort = Pick<AppController,
  | "prepareDispatchRecovery"
  | "cancelDispatchRecovery"
  | "confirmDispatchRecovery"
  | "inspectDispatchRecoveryReceipt"
  | "refreshPersistedWorkspace"
>;

type Action = { readonly token: number; readonly owner: number; readonly operationId?: string };

/** Bridges coordinator admission to App's shared busy lock without inferring ownership from global busy state. */
export async function runOwnedDispatchRecoveryAction<T>(
  start: (onAdmitted: () => void) => Promise<T>,
  publishBusy: (busy: boolean) => void,
): Promise<T> {
  let admitted = false;
  try {
    return await start(() => {
      if (admitted) return;
      admitted = true;
      publishBusy(true);
    });
  } finally {
    if (admitted) publishBusy(false);
  }
}

/** App's close callback must prove its captured owner and optional plan before touching UI state. */
export function closeOwnedDispatchRecovery(
  ownership: DispatchRecoveryOwnership,
  owner: number,
  expectedOperationId?: string,
): { readonly operationId?: string } | undefined {
  if (!ownership.isCurrent(owner)) return undefined;
  if (expectedOperationId !== undefined && ownership.plan?.operationId !== expectedOperationId) return undefined;
  return { operationId: ownership.invalidate(owner) };
}

/** Reads backend status at click time and consumes only a coordinator-issued not-verified proof. */
export function openCurrentDispatchRecoveryAfterNotVerified(
  ownership: DispatchRecoveryOwnership,
  owner: number,
  previousOperationId: string,
  getStatus: () => DispatchRecoveryStatus,
  isAllowed: () => boolean,
): number | undefined {
  if (getStatus().status !== "available") return undefined;
  return ownership.openCurrentAfterNotVerified(owner, previousOperationId, isAllowed);
}

/** Owns the one-use local review lifecycle. The caller supplies its live privacy/readiness gate. */
export class DispatchRecoveryOwnership {
  private generation = 0;
  private openValue = false;
  private planValue?: DispatchRecoveryPlan;
  private action?: Action;
  private refreshedProof?: { readonly owner: number; readonly operationId: string; readonly actionToken: number };
  private notVerifiedProof?: { readonly owner: number; readonly operationId: string; readonly refreshToken: number };
  private nextActionToken = 0;
  private onBackgroundError: (error: unknown) => void = () => undefined;

  setBackgroundErrorHandler(handler: (error: unknown) => void): void { this.onBackgroundError = handler; }

  get plan(): DispatchRecoveryPlan | undefined { return this.planValue; }
  get isBusy(): boolean { return this.action !== undefined; }
  get owner(): number { return this.generation; }
  get isOpen(): boolean { return this.openValue; }

  open(isAllowed: () => boolean, preparedPlan?: DispatchRecoveryPlan): number | undefined {
    if (!isAllowed() || this.action) return undefined;
    this.refreshedProof = undefined;
    this.notVerifiedProof = undefined;
    this.generation += 1;
    this.openValue = true;
    this.planValue = preparedPlan;
    return this.generation;
  }

  invalidate(expectedOwner?: number): string | undefined {
    if (!this.openValue || expectedOwner !== undefined && expectedOwner !== this.generation) return undefined;
    const operationId = this.planValue?.operationId;
    this.generation += 1;
    this.openValue = false;
    this.planValue = undefined;
    this.refreshedProof = undefined;
    this.notVerifiedProof = undefined;
    return operationId;
  }

  currentNotVerifiedOperationId(owner: number): string | undefined {
    const proof = this.notVerifiedProof;
    return proof && proof.owner === owner && this.isCurrent(owner) ? proof.operationId : undefined;
  }

  openCurrentAfterNotVerified(owner: number, previousOperationId: string, isAllowed: () => boolean): number | undefined {
    const proof = this.notVerifiedProof;
    if (!this.isCurrent(owner) || !proof || proof.owner !== owner || proof.operationId !== previousOperationId ||
        !isAllowed() || this.action) return undefined;
    this.notVerifiedProof = undefined;
    this.refreshedProof = undefined;
    this.generation += 1;
    this.openValue = true;
    this.planValue = undefined;
    return this.generation;
  }

  discardPlan(owner: number, expectedOperationId?: string): string | undefined {
    if (!this.isCurrent(owner) || !this.planValue || expectedOperationId && this.planValue.operationId !== expectedOperationId) return undefined;
    const operationId = this.planValue.operationId;
    this.planValue = undefined;
    return operationId;
  }

  isCurrent(owner: number): boolean {
    return this.openValue && this.generation === owner;
  }

  private begin(owner: number, isAllowed: () => boolean, operationId?: string, requirePlan = false): Action | undefined {
    if (!this.isCurrent(owner) || !isAllowed() || this.action ||
        requirePlan && this.planValue?.operationId !== operationId) return undefined;
    const action = Object.freeze({ token: ++this.nextActionToken, owner, operationId });
    this.action = action;
    return action;
  }

  private owns(action: Action, isAllowed: () => boolean, requireOpen = true): boolean {
    return this.action?.token === action.token && this.generation === action.owner &&
      (!requireOpen || this.openValue) && isAllowed();
  }

  private finish(action: Action): void {
    if (this.action?.token !== action.token) return;
    this.action = undefined;
  }

  async prepare(owner: number, api: DispatchRecoveryPort, isAllowed: () => boolean, onAdmitted?: () => void): Promise<DispatchRecoveryPlan | undefined> {
    const action = this.begin(owner, isAllowed);
    if (!action) return undefined;
    onAdmitted?.();
    try {
      const plan = await api.prepareDispatchRecovery();
      if (!this.owns(action, isAllowed)) {
        void api.cancelDispatchRecovery(plan.operationId).catch((error) => this.onBackgroundError(error));
        return undefined;
      }
      this.planValue = plan;
      return plan;
    } finally { this.finish(action); }
  }

  async cancel(owner: number, operationId: string, api: DispatchRecoveryPort, isAllowed: () => boolean, onAdmitted?: () => void): Promise<boolean> {
    const action = this.begin(owner, isAllowed, operationId, true);
    if (!action) return false;
    onAdmitted?.();
    this.planValue = undefined;
    try {
      await api.cancelDispatchRecovery(operationId);
      return this.owns(action, isAllowed);
    } finally { this.finish(action); }
  }

  async confirm(owner: number, operationId: string, api: DispatchRecoveryPort, isAllowed: () => boolean, isPublishAllowed: () => boolean = isAllowed, onAdmitted?: () => void): Promise<DispatchRecoveryResult | undefined> {
    const action = this.begin(owner, isAllowed, operationId, true);
    if (!action) return undefined;
    onAdmitted?.();
    // Consume before awaiting; retries require a new explicit review.
    this.planValue = undefined;
    try {
      const result = await api.confirmDispatchRecovery({ operationId, confirmation: "RETIRE ACTIONS" });
      return this.owns(action, isPublishAllowed) ? result : undefined;
    } finally { this.finish(action); }
  }

  async refresh(owner: number, operationId: string, api: DispatchRecoveryPort, isAllowed: () => boolean, isExpected: () => boolean, onAdmitted?: () => void): Promise<boolean> {
    if (!isExpected()) return false;
    const action = this.begin(owner, isAllowed);
    if (!action) return false;
    onAdmitted?.();
    this.refreshedProof = undefined;
    this.notVerifiedProof = undefined;
    try {
      await api.refreshPersistedWorkspace();
      const refreshed = this.owns(action, isAllowed) && isExpected() && operationId.length > 0;
      if (refreshed) this.refreshedProof = { owner, operationId, actionToken: action.token };
      return refreshed;
    } finally { this.finish(action); }
  }

  async inspect(owner: number, operationId: string, refreshedOperationId: string | undefined, api: DispatchRecoveryPort, isAllowed: () => boolean, isExpected: () => boolean, onAdmitted?: () => void): Promise<DispatchRecoveryReceiptInspection | undefined> {
    if (!isExpected() || refreshedOperationId !== operationId) return undefined;
    const refreshedProof = this.refreshedProof;
    if (!refreshedProof || refreshedProof.owner !== owner || refreshedProof.operationId !== operationId) return undefined;
    const action = this.begin(owner, isAllowed, operationId);
    if (!action) return undefined;
    onAdmitted?.();
    try {
      const receipt = await api.inspectDispatchRecoveryReceipt(operationId);
      if (!this.owns(action, isAllowed) || !isExpected() || this.refreshedProof?.actionToken !== refreshedProof.actionToken || receipt.operationId !== operationId) return undefined;
      this.refreshedProof = undefined;
      this.notVerifiedProof = receipt.status === "not_verified"
        ? { owner, operationId, refreshToken: refreshedProof.actionToken }
        : undefined;
      return receipt;
    } finally { this.finish(action); }
  }
}
