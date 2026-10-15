import type { WorkspaceSnapshotDTO } from '../cloud/workspaceDto';
import { canonicalBackgroundJson, type BackgroundAccountSelection, type BackgroundPolicyDisplay, type BackgroundPolicyReceipt,
  type BackgroundPolicySpecification, type ChangeBackgroundPolicyEnvelope, type SaveBackgroundPolicyEnvelope } from '../cloud/backgroundContracts';
import { createWorkspaceCommandId, WorkspaceCommandNotStartedError, WorkspaceCommandUnknownError, WorkspaceClientError } from './workspaceClient';

export type BackgroundSyncDraft = Readonly<{
  dirty: boolean;
  policyId?: string;
  expectedPolicyRevision: number;
  accounts: readonly BackgroundAccountSelection[];
  resources: readonly ('mail' | 'calendars')[];
  intervalMinutes: string;
}>;

export type HeldBackgroundPolicyCommand = Readonly<{
  commandId: string;
  route: 'save' | 'pause' | 'revoke';
  policyId: string;
  expectedPolicyRevision: number;
  expectedStatus: 'enabled' | 'paused' | 'revoked';
  operation: 'save' | 'pause' | 'revoke';
  epoch: number;
  request: SaveBackgroundPolicyEnvelope | ChangeBackgroundPolicyEnvelope;
  canonicalRequest: string;
  draftGeneration?: number;
  draftAtSubmission?: BackgroundSyncDraft;
}>;

export type BackgroundPolicyReloadRequirement = Readonly<{ policyId: string; minimumRevision: number }>;

export type CloudBackgroundPolicyState = Readonly<{
  policies?: readonly BackgroundPolicyDisplay[];
  nextAfterPolicyId?: string;
  loaded?: boolean;
  loading?: boolean;
  draft?: BackgroundSyncDraft;
  heldCommand?: HeldBackgroundPolicyCommand;
  lastReceipt?: BackgroundPolicyReceipt;
  reloadRequiredPolicies?: readonly BackgroundPolicyReloadRequirement[];
  notice?: string;
}>;

export type CloudBackgroundPolicyPort = Readonly<{
  readSnapshot: () => WorkspaceSnapshotDTO | undefined;
  readOperation: () => Readonly<{ busy: boolean; pending: boolean; refreshRequired: boolean }>;
  list: (expectedPrivacyEpoch: number, afterPolicyId?: string) => Promise<readonly BackgroundPolicyDisplay[]>;
  save: (envelope: SaveBackgroundPolicyEnvelope) => Promise<BackgroundPolicyReceipt>;
  pause: (envelope: ChangeBackgroundPolicyEnvelope) => Promise<BackgroundPolicyReceipt>;
  revoke: (envelope: ChangeBackgroundPolicyEnvelope) => Promise<BackgroundPolicyReceipt>;
  inspect: (commandId: string, expectedPrivacyEpoch: number) => Promise<BackgroundPolicyReceipt | undefined>;
}>;

const PAGE_SIZE = 100;
const EMPTY_RESOURCES: readonly ('mail' | 'calendars')[] = Object.freeze(['mail']);

export class CloudBackgroundPolicyCoordinator {
  private value: CloudBackgroundPolicyState = Object.freeze({});
  private readonly listeners = new Set<() => void>();
  private active = true;
  private generation = 0;
  private draftGeneration = 0;

  constructor(private readonly port: CloudBackgroundPolicyPort) {}

  readonly getSnapshot = (): CloudBackgroundPolicyState => this.value;
  readonly subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  private publish(next: CloudBackgroundPolicyState): void {
    if (!this.active) return;
    this.value = Object.freeze(next);
    for (const listener of this.listeners) listener();
  }

  private owner() {
    const snapshot = this.port.readSnapshot();
    if (!this.active || !snapshot) throw new WorkspaceClientError('snapshot_required', 'Refresh the workspace before managing background policies.');
    return Object.freeze({ workspaceId: snapshot.workspaceId, privacyEpoch: snapshot.privacyEpoch, generation: this.generation });
  }

  private isOwner(owner: ReturnType<CloudBackgroundPolicyCoordinator['owner']>): boolean {
    const latest = this.port.readSnapshot();
    return this.active && owner.generation === this.generation && latest?.workspaceId === owner.workspaceId && latest.privacyEpoch === owner.privacyEpoch;
  }

