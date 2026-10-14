import { randomUUID } from 'node:crypto';
import { AuthService } from './auth.js';
import { ServerCredentialCommandService } from './credentialCommands.js';
import { deriveAuthSecret, ensurePrivateDirectory, loadOrCreateVaultRootKey, type ServerConfig } from './config.js';
import { createStillHttpServer } from './http.js';
import { createDurableKernel, type DurableKernel } from './kernel.js';
import { SecretVault } from './vault.js';
import { createInitialWorkspaceState } from './sharedControllerNode.mjs';

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
}

export interface OpenedServerFoundation {
  readonly foundation: ServerFoundation;
  readonly privateContext: PrivateServerFoundationContext;
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
  let rootKey: Buffer | undefined;
  let authSecret: Buffer | undefined;
  let kernel: DurableKernel | undefined;
  let vault: SecretVault | undefined;
  let auth: AuthService | undefined;
  let credentialCommands: ServerCredentialCommandService | undefined;
  const closeConstructed = () => {
    let firstFailure: unknown;
    for (const close of [() => auth?.close(), () => vault?.close(), () => kernel?.close()]) {
      try { close(); } catch (error) { firstFailure ??= error; }
    }
    if (firstFailure !== undefined) throw firstFailure;
  };
  try {
    rootKey = loadOrCreateVaultRootKey(config);
    authSecret = deriveAuthSecret(rootKey);
    kernel = createDurableKernel({ databasePath: config.databasePath,
      validateSnapshot: options.validateSnapshot ?? validatePhysicalWorkspaceSnapshot });
    auth = new AuthService(kernel, { canonicalOrigin: config.canonicalOrigin,
      ...(config.allowLocalHttp ? { allowLocalHttp: true } : {}), authSecret });
    vault = new SecretVault(kernel, rootKey);
    credentialCommands = new ServerCredentialCommandService(kernel, vault);
    const activeKernel = kernel;
    const activeVault = vault;
    const activeAuth = auth;
    const activeCredentialCommands = credentialCommands;
    let authClosed = false;
    let vaultClosed = false;
    let kernelClosed = false;
    const foundation: ServerFoundation = Object.freeze({
      auth: activeAuth,
      credentialCommands: activeCredentialCommands,
      initialWorkspaceSnapshot: options.initialWorkspaceSnapshot ?? createBundledInitialWorkspaceSnapshot,
      readStatus: () => Object.freeze({ enrolled: activeKernel.withTrustedDatabaseTransaction((db) =>
        Boolean(db.prepare('SELECT 1 AS present FROM auth_owner WHERE singleton=1').get())) }),
      close: () => {
        if (!authClosed) { activeAuth.close(); authClosed = true; }
        if (!vaultClosed) { activeVault.close(); vaultClosed = true; }
        if (!kernelClosed) { activeKernel.close(); kernelClosed = true; }
      },
    });
    return Object.freeze({ foundation, privateContext: Object.freeze({ kernel: activeKernel, vault: activeVault }) });
  } catch (error) {
    try { closeConstructed(); } catch { /* Preserve the construction error after attempting every cleanup. */ }
    throw error;
  } finally {
    rootKey?.fill(0);
    authSecret?.fill(0);
  }
}

/** Opens the provider-free local foundation without returning internal composition handles. */
export function openServerFoundation(config: ServerConfig, options: ServerFoundationOptions = {}): ServerFoundation {
  return openServerFoundationInternal(config, options).foundation;
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
    try { foundation.close(); } catch { /* Preserve the listener construction/bind failure. */ }
    throw error;
  }
  let closing: Promise<void> | undefined;
  return Object.freeze({ server, close: () => {
    if (closing) return closing;
    closing = new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        let cleanupError: unknown;
        try { foundation.close(); } catch (closeError) { cleanupError = closeError; }
        if (error) reject(error);
        else if (cleanupError !== undefined) reject(cleanupError);
        else resolve();
      };
      try { server.close(settle); }
      catch (error) { settle(error instanceof Error ? error : new Error('server_close_failed')); }
    });
    return closing;
  } });
}

export function parseStillPort(value: string | undefined): number {
  if (value === undefined) return 8080;
  if (!/^[0-9]{1,5}$/.test(value)) throw new TypeError('invalid_port');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('invalid_port');
  return port;
}
