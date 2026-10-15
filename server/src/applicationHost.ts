import type { Server } from 'node:http';
import { openServerFoundationInternal, type ServerFoundationOptions } from './bootstrap.js';
import type { ServerConfig } from './config.js';
import { createStillHttpServer } from './http.js';
import { drainAcceptedHttpRequests } from './httpRequestDrain.js';
import type { AudioHttpApi } from './audioHttp.js';
import type { DurableKernel, OwnedWorkspaceIdentity } from './kernel.js';
import { ProcessWorkspaceActors } from './runtimeActors.js';
import type { SecretVault } from './vault.js';
import type { AuthService } from './auth.js';
import type { RuntimeSessionResolver } from './workspaceRegistry.js';
import type { WorkspaceHttpApi } from './workspaceHttp.js';

/** Trusted runtime owner contract. It contains no caller supplied workspace authority. */
export interface ApplicationRuntime {
  readonly workspaceApi: WorkspaceHttpApi;
  /** Optional authenticated audio bridge supplied by a real workspace runtime. */
  readonly audioHttpApi?: AudioHttpApi;
  stopAdmission(): void;
  drainAndDispose(): Promise<void>;
}

export interface ApplicationRuntimeFactoryContext {
  readonly kernel: DurableKernel;
  readonly vault: SecretVault;
  readonly auth: AuthService;
  readonly runtimeSessionFor: RuntimeSessionResolver;
}

export type ApplicationRuntimeFactory =
  (context: ApplicationRuntimeFactoryContext) => ApplicationRuntime | Promise<ApplicationRuntime>;

export interface ApplicationHostOptions {
  readonly config: ServerConfig;
  readonly port: number;
  /** Required: host startup has no successful provider-free fallback runtime. */
  readonly createRuntime: ApplicationRuntimeFactory;
  readonly foundation?: ServerFoundationOptions;
}

export interface ApplicationHostHandle {
  readonly server: Readonly<{ isListening: () => boolean; address: () => ReturnType<Server['address']> }>;
  readonly readStatus: () => Readonly<{ enrolled: boolean }>;
  readonly close: () => Promise<void>;
}

export class ApplicationHostStartError extends Error {
  constructor() {
    super('Application host could not start.');
    this.name = 'ApplicationHostStartError';
  }
}

/** Startup cleanup failed after ownership was established; retryClose retains the private owner. */
export class ApplicationHostStartupCleanupError extends Error {
  readonly #retryClose: () => Promise<void>;

  constructor(retryClose: () => Promise<void>) {
    super('Application host startup cleanup is incomplete.');
    this.name = 'ApplicationHostStartupCleanupError';
    this.#retryClose = retryClose;
  }

  retryClose(): Promise<void> { return this.#retryClose(); }
}

class ApplicationHostOwner implements ApplicationHostHandle {
  private accepting = true;
  private runtime: ApplicationRuntime | undefined;
  private httpServer: Server | undefined;
  private closePromise: Promise<void> | undefined;
  private listenerClosePromise: Promise<void> | undefined;
  private listenerStopped = false;
  private runtimeDrained = false;
  private actorsRevoked = false;
  private foundationClosed = false;
  private runtimeAdmissionStopped = false;
  private runtimeAdmissionFailure: unknown;
  private everListened = false;
  private readonly safeServerHandle: ApplicationHostHandle['server'];
  private safePublicHandle: ApplicationHostHandle | undefined;

  constructor(private readonly foundation: ReturnType<typeof openServerFoundationInternal>['foundation'],
    private readonly actors: ProcessWorkspaceActors) {
    this.safeServerHandle = Object.freeze({ isListening: () => this.httpServer?.listening === true,
      address: () => this.httpServer?.address() ?? null });
  }

  attachRuntime(runtime: ApplicationRuntime): void { this.runtime = runtime; }
  attachServer(server: Server): void { this.httpServer = server; }
  markListening(): void { this.everListened = true; }

  get server(): ApplicationHostHandle['server'] { return this.safeServerHandle; }
  readStatus(): Readonly<{ enrolled: boolean }> { return this.foundation.readStatus(); }
  isAccepting(): boolean { return this.accepting; }

  publicHandle(): ApplicationHostHandle {
    if (!this.safePublicHandle) this.safePublicHandle = Object.freeze({ server: this.safeServerHandle,
      readStatus: () => this.readStatus(), close: () => this.close() });
    return this.safePublicHandle;
  }

  close(): Promise<void> {
    this.stopAdmission();
    if (this.closePromise) return this.closePromise;
    const attempt = this.closeStages();
    this.closePromise = attempt;
    void attempt.catch(() => { if (this.closePromise === attempt) this.closePromise = undefined; });
    return attempt;
  }

  private stopAdmission(): void {
    if (this.accepting) {
      this.accepting = false;
    }
    this.stopRuntimeAdmission();
    // Initiate listener shutdown synchronously with the admission fence. Its
    // callback drains accepted HTTP handlers while runtime work drains in parallel.
    void this.stopListener().catch(() => undefined);
  }