  private operationReady(allowHeld = false): boolean {
    const operation = this.port.readOperation();
    return !operation.busy && !operation.pending && !operation.refreshRequired && (allowHeld || !this.value.heldCommand) && !this.value.loading;
  }

  startNewDraft(): void {
    if (this.value.draft?.dirty) {
      this.publish({ ...this.value, notice: 'Save or cancel the current policy form before starting another one.' });
      return;
    }
    this.draftGeneration += 1;
    this.publish({ ...this.value, draft: { dirty: false, expectedPolicyRevision: 0, accounts: [], resources: EMPTY_RESOURCES, intervalMinutes: '5' }, notice: undefined });
  }

  editPolicy(policyId: string): void {
    if (this.value.reloadRequiredPolicies?.some((item) => item.policyId === policyId)) {
      this.publish({ ...this.value, notice: 'Reload this saved policy before editing its current revision.' });
      return;
    }
    const policy = this.value.policies?.find((item) => item.policyId === policyId);
    if (!policy || policy.specification.kind !== 'account_sync' || policy.status === 'revoked') return;
    if (this.value.draft?.dirty && this.value.draft.policyId !== policyId) {
      this.publish({ ...this.value, notice: 'Save or cancel the current policy form before opening another one.' });
      return;
    }
    if (this.value.draft?.dirty && this.value.draft.policyId === policyId) {
      this.publish({ ...this.value, notice: 'Your policy edits are still here. Review them or cancel explicitly before replacing them.' });
      return;
    }
    this.draftGeneration += 1;
    this.publish({ ...this.value, draft: { policyId, expectedPolicyRevision: policy.revision,
      dirty: false,
      accounts: Object.freeze(policy.specification.accounts.map((item) => Object.freeze({ ...item }))),
      resources: Object.freeze([...policy.specification.resources]), intervalMinutes: String(policy.specification.intervalMinutes) }, notice: undefined });
  }

  cancelDraft(): void { this.draftGeneration += 1; this.publish({ ...this.value, draft: undefined, notice: undefined }); }

  setIntervalMinutes(value: string): void {
    if (!this.value.draft || !/^\d{0,4}$/.test(value)) return;
    this.publish({ ...this.value, draft: { ...this.value.draft, intervalMinutes: value, dirty: true }, notice: undefined });
  }

  toggleResource(resource: 'mail' | 'calendars'): void {
    const draft = this.value.draft;
    if (!draft) return;
    const resources = draft.resources.includes(resource) ? draft.resources.filter((item) => item !== resource) : [...draft.resources, resource];
    if (!resources.length) { this.publish({ ...this.value, notice: 'Choose at least one sync resource.' }); return; }
    const required = resources.map((item) => item === 'mail' ? 'mail.read' : 'calendar.read');
    const snapshot = this.port.readSnapshot();
    const missing = draft.accounts.find((selection) => {
      const account = snapshot?.state.accounts.find((item) => item.id === selection.accountId);
      return !account || required.some((capability) => !account.capabilities?.includes(capability));
    });
    if (missing) { this.publish({ ...this.value, notice: 'Remove or reselect accounts that do not grant every chosen resource before changing this selection.' }); return; }
    this.publish({ ...this.value, draft: { ...draft, resources: Object.freeze(resources), dirty: true }, notice: undefined });
  }

  toggleAccount(accountId: string): void {
    const draft = this.value.draft;
    const snapshot = this.port.readSnapshot();
    const account = snapshot?.state.accounts.find((item) => item.id === accountId);
    if (!draft || !account) return;
    const existing = draft.accounts.find((item) => item.accountId === accountId);
    if (existing) {
      this.publish({ ...this.value, draft: { ...draft, accounts: Object.freeze(draft.accounts.filter((item) => item.accountId !== accountId)), dirty: true }, notice: undefined });
      return;
    }
    const required = draft.resources.map((item) => item === 'mail' ? 'mail.read' : 'calendar.read');
    if (!account.connected || account.authStatus !== 'connected' || !Number.isSafeInteger(account.connectionGeneration) ||
        (account.provider !== 'google' && account.provider !== 'microsoft') || required.some((capability) => !account.capabilities?.includes(capability))) {
      this.publish({ ...this.value, notice: 'This account does not have a current connection with every required permission.' });
      return;
    }
    const selection = Object.freeze({ accountId, expectedConnectionGeneration: account.connectionGeneration! });
    this.publish({ ...this.value, draft: { ...draft, accounts: Object.freeze([...draft.accounts, selection]), dirty: true }, notice: undefined });
  }

