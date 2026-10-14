import type { DurableKernel, OwnedTransactionContext, OwnedWorkspaceIdentity } from './kernel.js';
import type { SecretVault, VaultPurpose } from './vault.js';

export type ServerProviderCredentialKind = 'speech' | 'openai' | 'openrouter';

export interface ProviderCredentialSnapshot {
  readonly key: string | null;
  readonly generation: number;
}

export interface ProviderCredentialStatus {
  readonly speechConfigured: boolean;
  readonly openAiConfigured: boolean;
  readonly openRouterConfigured?: boolean;
}

export interface ProviderCredentialInput {
  readonly speechSubscriptionKey?: string;
  readonly openAiApiKey?: string;
  readonly openRouterApiKey?: string;
}

export type ServerProviderCredentialBinding = Pick<OwnedWorkspaceIdentity, 'workspaceId' | 'ownerId' | 'privacyEpoch'>;

export class ServerProviderCredentialError extends Error {
  constructor(readonly code: 'invalid_binding' | 'generation_changed' | 'mutation_not_supported') {
    const messages = {
      invalid_binding: 'The provider credential runtime binding is invalid.',
      generation_changed: 'The provider credential changed while the request was being prepared.',
      mutation_not_supported: 'Use the trusted credential command service to update provider credentials.',
    } as const;
    super(messages[code]);
    this.name = 'ServerProviderCredentialError';
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PURPOSE_BY_KIND: Partial<Record<ServerProviderCredentialKind, VaultPurpose>> = {
  speech: 'azureSpeech',
  openrouter: 'openrouter',
};

function validateBinding(value: ServerProviderCredentialBinding): ServerProviderCredentialBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    !UUID_V4.test(value.workspaceId) || !UUID_V4.test(value.ownerId) ||
    !Number.isSafeInteger(value.privacyEpoch) || value.privacyEpoch < 0) {
    throw new ServerProviderCredentialError('invalid_binding');
  }
  return Object.freeze({ workspaceId: value.workspaceId, ownerId: value.ownerId, privacyEpoch: value.privacyEpoch });
}

function validKind(kind: ServerProviderCredentialKind): asserts kind is ServerProviderCredentialKind {
  if (kind !== 'speech' && kind !== 'openai' && kind !== 'openrouter') {
    throw new ServerProviderCredentialError('invalid_binding');
  }
}

/** Trusted Node-only provider credential reads. All key material stays inside this service call. */
export class ServerProviderCredentialService {
  readonly #actorToken: string;
  readonly #binding: ServerProviderCredentialBinding;

  constructor(private readonly kernel: DurableKernel, private readonly vault: SecretVault,
    actorToken: string, binding: ServerProviderCredentialBinding) {
    if (typeof actorToken !== 'string' || actorToken.length === 0) throw new ServerProviderCredentialError('invalid_binding');
    this.#actorToken = actorToken;
    this.#binding = validateBinding(binding);
    this.withBinding((context) => {
      // Reading metadata through the supplied vault also proves it shares this kernel connection.
      this.vault.getMetadataWithinTransaction(context, { type: 'workspace' }, 'azureSpeech');
      this.vault.getMetadataWithinTransaction(context, { type: 'workspace' }, 'openrouter');
    });
  }

  currentSpeechCredentialGeneration(): number {
    return this.generation('speech');
  }

  assertSpeechCredentialGeneration(expected: number): void {
    this.assertGeneration('speech', expected);
  }

  async readSpeechCredentialSnapshot(): Promise<ProviderCredentialSnapshot> {
    return this.readSnapshot('speech');
  }

  currentProviderCredentialGeneration(kind: ServerProviderCredentialKind): number {
    return this.generation(kind);
  }

  assertProviderCredentialGeneration(kind: ServerProviderCredentialKind, expected: number): void {
    this.assertGeneration(kind, expected);
  }

  async readProviderCredentialSnapshot(kind: ServerProviderCredentialKind): Promise<ProviderCredentialSnapshot> {
    return this.readSnapshot(kind);
  }

  async getCredentials(): Promise<ProviderCredentialStatus> {
    return this.withBinding((context) => {
      const speech = this.vault.getMetadataWithinTransaction(context, { type: 'workspace' }, 'azureSpeech');
      const openrouter = this.vault.getMetadataWithinTransaction(context, { type: 'workspace' }, 'openrouter');
      return Object.freeze({ speechConfigured: speech.configured, openAiConfigured: false, openRouterConfigured: openrouter.configured });
    });
  }

  async readProviderCredential(kind: ServerProviderCredentialKind): Promise<string | null> {
    return (await this.readSnapshot(kind)).key;
  }

  async setCredentials(_input: ProviderCredentialInput): Promise<ProviderCredentialStatus> {
    throw new ServerProviderCredentialError('mutation_not_supported');
  }

  async deleteCredentials(_kind?: ServerProviderCredentialKind): Promise<ProviderCredentialStatus> {
    throw new ServerProviderCredentialError('mutation_not_supported');
  }

  private generation(kind: ServerProviderCredentialKind): number {
    validKind(kind);
    if (kind === 'openai') return this.withBinding(() => 0);
    const purpose = PURPOSE_BY_KIND[kind]!;
    return this.withBinding((context) => this.vault.getMetadataWithinTransaction(context, { type: 'workspace' }, purpose).generation);
  }

  private assertGeneration(kind: ServerProviderCredentialKind, expected: number): void {
    if (!Number.isSafeInteger(expected) || expected < 0 || this.generation(kind) !== expected) {
      throw new ServerProviderCredentialError('generation_changed');
    }
  }

  private readSnapshot(kind: ServerProviderCredentialKind): ProviderCredentialSnapshot {
    validKind(kind);
    if (kind === 'openai') return this.withBinding(() => Object.freeze({ key: null, generation: 0 }));
    const purpose = PURPOSE_BY_KIND[kind]!;
    return this.withBinding((context) => {
      const metadata = this.vault.getMetadataWithinTransaction(context, { type: 'workspace' }, purpose);
      const key = metadata.configured ? this.vault.getSecretWithinTransaction(context, { type: 'workspace' }, purpose) ?? null : null;
      return Object.freeze({ key, generation: metadata.generation });
    });
  }

  private withBinding<T>(callback: (context: OwnedTransactionContext) => T): T {
    return this.kernel.withOwnedTransaction(this.#actorToken, this.#binding.privacyEpoch, (context) => {
      if (context.workspaceId !== this.#binding.workspaceId || context.ownerId !== this.#binding.ownerId ||
        context.privacyEpoch !== this.#binding.privacyEpoch) {
        throw new ServerProviderCredentialError('invalid_binding');
      }
      return callback(context);
    });
  }
}
