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
const MOCK_OPENAI_KEY = "still-mail-preview-openai-key-not-a-credential";
const MOCK_OPENAI_ORIGIN = "https://still-preview.openai.azure.com";
const MOCK_OPENAI_DEPLOYMENT = "gpt-6-luna";
const HTML_SAMPLE_MESSAGE = '<p>Project discussion: Could you send the revised timeline by Friday?</p><p>Owners &amp; next steps:</p><ul><li>Confirm release owner</li><li>Share updated dates</li></ul><p>Image: <img alt="Roadmap preview" src="https://assets.invalid/roadmap.png"></p><p><a href="https://secret.example/path">Open project plan</a></p><p hidden>Hidden details must not appear.</p><script>window.secret = true;</script><style>.private{display:none}</style><pre><code>token=do-not-include</code></pre>';
const HTML_SAMPLE_EXPECTED_TEXT = "Project discussion: Could you send the revised timeline by Friday?\nOwners & next steps:\n• Confirm release owner\n• Share updated dates\nImage: [Image: Roadmap preview]\nOpen project plan";

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
function makeFixtureFetcher(mockGeneration: boolean): typeof fetch {
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

    if (url.origin === MOCK_OPENAI_ORIGIN) {
      if (!mockGeneration || method !== "POST" || url.pathname !== "/openai/v1/responses" || url.search !== "?api-version=v1") {
        throw new Error("The sample reply fixture rejected an unapproved OpenAI request.");
      }
      const headers = new Headers(init?.headers);
      if (headers.get("api-key") !== MOCK_OPENAI_KEY || headers.get("content-type") !== "application/json") {
        throw new Error("The sample reply fixture rejected an unexpected request credential or content type.");
      }
      const bodyText = typeof init?.body === "string" ? init.body : "";
      if (!bodyText || new TextEncoder().encode(bodyText).length > 24_000) {
        throw new Error("The sample reply fixture rejected an empty or oversized request.");
      }
      let body: any;
      try { body = JSON.parse(bodyText); } catch { throw new Error("The sample reply fixture rejected invalid JSON."); }
      const schema = body?.text?.format;
      const expectedSchema = {
        type: "json_schema",
        name: "mail_reply_body",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: { text: { type: "string" } },
        },
      };
      const input = body?.input;
      const roleNames = Array.isArray(input) ? input.map((item: any) => item?.role) : [];
      const messageShapeIsTextOnly = Array.isArray(input) && input.every((item: any) =>
        item && typeof item === "object" && Array.isArray(item.content) && item.content.length === 1 &&
        item.content[0]?.type === "input_text" && typeof item.content[0]?.text === "string",
      );
      const inputText = Array.isArray(input)
        ? input.flatMap((item: any) => Array.isArray(item?.content) ? item.content : []).map((item: any) => item?.text).filter((value: unknown) => typeof value === "string")
        : [];
      const selectedMessageMarker = "SELECTED MESSAGE (converted_html; excerpt):\n";
      const selectedMessageText = typeof inputText[1] === "string" && inputText[1].includes(selectedMessageMarker)
        ? inputText[1].slice(inputText[1].lastIndexOf(selectedMessageMarker) + selectedMessageMarker.length)
        : "";
      const inputBytes = inputText.reduce((total: number, value: string) => total + new TextEncoder().encode(value).length, 0);
      const allowedBodyKeys = ["input", "max_output_tokens", "model", "reasoning", "store", "text", "tools"];
      if (
        stableFixtureJson(Object.keys(body ?? {}).sort()) !== stableFixtureJson(allowedBodyKeys) ||
        body?.model !== MOCK_OPENAI_DEPLOYMENT || body?.store !== false ||
        !Array.isArray(body?.tools) || body.tools.length !== 0 ||
        !["none", "low"].includes(body?.reasoning?.effort) ||
        !Number.isSafeInteger(body?.max_output_tokens) || body.max_output_tokens < 1 || body.max_output_tokens > 2400 ||
        stableFixtureJson(schema) !== stableFixtureJson(expectedSchema) ||
        JSON.stringify(roleNames) !== JSON.stringify(["developer", "user"]) ||
        !messageShapeIsTextOnly || inputText.length !== 2 || inputBytes > 23_744 ||
        selectedMessageText !== HTML_SAMPLE_EXPECTED_TEXT ||
        selectedMessageText.includes("Hidden details must not appear") || selectedMessageText.includes("window.secret") ||
        selectedMessageText.includes("secret.example") || selectedMessageText.includes("token=do-not-include")
      ) {
        throw new Error("The sample reply fixture rejected a request outside the text-only reply contract.");
      }
      return jsonResponse({
        status: "completed",
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({ text: "Thanks for sharing this. I’ll review the details and follow up." }),
          }],
        }],
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    }
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
      const format = url.searchParams.get("format");
      if (format !== "metadata" && format !== "full") {
        throw new Error("The sample mail fixture rejected an unrecognized message format.");
      }
      const headers = [
        { name: "Subject", value: subject },
        { name: "From", value: "Morgan Sample <morgan@sample.invalid>" },
        { name: "To", value: "reader@sample.invalid" },
        { name: "Cc", value: "project.partner@sample.invalid" },
        { name: "Reply-To", value: "morgan-replies@sample.invalid" },
        { name: "Message-ID", value: `<${messageId}@sample.invalid>` },
      ];
      return jsonResponse({
        id: messageId,
        threadId: `thread-${messageId}`,
        historyId: "sample-history-20261013",
        sizeEstimate: 96,
        snippet:
          "Project planning message for a fictional local mailbox preview. No real mailbox was contacted.",
        internalDate: String(receivedAt),
        labelIds: unread ? ["INBOX", "UNREAD"] : ["INBOX"],
        payload: {
          mimeType: format === "full" && messageId === "sample-unread-first-page" ? "text/html" : format === "full" ? "text/plain" : "multipart/alternative",
          headers,
          ...(format === "full"
            ? { body: messageId === "sample-unread-first-page"
                ? { size: HTML_SAMPLE_MESSAGE.length, data: base64UrlAscii(HTML_SAMPLE_MESSAGE) }
                : { size: 66, data: "UHJvamVjdCBkaXNjdXNzaW9uOiBDb3VsZCB5b3Ugc2VuZCB0aGUgcmV2aXNlZCB0aW1lbGluZSBieSBGcmlkYXk_" } }
            : {}),
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

function stableFixtureJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableFixtureJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableFixtureJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function base64UrlAscii(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function equalIdentity(
  left: OAuthBridgeResult["identity"] | StoredOAuthToken["identity"],
  right: OAuthBridgeResult["identity"] | StoredOAuthToken["identity"],
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Starts the real controller and connector over memory plus a closed fixture allowlist. */
export async function createMailSyncScenario(options: { mockGeneration?: boolean } = {}) {
  assertMailPreviewEnabled();
  const mockGeneration = options.mockGeneration === true;
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
  const fixtureFetcher = makeFixtureFetcher(mockGeneration);
  const controller = new AppControllerImpl(
    store,
    {
      speech: new AzureSpeechClient({
        fetcher: blockedFetch,
        readKey: blockedKey,
      }),
      openAi: new AzureOpenAIClient(
        mockGeneration ? fixtureFetcher : blockedFetch,
        mockGeneration ? async () => MOCK_OPENAI_KEY : blockedKey,
      ),
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
  if (mockGeneration) {
    await controller.saveSettings({
      mode: "provider",
      openAiEndpoint: MOCK_OPENAI_ORIGIN,
      openAiDeployment: MOCK_OPENAI_DEPLOYMENT,
      model: "gpt-6-luna",
      reasoningEffort: "none",
    });
  }
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