  async loadFirstPage(): Promise<void> {
    await this.loadPage(undefined, false);
  }

  async loadMore(): Promise<void> {
    if (!this.value.nextAfterPolicyId) return;
    await this.loadPage(this.value.nextAfterPolicyId, true);
  }

  private async loadPage(afterPolicyId: string | undefined, append: boolean): Promise<void> {
    if (!this.operationReady()) {
      this.publish({ ...this.value, notice: 'Resolve the active workspace or policy request before loading policies.' });
      return;
    }
    const owner = this.owner();
    const generation = this.generation;
    this.publish({ ...this.value, loading: true, notice: undefined });
    try {
      const page = await this.port.list(owner.privacyEpoch, afterPolicyId);
      if (!this.isOwner(owner) || generation !== this.generation) {
        if (this.active && generation === this.generation) this.publish({ ...this.value, loading: false,
          notice: 'The workspace changed while policies were loading. Reload the current policy list.' });
        return;
      }
      if (new Set(page.map((item) => item.policyId)).size !== page.length) {
        this.publish({ ...this.value, loading: false, notice: 'The policy page repeated an ID. Reload the list before continuing.' });
        return;
      }
      if (page.some((item, index) => item.policyId <= (index === 0 ? afterPolicyId ?? '' : page[index - 1]!.policyId))) {
        this.publish({ ...this.value, loading: false, notice: 'The policy page did not follow the saved ID cursor. Reload the list before continuing.' });
        return;
      }
      const merged = new Map((append ? this.value.policies ?? [] : this.value.policies ?? []).map((item) => [item.policyId, item]));
      for (const item of page) {
        const existing = merged.get(item.policyId);
        if (!existing || item.revision > existing.revision) merged.set(item.policyId, item);
      }
      const policies = Object.freeze([...merged.values()].sort((a, b) => a.policyId.localeCompare(b.policyId)));
      const reloadRequiredPolicies = (this.value.reloadRequiredPolicies ?? []).filter((requirement) =>
        !page.some((item) => item.policyId === requirement.policyId && item.revision >= requirement.minimumRevision));
      const nextAfterPolicyId = page.length === PAGE_SIZE ? page[page.length - 1]?.policyId : undefined;
      this.publish({ ...this.value, policies, reloadRequiredPolicies: Object.freeze(reloadRequiredPolicies), nextAfterPolicyId, loaded: true, loading: false,
        notice: page.length ? undefined : append ? 'No more saved policies.' : 'No saved background policies yet.' });
    } catch (error) {
      if (this.isOwner(owner)) this.publish({ ...this.value, loading: false, notice: error instanceof WorkspaceClientError ? error.message : 'Could not load background policies.' });
      else if (this.active && generation === this.generation) this.publish({ ...this.value, loading: false,
        notice: 'The workspace changed while policies were loading. Reload the current policy list.' });
    }
  }

