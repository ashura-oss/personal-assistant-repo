import type { AppState } from "../core";
import { createDispatchRecord, recordDispatchOutcome } from "../dispatch";
import { AzureOpenAIClient, AzureSpeechClient } from "../services/azure";
import { AppControllerImpl } from "../services/controller";
import type { StateStore } from "../storage/contracts";

class MemoryStateStore implements StateStore {
  private value?: AppState;

  async load() {
    return this.value ? structuredClone(this.value) : undefined;
  }

  async save(state: AppState) {
    this.value = structuredClone(state);
  }

  async clear() {
    this.value = undefined;
  }
}

const blockedFetch: typeof fetch = async () => {
  throw new Error("Network access is disabled in the sample history scenario.");
};

const blockedKey = async (): Promise<string | null> => {
  throw new Error(
    "Provider credentials are unavailable in the sample history scenario.",
  );
};

/** Creates a disposable in-memory UI scenario; it never uses the app's persistent store. */
export async function createDispatchHistoryScenario() {
  const store = new MemoryStateStore();
  const app = new AppControllerImpl(store, {
    speech: new AzureSpeechClient({
      fetcher: blockedFetch,
      readKey: blockedKey,
    }),
    openAi: new AzureOpenAIClient(blockedFetch, blockedKey),
  });
  await app.load();

  const note = await app.saveNote({
    transcript:
      'Send an email to alex@example.invalid with the subject "Sample status check" and say this is a synthetic receipt for local UI review only.',
  });
  const [emailDraft] = await app.processNote(note.id);
  if (!emailDraft || emailDraft.kind !== "email") {
    throw new Error(
      "The sample scenario could not create its local email draft.",
    );
  }

  const configuredAccount = await app.saveAccount({
    provider: "google",
    displayName: "Sample account before dispatch",
    email: "sender-before@example.invalid",
  });
  const edited = await app.editProposal(emailDraft.id, {
    title: "Sample status check",
    body: "This message exists only in an in-memory UI scenario.",
    accountId: configuredAccount.id,
    recipients: ["alex@example.invalid"],
    email: {
      operation: "send",
      to: ["alex@example.invalid"],
      cc: ["copy@example.invalid"],
      bcc: [],
      subject: "Sample status check",
      text: "This message exists only in an in-memory UI scenario.",
      attachments: [],
    },
  });
  const approved = await app.approveProposal(edited.id);

  // A temporary synthetic identity is used only to exercise the real snapshot validator.
  const syntheticConnectedAccount = {
    ...configuredAccount,
    displayName: "Frozen sender label",
    email: "sender-at-dispatch@example.invalid",
    connected: true,
    authStatus: "connected" as const,
    identity: {
      providerNamespace: "google" as const,
      clientId: "sample-public-client.invalid",
      subject: "synthetic-provider-subject-only",
    },
    tokenRef: "sample-not-a-credential",
  };
  const dispatchStartedAt = new Date().toISOString();
  const pending = createDispatchRecord({
    id: "sample-unknown-send",
    dispatchStartedAt,
    proposal: approved,
    account: syntheticConnectedAccount,
  });
  const unknown = recordDispatchOutcome(pending, {
    outcome: "unknown",
    at: new Date(
      Math.max(Date.now(), Date.parse(dispatchStartedAt)),
    ).toISOString(),
  });

  const state = structuredClone(app.getSnapshot());
  const storedAccount = state.accounts.find(
    (account) => account.id === configuredAccount.id,
  );
  const storedProposal = state.proposals.find(
    (proposal) => proposal.id === approved.id,
  );
  if (!storedAccount || !storedProposal) {
    throw new Error("The sample scenario lost its local proposal state.");
  }
  // Deliberately change the current settings after the immutable dispatch snapshot is frozen.
  Object.assign(storedAccount, {
    displayName: "Current sample settings label",
    email: "current-settings@example.invalid",
    connected: false,
    authStatus: "configured",
    tokenRef: undefined,
    identity: undefined,
    grantedScopes: [],
    capabilities: [],
  });
  Object.assign(storedProposal, {
    status: "unknown",
    dispatchRecordId: unknown.id,
    remoteOperation: "send",
    remoteId: undefined,
    remoteAcceptedAt: undefined,
    lastError: undefined,
  });
  state.dispatchRecords = [unknown];

  // A second old-style outcome intentionally lacks an immutable snapshot.
  state.proposals.unshift({
    ...structuredClone(storedProposal),
    id: "sample-legacy-incomplete-history",
    title: "Legacy sample action · snapshot unavailable",
    dispatchRecordId: undefined,
    dispatchHistoryIncomplete: true,
  });

  const finalStore = new MemoryStateStore();
  await finalStore.save(state);
  const finalController = new AppControllerImpl(finalStore, {
    speech: new AzureSpeechClient({
      fetcher: blockedFetch,
      readKey: blockedKey,
    }),
    openAi: new AzureOpenAIClient(blockedFetch, blockedKey),
  });
  await finalController.load();

  const finalState = finalController.getSnapshot();
  const finalAccount = finalState.accounts.find(
    (account) => account.id === configuredAccount.id,
  );
  const frozenRecord = finalState.dispatchRecords.find(
    (record) => record.id === unknown.id,
  );
  if (
    finalAccount?.connected ||
    finalAccount?.email !== "current-settings@example.invalid" ||
    frozenRecord?.outcome !== "unknown" ||
    frozenRecord.account.email !== "sender-at-dispatch@example.invalid"
  ) {
    throw new Error(
      "The sample receipt did not preserve its frozen sender snapshot.",
    );
  }

  return finalController;
}
