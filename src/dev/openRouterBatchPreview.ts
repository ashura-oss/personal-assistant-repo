import { Platform } from 'react-native';
import type { AppState } from '../core';
import type { ControllerIntegrationDependencies } from '../services/controller';
import { AzureOpenAIClient, AzureSpeechClient } from '../services/azure';
import {
  OPENROUTER_BATCH_BODY_MODEL,
  OPENROUTER_BATCH_ENDPOINT,
  OPENROUTER_BATCH_COMPLETION_WINDOW,
  OPENROUTER_CHAT_COMPLETIONS_PATH,
  OpenRouterBatchClient,
} from '../services/openRouter';
import type { StateStore } from '../storage/contracts';
import type { ProviderCredentialService } from '../services/credentials';
import type { NotificationBackend } from '../services/notificationBackend';
import type { DeviceCalendarBackend } from '../services/deviceCalendarBackend';
import type { MailAlertNotificationBackend } from '../services/mailAlertNotificationBackend';
import type { MailAlertTapBackend } from '../proactiveMailAlerts/taps';
import type { BackgroundTaskBackend } from '../background/backend.types';
import type { RecordingRecoveryService } from '../audio/recovery.types';
import type { SpeechAudioService } from '../audio/speechUpload.types';

function assertPreviewEnabled(scenario: 'openrouter-batch' | 'openrouter-chat' = 'openrouter-batch') {
  if (typeof __DEV__ === 'undefined' || !__DEV__ || Platform.OS !== 'web' ||
      process.env.EXPO_PUBLIC_PREVIEW_SCENARIO !== scenario) {
    throw new Error('The Batch sample is available only in its isolated development browser scenario.');
  }
}

const sampleOnlyError = () => new Error('External services are disabled in this sample.');
const denyNetwork: typeof fetch = async () => { throw sampleOnlyError(); };

class MemoryStore implements StateStore {
  private state?: AppState;
  async load() { return this.state ? structuredClone(this.state) : undefined; }
  async save(state: AppState) { this.state = structuredClone(state); }
  async clear() { this.state = undefined; }
}

const closedCredentials: ProviderCredentialService = {
  currentSpeechCredentialGeneration: () => 0,
  assertSpeechCredentialGeneration: () => { throw sampleOnlyError(); },
  async readSpeechCredentialSnapshot() { return { key: null, generation: 0 }; },
  currentProviderCredentialGeneration: () => 0,
  assertProviderCredentialGeneration: () => { throw sampleOnlyError(); },
  async readProviderCredentialSnapshot() { return { key: null, generation: 0 }; },
  async getCredentials() { return { speechConfigured: false, openAiConfigured: false, openRouterConfigured: false }; },
  async readProviderCredential() { return null; },
  async setCredentials() { throw sampleOnlyError(); },
  async deleteCredentials() { throw sampleOnlyError(); },
};