  async saveDraft(enabled: boolean): Promise<void> {
    const draft = this.value.draft;
    const snapshot = this.port.readSnapshot();
    if (!draft || !snapshot) return;
    const intervalMinutes = Number(draft.intervalMinutes);
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440 || !draft.accounts.length || !draft.resources.length) {
      this.publish({ ...this.value, notice: 'Choose at least one connected account and resource, and a cadence from 1 to 1,440 minutes.' });
      return;
    }
    if (draft.policyId) {
      if (this.value.reloadRequiredPolicies?.some((item) => item.policyId === draft.policyId)) {
        this.publish({ ...this.value, notice: 'Reload this saved policy before saving another revision.' });
        return;
      }
      const current = this.value.policies?.find((item) => item.policyId === draft.policyId);
      if (!current || current.revision !== draft.expectedPolicyRevision || current.status === 'revoked') {
        this.publish({ ...this.value, notice: 'This saved policy changed or was revoked. Reload it before editing.' });
        return;
      }
    }
    const required = draft.resources.map((resource) => resource === 'mail' ? 'mail.read' : 'calendar.read');
    const accountSelections = draft.accounts.map((selection) => {
      const account = snapshot.state.accounts.find((item) => item.id === selection.accountId);
      if (!account || !account.connected || account.authStatus !== 'connected' || account.connectionGeneration !== selection.expectedConnectionGeneration ||
          (account.provider !== 'google' && account.provider !== 'microsoft') || required.some((capability) => !account.capabilities?.includes(capability))) return undefined;
      return selection;
    });
    if (accountSelections.some((item) => !item)) {
      this.publish({ ...this.value, notice: 'A selected account changed or lost a required permission. Reselect it to review the current connection before saving.' });
      return;
    }
    const policyId = draft.policyId ?? createWorkspaceCommandId();
    const commandId = createWorkspaceCommandId();
    const request: SaveBackgroundPolicyEnvelope = Object.freeze({ commandId, expectedPrivacyEpoch: snapshot.privacyEpoch, policyId,
      expectedPolicyRevision: draft.expectedPolicyRevision, enabled,
      specification: Object.freeze({ kind: 'account_sync', accounts: Object.freeze(accountSelections as BackgroundAccountSelection[]),
        resources: Object.freeze([...draft.resources]), intervalMinutes }) });
    await this.runMutation({ commandId, route: 'save', operation: 'save', policyId, expectedPolicyRevision: draft.expectedPolicyRevision,
      expectedStatus: enabled ? 'enabled' : 'paused', epoch: snapshot.privacyEpoch, request });
  }

  async pausePolicy(policyId: string): Promise<void> {
    await this.changePolicy('pause', policyId);
  }

  async revokePolicy(policyId: string): Promise<void> {
    await this.changePolicy('revoke', policyId);
  }

  private async changePolicy(operation: 'pause' | 'revoke', policyId: string): Promise<void> {
    if (this.value.reloadRequiredPolicies?.some((item) => item.policyId === policyId)) {
      this.publish({ ...this.value, notice: 'Reload this saved policy before changing its current revision.' });
      return;
    }
    const policy = this.value.policies?.find((item) => item.policyId === policyId);
    const snapshot = this.port.readSnapshot();
    if (!policy || policy.specification.kind !== 'account_sync' || !snapshot || policy.status === 'revoked' ||
        (operation === 'pause' && policy.status === 'paused')) return;
    const request: ChangeBackgroundPolicyEnvelope = Object.freeze({ commandId: createWorkspaceCommandId(), expectedPrivacyEpoch: snapshot.privacyEpoch,
      policyId, expectedPolicyRevision: policy.revision });
    await this.runMutation({ commandId: request.commandId, route: operation, operation, policyId, expectedPolicyRevision: policy.revision,
      expectedStatus: operation === 'pause' ? 'paused' : 'revoked', epoch: snapshot.privacyEpoch, request });
  }

  private async runMutation(input: Omit<HeldBackgroundPolicyCommand, 'canonicalRequest'>): Promise<void> {
    if (!this.operationReady()) {
      this.publish({ ...this.value, notice: 'Resolve the current workspace operation or inspect the held policy request before continuing.' });
      return;
    }
    const owner = this.owner();
    if (input.epoch !== owner.privacyEpoch || input.request.expectedPrivacyEpoch !== owner.privacyEpoch) {
      this.publish({ ...this.value, notice: 'The workspace changed before this policy request could be sent.' });
      return;
    }
    const held: HeldBackgroundPolicyCommand = Object.freeze({ ...input, canonicalRequest: canonicalBackgroundJson(input.request),
      ...(input.route === 'save' && this.value.draft ? { draftGeneration: this.draftGeneration, draftAtSubmission: this.value.draft } : {}) });
    this.publish({ ...this.value, heldCommand: held, notice: 'Policy request sent with this exact ID. Inspect its receipt if the result is uncertain; it will not be retried.' });
    try {
      const receipt = input.route === 'save' ? await this.port.save(input.request as SaveBackgroundPolicyEnvelope)
        : input.route === 'pause' ? await this.port.pause(input.request as ChangeBackgroundPolicyEnvelope)
          : await this.port.revoke(input.request as ChangeBackgroundPolicyEnvelope);
      if (!this.isOwner(owner)) return;
      if (!this.receiptMatches(held, receipt)) {
        this.publish({ ...this.value, notice: 'The policy response did not match the exact request. Inspect the original receipt before continuing.' });
        return;
      }
      this.settleReceipt(held, receipt, `Policy ${receipt.status}. Reload the list to verify its saved details.`);
    } catch (error) {
      if (!this.isOwner(owner)) return;
      if (error instanceof WorkspaceCommandNotStartedError) {
        const { heldCommand: _held, ...withoutHeld } = this.value;
        void _held;
        this.publish({ ...withoutHeld, notice: error.message });
      } else {
        this.publish({ ...this.value, notice: error instanceof WorkspaceCommandUnknownError
          ? 'The policy result is uncertain. Inspect the original receipt; do not submit it again.'
          : 'The policy result could not be confirmed. Inspect the original receipt; do not submit it again.' });
      }
    }
  }

  private receiptMatches(command: HeldBackgroundPolicyCommand, receipt: BackgroundPolicyReceipt): boolean {
    return receipt.commandId === command.commandId && receipt.operation === command.operation && receipt.policyId === command.policyId &&
      receipt.policyRevision === command.expectedPolicyRevision + 1 && receipt.status === command.expectedStatus;
  }

  private sameDraft(left: BackgroundSyncDraft, right: BackgroundSyncDraft): boolean {
    return left.policyId === right.policyId && left.expectedPolicyRevision === right.expectedPolicyRevision && left.intervalMinutes === right.intervalMinutes &&
      left.resources.length === right.resources.length && left.resources.every((resource, index) => resource === right.resources[index]) &&
      left.accounts.length === right.accounts.length && left.accounts.every((selection, index) => selection.accountId === right.accounts[index]?.accountId &&
        selection.expectedConnectionGeneration === right.accounts[index]?.expectedConnectionGeneration);
  }

  private settleReceipt(command: HeldBackgroundPolicyCommand, receipt: BackgroundPolicyReceipt, notice: string): void {
    const requirements = new Map((this.value.reloadRequiredPolicies ?? []).map((item) => [item.policyId, item.minimumRevision]));
    requirements.set(receipt.policyId, Math.max(requirements.get(receipt.policyId) ?? 0, receipt.policyRevision));
    const reloadRequiredPolicies = [...requirements].filter(([policyId, revision]) =>
      !this.value.policies?.some((policy) => policy.policyId === policyId && policy.revision >= revision))
      .map(([policyId, minimumRevision]) => Object.freeze({ policyId, minimumRevision }));

    let draft = this.value.draft;
    if (command.operation === 'save' && command.draftAtSubmission && command.draftGeneration === this.draftGeneration && draft) {
      if (this.sameDraft(draft, command.draftAtSubmission)) draft = undefined;
      else if (draft.expectedPolicyRevision === command.expectedPolicyRevision && (!draft.policyId || draft.policyId === command.policyId)) {
        draft = Object.freeze({ ...draft, policyId: receipt.policyId, expectedPolicyRevision: receipt.policyRevision, dirty: true });
      }
    }
    const { heldCommand: _held, draft: _previousDraft, ...settled } = this.value;
    void _held; void _previousDraft;
    this.publish({ ...settled, ...(draft ? { draft } : {}), reloadRequiredPolicies: Object.freeze(reloadRequiredPolicies), lastReceipt: receipt, notice });
  }

  async inspectHeldCommand(): Promise<void> {
    const held = this.value.heldCommand;
    if (!held || !this.operationReady(true)) return;
    const owner = this.owner();
    try {
      const receipt = await this.port.inspect(held.commandId, held.epoch);
      if (!this.isOwner(owner)) return;
      if (!receipt) {
        this.publish({ ...this.value, notice: 'No receipt is available for the original policy ID. It remains held and will not be retried.' });
        return;
      }
      if (!this.receiptMatches(held, receipt)) {
        this.publish({ ...this.value, notice: 'The inspected receipt does not match the original policy request. It remains held for review.' });
        return;
      }
      this.settleReceipt(held, receipt, `The exact policy receipt confirms ${receipt.status}. Reload the list to verify its saved details.`);
    } catch (error) {
      if (this.isOwner(owner)) this.publish({ ...this.value,
        notice: error instanceof WorkspaceClientError ? error.message : 'The original policy receipt could not be checked. The request remains held.' });
    }
  }

  dispose(): void {
    this.active = false;
    this.generation += 1;
    this.value = Object.freeze({});
    this.listeners.clear();
  }
}
