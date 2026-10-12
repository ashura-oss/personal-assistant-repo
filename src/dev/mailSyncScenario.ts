import type { AppState, OAuthInstallResult } from "../core";
import type {
  OAuthBridgeResult,
  OAuthTokenStore,
  StoredOAuthToken,
} from "../connectors";
import { ConnectorClient } from "../connectors";
import { AzureOpenAIClient, AzureSpeechClient } from "../services/azure";
import { AppControllerImpl } from "../services/controller";
import type { StateStore } from "../storage/contracts";

const PREVIEW_CLIENT_ID = "still-mail-preview-client.invalid";
const PREVIEW_ACCESS_TOKEN = "still-mail-preview-token-not-a-credential";
const PREVIEW_SUBJECT = "still-mail-preview-subject";
const PREVIEW_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

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

function assertMailPreviewEnabled() {
  if (
    typeof __DEV__ === "undefined" ||
    !__DEV__ ||
    process.env.EXPO_PUBLIC_PREVIEW_SCENARIO !== "mail-sync"
  ) {
    throw new Error(
      "The sample mail scenario is available only in its development preview.",
    );
  }
}

const blockedFetch: typeof fetch = async () => {
  throw new Error(
    "Network access is disabled outside the sample mail fixture allowlist.",
  );
};

const blockedKey = async (): Promise<string | null> => {
  throw new Error(
    "Provider credentials are unavailable in the sample mail preview.",
  );
};

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A narrow read-only fixture: every other URL, method, or credential is rejected. */
function makeFixtureFetcher(): typeof fetch {
  let firstPages = 0;
  const baseDate = Date.now();
  const allowedMessageIds = new Set([
    "sample-unread-first-page",
    "sample-older-first-page",
    "sample-newer-head-page",
    "sample-older-second-page",
  ]);

  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const authorization = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    ).get("authorization");
    if (
      method !== "GET" ||
      authorization !== `Bearer ${PREVIEW_ACCESS_TOKEN}`
    ) {
      throw new Error(
        "The sample mail fixture rejected an unexpected method or token.",
      );
    }

    if (
      url.origin === "https://openidconnect.googleapis.com" &&
      url.pathname === "/v1/userinfo"
    ) {
      return jsonResponse({ sub: PREVIEW_SUBJECT });
    }

    if (url.origin !== "https://gmail.googleapis.com") {
      throw new Error(
        "The sample mail fixture rejected an unapproved provider endpoint.",
      );
    }

    if (/^\/gmail\/v1\/users\/me\/messages\/[^/]+$/.test(url.pathname)) {
      const messageId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      if (!allowedMessageIds.has(messageId)) {
        throw new Error(
          "The sample mail fixture rejected an unknown message identifier.",
        );
      }
      const receivedAt =
        baseDate - (messageId.includes("older") ? 8 : 1) * 60 * 60 * 1000;
      const unread = messageId === "sample-unread-first-page";
      const subject =
        messageId === "sample-unread-first-page"
          ? "A note for your afternoon"
          : messageId === "sample-newer-head-page"
            ? "Weekly project update"
            : `Archived sample message ${messageId.includes("second") ? "B" : "A"}`;
      return jsonResponse({
        id: messageId,
        threadId: `thread-${messageId}`,
        snippet:
          "Project planning message for a fictional local mailbox preview. No real mailbox was contacted.",
        internalDate: String(receivedAt),
        labelIds: unread ? ["INBOX", "UNREAD"] : ["INBOX"],
        payload: {
          headers: [
            { name: "Subject", value: subject },
            { name: "From", value: "Morgan Sample <morgan@sample.invalid>" },
            { name: "To", value: "reader@sample.invalid" },
            { name: "Message-ID", value: `<${messageId}@sample.invalid>` },
          ],
        },
      });
    }

    if (url.pathname !== "/gmail/v1/users/me/messages") {
      throw new Error(
        "The sample mail fixture rejected an unapproved provider endpoint.",
      );
    }

    const pageToken = url.searchParams.get("pageToken");
    let id: string;
    let nextPageToken: string | undefined;
    if (pageToken === "still-preview-backfill-next") {
      id = "sample-older-second-page";
    } else if (
      pageToken === "still-preview-head-next" ||
      pageToken === "still-preview-newer-head-next"
    ) {
      id = "sample-newer-head-page";
    } else if (pageToken) {
      throw new Error("The sample mail fixture rejected an unknown cursor.");
    } else {
      const pageIndex = firstPages++;
      if (pageIndex === 0) {
        id = "sample-unread-first-page";
        nextPageToken = "still-preview-head-next";
      } else if (pageIndex === 1) {
        id = "sample-older-first-page";
        nextPageToken = "still-preview-backfill-next";
      } else {
        id = "sample-newer-head-page";
        nextPageToken = "still-preview-newer-head-next";
      }
    }

    if (url.searchParams.has("maxResults") && url.searchParams.has("q")) {
      return jsonResponse({
        messages: [{ id }],
        ...(nextPageToken ? { nextPageToken } : {}),
      });
    }

    if (pageToken) {
      throw new Error(
        "The sample mail fixture rejected an unrecognized message cursor.",
      );
    }
    throw new Error(
      "The sample mail fixture rejected an unrecognized mail request.",
    );
  };
}