const closedNotifications: NotificationBackend = {
  platform: 'web',
  async getPermission() { return 'unavailable'; },
  async requestPermission() { return 'unavailable'; },
  async listPending() { return []; },
  async schedule() { throw sampleOnlyError(); },
  async cancel() {},
  async cancelLegacy() {},
  async installForegroundHandler() {},
};
const closedDeviceCalendars: DeviceCalendarBackend = {
  platform: 'web',
  async getPermission() { return 'unavailable'; },
  async requestFullPermission() { return 'unavailable'; },
  async listCalendars() { throw sampleOnlyError(); },
  async getCalendar() { throw sampleOnlyError(); },
  async readEvents() { throw sampleOnlyError(); },
  async createApprovedEvent() { throw sampleOnlyError(); },
  async lookupRecord() { throw sampleOnlyError(); },
};
const closedMailAlerts: MailAlertNotificationBackend = {
  platform: 'web',
  async getPermission() { return 'unavailable'; },
  async requestPermission() { return 'unavailable'; },
  async present() { return 'not_admitted'; },
  async cancel() { return 'not_admitted'; },
};
const closedMailAlertTaps: MailAlertTapBackend = {
  async subscribe() { return { remove() {} }; },
  async getLastResponse() { return undefined; },
};
const closedBackgroundTasks: BackgroundTaskBackend = {
  async getStatus() { return { platform: 'web', state: 'unsupported', registered: false, message: 'External services are disabled in this sample.' }; },
  async isRegistered() { return false; },
  async register() { throw sampleOnlyError(); },
  async unregister() { throw sampleOnlyError(); },
  async addExpirationListener() { return { remove() {} }; },
};
const closedRecordingRecovery: RecordingRecoveryService = {
  async pickAndStage() { throw sampleOnlyError(); },
  async inspect() { throw sampleOnlyError(); },
  async remove() { throw sampleOnlyError(); },
};
const closedSpeechAudio: SpeechAudioService = {
  async prepare() { throw sampleOnlyError(); },
  async verify() { throw sampleOnlyError(); },
  async release() { throw sampleOnlyError(); },
  disposeMemory() {},
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeSampleBatchClient(maxRequests = 1) {
  const jobs = new Map<string, { customId: string; inspectionCount: number }>();
  const customIds = new Set<string>();
  const submittedMessages: unknown[][] = [];
  let postCount = 0;
  let getCount = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === OPENROUTER_BATCH_ENDPOINT && method === 'POST') {
      const payload = JSON.parse(String(init?.body)) as { requests?: { custom_id?: string; body?: { messages?: unknown[] } }[] };
      const customId = payload.requests?.[0]?.custom_id ?? '';
      if (postCount >= maxRequests || !customId || customIds.has(customId) || payload.requests?.length !== 1) throw sampleOnlyError();
      postCount += 1;
      customIds.add(customId);
      submittedMessages.push(payload.requests?.[0]?.body?.messages ?? []);
      const batchId = `sample_batch_${String(postCount).padStart(3, '0')}`;
      jobs.set(batchId, { customId, inspectionCount: 0 });
      return jsonResponse({
        id: batchId,
        object: 'batch',
        endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
        model: OPENROUTER_BATCH_BODY_MODEL,
        completion_window: OPENROUTER_BATCH_COMPLETION_WINDOW,
        status: 'validating',
        request_counts: { total: 1, completed: 0, failed: 0 },
      }, 202);
    }
    const batchPrefix = `${OPENROUTER_BATCH_ENDPOINT}/`;
    if (url.startsWith(batchPrefix) && method === 'GET') {
      const batchId = decodeURIComponent(url.slice(batchPrefix.length));
      const job = jobs.get(batchId);
      if (!job) throw sampleOnlyError();
      getCount += 1;
      job.inspectionCount += 1;
      const common = {
        id: batchId,
        object: 'batch',
        endpoint: OPENROUTER_CHAT_COMPLETIONS_PATH,
        model: OPENROUTER_BATCH_BODY_MODEL,
        completion_window: OPENROUTER_BATCH_COMPLETION_WINDOW,
      };
      if (job.inspectionCount === 1) {
        return jsonResponse({ ...common, status: 'in_progress', request_counts: { total: 1, completed: 0, failed: 0 } }, 200);
      }
      const content = JSON.stringify({
        summary: 'A fictional note summary.',
        answer: 'This is a simulated Batch reply.',
        decisions: [], citations: [], clarifications: [], proposals: [], memorySuggestions: [],
      });
      return jsonResponse({
        ...common,
        status: 'completed',
        request_counts: { total: 1, completed: 1, failed: 0 },
        results: [{ custom_id: job.customId, response: { status_code: 200, body: {
          model: OPENROUTER_BATCH_BODY_MODEL,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        } } }],
        usage: { cost: 0, is_byok: true, prompt_tokens: 41, completion_tokens: 12, total_tokens: 53 },
      }, 200);
    }
    throw sampleOnlyError();
  };
  const client = new OpenRouterBatchClient({
    fetcher,
    withRequestOwnership: (actual) => actual(),
    readCredentialSnapshot: async () => ({ key: 'SAMPLE_ONLY_FAKE_KEY', generation: 0 }),
    assertCredentialGeneration: () => undefined,
    assertBeforeStart: () => undefined,
  });
  return {
    client,
    getMetrics: () => ({ postCount, getCount }),
    getSubmittedMessages: () => submittedMessages.map((messages) => structuredClone(messages)),
  };
}

/** Uses the real controller ledger with a volatile store and a deterministic in-process transport. */
export async function createOpenRouterBatchPreview() {
  assertPreviewEnabled('openrouter-batch');
  return createPreviewWorkspace(1, true);
}

/** Closed multi-turn fixture for Chat. Each distinct local request may be submitted once. */
export async function createOpenRouterChatPreview() {
  assertPreviewEnabled('openrouter-chat');
  return createPreviewWorkspace(4, false);
}

async function createPreviewWorkspace(maxRequests: number, seedNote: boolean) {
  const { AppControllerImpl } = await import('../services/controller');
  const batch = makeSampleBatchClient(maxRequests);
  const controller = new AppControllerImpl(new MemoryStore(), {
    speech: new AzureSpeechClient({ fetcher: denyNetwork, readKey: async () => null }),
    openAi: new AzureOpenAIClient(denyNetwork, async () => null),
  }, {
    credentials: closedCredentials,
    writeDocument: async () => undefined,
    removeAudio: async () => { throw sampleOnlyError(); },
    tokenStore: { async get() { return null; }, async set() { throw sampleOnlyError(); }, async delete() { throw sampleOnlyError(); } },
    deleteToken: async () => { throw sampleOnlyError(); },
    verifyOAuthResult: async () => false,
    connectorFactory: undefined,
    reminderBackend: closedNotifications,
    deviceCalendarBackend: closedDeviceCalendars,
    mailAlertBackend: closedMailAlerts,
    mailAlertTapBackend: closedMailAlertTaps,
    backgroundTasks: closedBackgroundTasks,
    recordingRecovery: closedRecordingRecovery,
    speechAudioService: closedSpeechAudio,
    openRouterBatchClient: batch.client,
  } satisfies ControllerIntegrationDependencies);
  await controller.load();
  await controller.saveSettings({
    mode: 'provider',
    timezone: 'Asia/Singapore',
    llmProvider: 'openrouter',
    openRouterModel: 'openai/gpt-6-luna:batch',
    openRouterReasoningEffort: 'low',
  });
  if (seedNote) {
    await controller.saveNote({
      transcript: 'Fictional sample note: prepare a short review of the launch timeline next week.',
      capturedAt: '2026-10-13T09:00:00.000Z',
      captureTimeZone: 'Asia/Singapore',
    });
  }
  return {
    controller,
    getMetrics: batch.getMetrics,
    getSubmittedMessages: batch.getSubmittedMessages,
  };
}
