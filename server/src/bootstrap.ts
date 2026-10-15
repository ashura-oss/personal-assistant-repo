import { randomUUID } from 'node:crypto';
import { AuthService } from './auth.js';
import { ServerCredentialCommandService } from './credentialCommands.js';
import { deriveAuthSecret, ensurePrivateDirectory, loadOrCreateVaultRootKey, type ServerConfig } from './config.js';
import { createStillHttpServer } from './http.js';
import { createDurableKernel, KernelStartupCleanupError, type DurableKernel } from './kernel.js';
import { SecretVault } from './vault.js';
import { createInitialWorkspaceState } from './sharedControllerNode.mjs';
import { acquireApplicationOwnership, ApplicationOwnershipStartupCleanupError, type ApplicationOwnershipHandle } from './applicationOwnership.js';
import { drainAcceptedHttpRequests } from './httpRequestDrain.js';
import { registerApplicationStartup, type ApplicationStartup } from './applicationStartup.js';
import { reserveApplicationStartup } from './applicationOwnership.js';

export interface ServerFoundationOptions {
  readonly validateSnapshot?: (snapshot: unknown) => void;
  readonly initialWorkspaceSnapshot?: () => unknown;
}

export interface ServerFoundation {
  readonly auth: AuthService;
  readonly credentialCommands: ServerCredentialCommandService;
  readonly initialWorkspaceSnapshot: () => unknown;
  readonly readStatus: () => Readonly<{ enrolled: boolean }>;
  readonly close: () => void;
}

/** Trusted in-process composition details. This is intentionally absent from the public server index. */
export interface PrivateServerFoundationContext {
  readonly kernel: DurableKernel;
  readonly vault: SecretVault;
  readonly startup: ApplicationStartup;
  readonly processInstanceId: string;
}

export interface OpenedServerFoundation {
  readonly foundation: ServerFoundation;
  readonly privateContext: PrivateServerFoundationContext;
}

export class ServerFoundationStartupCleanupError extends Error {
  readonly #retryClose: () => void;

  constructor(retryClose: () => void) {
    super('Server foundation startup cleanup is incomplete.');
    this.name = 'ServerFoundationStartupCleanupError';
    this.#retryClose = retryClose;
  }