function equalIdentity(
  left: OAuthBridgeResult["identity"] | StoredOAuthToken["identity"],
  right: OAuthBridgeResult["identity"] | StoredOAuthToken["identity"],
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Starts the real controller and connector over memory plus a closed fixture allowlist. */
export async function createMailSyncScenario() {
  assertMailPreviewEnabled();
  const store = new MemoryStateStore();
  const identity: NonNullable<OAuthInstallResult["identity"]> = {
    providerNamespace: "google",
    clientId: PREVIEW_CLIENT_ID,
    subject: PREVIEW_SUBJECT,
  };
  const installedResult: OAuthInstallResult = {
    provider: "google",
    accessToken: PREVIEW_ACCESS_TOKEN,
    expiresAt: Date.now() + 60 * 60 * 1000,
    grantedScopes: [PREVIEW_SCOPE],
    requestedCapabilities: ["mail.read"],
    capabilities: ["mail.read"],
    identity,
    displayName: "Sample reader",
    email: "reader@sample.invalid",
  };
  const tokenMap = new Map<string, StoredOAuthToken>();
  const tokenStore: OAuthTokenStore = {
    async get(tokenRef) {
      const token = tokenMap.get(tokenRef);
      return token ? structuredClone(token) : null;
    },
    async set(tokenRef, token) {
      tokenMap.set(tokenRef, structuredClone(token));
    },
  };
  const fixtureFetcher = makeFixtureFetcher();
  const controller = new AppControllerImpl(
    store,
    {
      speech: new AzureSpeechClient({
        fetcher: blockedFetch,
        readKey: blockedKey,
      }),
      openAi: new AzureOpenAIClient(blockedFetch, blockedKey),
    },
    {
      tokenStore,
      deleteToken: async (tokenRef) => {
        tokenMap.delete(tokenRef);
      },
      clientIds: { google: PREVIEW_CLIENT_ID },
      verifyOAuthResult: async (result, stored) =>
        result.provider === installedResult.provider &&
        result.accessToken === installedResult.accessToken &&
        result.expiresAt === installedResult.expiresAt &&
        JSON.stringify(result.grantedScopes) ===
          JSON.stringify(installedResult.grantedScopes) &&
        JSON.stringify(result.requestedCapabilities) ===
          JSON.stringify(installedResult.requestedCapabilities) &&
        JSON.stringify(result.capabilities) ===
          JSON.stringify(installedResult.capabilities) &&
        equalIdentity(result.identity, identity) &&
        stored.accessToken === installedResult.accessToken &&
        stored.expiresAt === installedResult.expiresAt &&
        equalIdentity(stored.identity, identity),
      connectorFactory: (storeForConnector, onAuthStatus) =>
        new ConnectorClient({
          tokenStore: storeForConnector,
          googleClientId: PREVIEW_CLIENT_ID,
          fetcher: fixtureFetcher,
          onAuthStatus,
          isConnectionCurrent: (account) =>
            account.id === "sample-mail-account" &&
            account.identity?.clientId === PREVIEW_CLIENT_ID &&
            account.identity.subject === PREVIEW_SUBJECT &&
            account.tokenRef !== undefined,
        }),
    },
  );

  await controller.load();
  await controller.installVerifiedAccount(
    {
      id: "sample-mail-account",
      provider: "google",
      displayName: "Sample reader",
      email: "reader@sample.invalid",
    },
    installedResult,
  );
  const initialHead = await controller.refreshMailHead("sample-mail-account", {
    reason: "manual",
  });
  if (initialHead.status !== "partial") {
    throw new Error(
      "The sample mail fixture did not preserve its first-page cursor.",
    );
  }
  await controller.saveProactiveRule({
    name: "Morgan's unread notes",
    enabled: true,
    accountIds: [],
    trigger: {
      type: "unread_from",
      addresses: ["morgan@sample.invalid"],
    },
  });
  await controller.saveProactiveRule({
    name: "Project mentions",
    enabled: true,
    accountIds: [],
    trigger: {
      type: "keyword",
      keywords: ["project"],
      unreadOnly: false,
    },
  });
  return controller;
}