  private stopListener(): Promise<void> {
    if (this.listenerStopped) return Promise.resolve();
    if (this.listenerClosePromise) return this.listenerClosePromise;
    const server = this.httpServer;
    if (!server || !this.everListened) {
      this.listenerStopped = true;
      return Promise.resolve();
    }
    if (!server.listening) {
      const attempt = drainAcceptedHttpRequests(server).then(() => {
        if (server.listening) throw new Error('application_listener_still_accepting');
        this.listenerStopped = true;
      });
      this.listenerClosePromise = attempt;
      void attempt.then(() => undefined, () => {
        if (this.listenerClosePromise === attempt) this.listenerClosePromise = undefined;
      });
      return attempt;
    }
    const attempt = new Promise<void>((resolve, reject) => {
      try {
        server.close((error) => {
          if (error) { reject(error); return; }
          void drainAcceptedHttpRequests(server).then(() => {
            if (server.listening) throw new Error('application_listener_still_accepting');
            resolve();
          }, reject).catch(reject);
        });
      } catch (error) { reject(error); }
    });
    this.listenerClosePromise = attempt;
    void attempt.then(() => { this.listenerStopped = true; }, () => {
      if (this.listenerClosePromise === attempt) this.listenerClosePromise = undefined;
    });
    return attempt;
  }

  private stopRuntimeAdmission(): void {
    if (this.runtimeAdmissionStopped || !this.runtime) return;
    try {
      this.runtime.stopAdmission();
      this.runtimeAdmissionStopped = true;
      this.runtimeAdmissionFailure = undefined;
    } catch (error) { this.runtimeAdmissionFailure = error; }
  }

  private async closeStages(): Promise<void> {
    const listener = this.stopListener();
    const runtime = this.runtimeDrained || !this.runtime ? Promise.resolve()
      : this.runtimeAdmissionStopped ? Promise.resolve().then(() => this.runtime!.drainAndDispose())
        : Promise.reject(this.runtimeAdmissionFailure ?? new Error('application_runtime_admission_stop_failed'));
    const outcomes = await Promise.allSettled([listener, runtime]);
    if (outcomes[0]?.status === 'fulfilled') this.listenerStopped = true;
    if (outcomes[1]?.status === 'fulfilled') this.runtimeDrained = true;
    const failures = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : []);
    if (failures.length) throw combineFailures(failures, 'Application host drain did not complete.');

    if (!this.actorsRevoked) {
      await this.actors.closeAfterDrain(async () => undefined);
      this.actorsRevoked = true;
    }
    if (!this.foundationClosed) {
      this.foundation.close();
      this.foundationClosed = true;
    }
  }
}

/** Builds the real host around the private foundation and a mandatory runtime factory. */
export async function startApplicationHost(options: ApplicationHostOptions): Promise<ApplicationHostHandle> {
  if (!options || typeof options !== 'object' || typeof options.createRuntime !== 'function' ||
      !Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new TypeError('application_host_configuration_invalid');
  }
  const opened = openServerFoundationInternal(options.config, options.foundation);
  const actors = new ProcessWorkspaceActors(opened.privateContext.kernel);
  const owner = new ApplicationHostOwner(opened.foundation, actors);
  try {
    const runtime = await options.createRuntime(Object.freeze({
      kernel: opened.privateContext.kernel,
      vault: opened.privateContext.vault,
      auth: opened.foundation.auth,
      runtimeSessionFor: (identity: OwnedWorkspaceIdentity) => actors.sessionForRegistry(identity),
    }));
    if (runtime && typeof runtime === 'object' && typeof runtime.stopAdmission === 'function' &&
        typeof runtime.drainAndDispose === 'function') owner.attachRuntime(runtime);
    if (!runtime || typeof runtime !== 'object' || !runtime.workspaceApi ||
        typeof runtime.stopAdmission !== 'function' || typeof runtime.drainAndDispose !== 'function') {
      throw new TypeError('application_runtime_composition_required');
    }
    const server = createStillHttpServer({ auth: opened.foundation.auth,
      credentialCommands: opened.foundation.credentialCommands, workspaceApi: runtime.workspaceApi,
      ...(runtime.audioHttpApi ? { audioApi: runtime.audioHttpApi } : {}),
      canonicalOrigin: options.config.canonicalOrigin, staticRoot: options.config.staticRoot,
      ...(options.config.allowLocalHttp ? { allowLocalHttp: true } : {}),
      admissionOpen: () => owner.isAccepting(),
    });
    owner.attachServer(server);
    await listen(server, options.port, options.config.host);
    owner.markListening();
    return owner.publicHandle();
  } catch {
    try { await owner.close(); }
    catch { throw new ApplicationHostStartupCleanupError(() => owner.close()); }
    throw new ApplicationHostStartError();
  }
}

function combineFailures(failures: readonly unknown[], message: string): unknown {
  if (failures.length === 1) return failures[0];
  return new AggregateError(failures, message);
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    try { server.listen(port, host); }
    catch (error) { server.off('error', onError); server.off('listening', onListening); reject(error); }
  });
}