  retryClose(): void { this.#retryClose(); }
}

/** The physical kernel boundary: only JSON-compatible plain objects are workspace roots. */
export function validatePhysicalWorkspaceSnapshot(snapshot: unknown): void {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new TypeError('invalid_snapshot_root');
  const prototype = Object.getPrototypeOf(snapshot);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('invalid_snapshot_root');
}

function createBundledInitialWorkspaceSnapshot(): unknown {
  // Server enrollment follows the OpenRouter Batch API baseline without making a provider call.
  return createInitialWorkspaceState(randomUUID, {
    mode: 'provider',
    llmProvider: 'openrouter',
    openRouterModel: 'openai/gpt-6-luna:batch',
    openRouterReasoningEffort: 'low',
    llmRequestContractVersion: 1,
  });
}

/** Composes the durable server services without opening a listener or running background work. */
export function openServerFoundationInternal(config: ServerConfig, options: ServerFoundationOptions = {}): OpenedServerFoundation {
  ensurePrivateDirectory(config.dataDirectory);
  let applicationOwnership: ApplicationOwnershipHandle | undefined;
  let rootKey: Buffer | undefined;
  let authSecret: Buffer | undefined;
  let kernel: DurableKernel | undefined;
  let vault: SecretVault | undefined;
  let auth: AuthService | undefined;
  let credentialCommands: ServerCredentialCommandService | undefined;
  let startup: ApplicationStartup | undefined;
  let kernelStartupCleanupRetry: (() => void) | undefined;
  let kernelStartupCleanupComplete = false;
  let authClosed = false;
  let vaultClosed = false;
  let kernelClosed = false;
  let ownershipReleased = false;
  const closeConstructed = () => {
    if (startup) startup.close();
    if (auth && !authClosed) { auth.close(); authClosed = true; }
    if (vault && !vaultClosed) { vault.close(); vaultClosed = true; }
    if (kernel && !kernelClosed) { kernel.close(); kernelClosed = true; }
    if (kernelStartupCleanupRetry && !kernelStartupCleanupComplete) {
      kernelStartupCleanupRetry();
      kernelStartupCleanupComplete = true;
    }
    if (applicationOwnership && !ownershipReleased) { applicationOwnership.release(); ownershipReleased = true; }
  };
  try {
    applicationOwnership = acquireApplicationOwnership(config.databasePath);
    rootKey = loadOrCreateVaultRootKey(config);
    authSecret = deriveAuthSecret(rootKey);
    const startupReservation = reserveApplicationStartup(applicationOwnership);
    kernel = createDurableKernel({ databasePath: config.databasePath,
      validateSnapshot: options.validateSnapshot ?? validatePhysicalWorkspaceSnapshot,
      applicationOwnership, startupReservation });
    const processInstanceId = randomUUID();
    startup = registerApplicationStartup(kernel, applicationOwnership, config.databasePath, processInstanceId);
    auth = new AuthService(kernel, { canonicalOrigin: config.canonicalOrigin,
      ...(config.allowLocalHttp ? { allowLocalHttp: true } : {}), authSecret });
    vault = new SecretVault(kernel, rootKey);
    credentialCommands = new ServerCredentialCommandService(kernel, vault);
    const activeKernel = kernel;
    const activeVault = vault;
    const activeAuth = auth;
    const activeCredentialCommands = credentialCommands;
    const foundation: ServerFoundation = Object.freeze({
      auth: activeAuth,
      credentialCommands: activeCredentialCommands,
      initialWorkspaceSnapshot: options.initialWorkspaceSnapshot ?? createBundledInitialWorkspaceSnapshot,
      readStatus: () => Object.freeze({ enrolled: activeKernel.withTrustedDatabaseTransaction((db) =>
        Boolean(db.prepare('SELECT 1 AS present FROM auth_owner WHERE singleton=1').get())) }),
      close: () => {
        try { closeConstructed(); }
        catch { throw new ServerFoundationStartupCleanupError(closeConstructed); }
      },
    });
    return Object.freeze({ foundation, privateContext: Object.freeze({ kernel: activeKernel, vault: activeVault,
      startup, processInstanceId }) });
  } catch (error) {
    if (error instanceof KernelStartupCleanupError || error instanceof ApplicationOwnershipStartupCleanupError) {
      kernelStartupCleanupRetry = () => error.retryClose();
    }
    try { closeConstructed(); }
    catch { throw new ServerFoundationStartupCleanupError(closeConstructed); }
    throw error;
  } finally {
    rootKey?.fill(0);
    authSecret?.fill(0);
  }
}

/** Opens the provider-free local foundation without returning internal composition handles. */
export function openServerFoundation(config: ServerConfig, options: ServerFoundationOptions = {}): ServerFoundation {
  const opened = openServerFoundationInternal(config, options);
  opened.privateContext.startup.beginRecovery();
  opened.privateContext.startup.seal();
  return opened.foundation;
}

/** Binds only after explicit start and closes the HTTP listener before its foundation. */
export async function startStillHttp(config: ServerConfig, foundation: ServerFoundation, port: number): Promise<{
  readonly server: ReturnType<typeof createStillHttpServer>;
  readonly close: () => Promise<void>;
}> {
  let server!: ReturnType<typeof createStillHttpServer>;
  let onError: ((error: Error) => void) | undefined;
  let onListening: (() => void) | undefined;
  try {
    server = createStillHttpServer({ auth: foundation.auth, credentialCommands: foundation.credentialCommands,
      canonicalOrigin: config.canonicalOrigin, staticRoot: config.staticRoot,
      ...(config.allowLocalHttp ? { allowLocalHttp: true } : {}) });
    const activeServer = server;
    await new Promise<void>((resolve, reject) => {
      onError = (error) => { activeServer.off('listening', onListening!); reject(error); };
      onListening = () => { activeServer.off('error', onError!); resolve(); };
      activeServer.once('error', onError);
      activeServer.once('listening', onListening);
      try { activeServer.listen(port, config.host); }
      catch (error) {
        activeServer.off('error', onError!);
        activeServer.off('listening', onListening!);
        reject(error);
      }
    });
  } catch (error) {
    if (server) {
      if (onError) server.off('error', onError);
      if (onListening) server.off('listening', onListening);
    }
    try { foundation.close(); } catch (cleanupError) { throw cleanupError; }
    throw error;
  }
  let closing: Promise<void> | undefined;
  let listenerStopped = false;
  let foundationClosed = false;
  return Object.freeze({ server, close: () => {
    if (foundationClosed) return Promise.resolve();
    if (closing) return closing;
    const attempt = (async () => {
      if (!listenerStopped) {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            try { server.close((error) => error ? reject(error) : resolve()); }
            catch (error) { reject(error); }
          });
        }
        await drainAcceptedHttpRequests(server);
        if (server.listening) throw new Error('application_listener_still_accepting');
        listenerStopped = true;
      }
      if (!foundationClosed) { foundation.close(); foundationClosed = true; }
    })();
    closing = attempt;
    void attempt.catch(() => { if (closing === attempt) closing = undefined; });
    return attempt;
  } });
}

export function parseStillPort(value: string | undefined): number {
  if (value === undefined) return 8080;
  if (!/^[0-9]{1,5}$/.test(value)) throw new TypeError('invalid_port');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('invalid_port');
  return port;
}
