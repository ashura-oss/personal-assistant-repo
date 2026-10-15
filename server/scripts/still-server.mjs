#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundation, parseStillPort, ServerFoundationStartupCleanupError, startStillHttp } from '../dist/bootstrap.js';
import { ApplicationHostStartupCleanupError, startApplicationHost } from '../dist/applicationHost.js';
import { createProductionApplicationRuntimeFactory } from '../dist/applicationHost.node.mjs';
import { promptHidden, runLocalCli } from '../dist/cli.js';

const COMMANDS = new Set(['start', 'status', 'enroll', 'reset-password']);
let retainedCleanup;
let signalShutdown;

function removeSignalShutdown() {
  if (!signalShutdown) return;
  process.off('SIGINT', signalShutdown);
  process.off('SIGTERM', signalShutdown);
  signalShutdown = undefined;
}

function installCleanupRetrySignals() {
  if (signalShutdown) return;
  signalShutdown = () => { void retryStillServerCleanup().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
  process.on('SIGINT', signalShutdown);
  process.on('SIGTERM', signalShutdown);
}

/** Same-process trusted CLI inspection only; never exposed through HTTP. */
export function getStillServerCleanupStatus() {
  return Object.freeze({ state: retainedCleanup?.state ?? 'idle', heldCount: retainedCleanup ? 1 : 0 });
}

/** Explicitly retries the exact cleanup owner retained after a failed close. */
export async function retryStillServerCleanup() {
  const held = retainedCleanup;
  if (!held) return false;
  held.state = 'cleanup_pending';
  try {
    await held.retryClose();
    if (retainedCleanup === held) retainedCleanup = undefined;
    removeSignalShutdown();
    return true;
  } catch (error) {
    throw error;
  }
}

export async function runStillServer(argv = process.argv.slice(2), dependencies = {}) {
  const writeOut = dependencies.writeOut ?? ((text) => process.stdout.write(text));
  const writeError = dependencies.writeError ?? ((text) => process.stderr.write(text));
  if (!Array.isArray(argv) || argv.length !== 1 || !COMMANDS.has(argv[0])) {
    writeError('Usage: still-server <start|status|enroll|reset-password>\n');
    return 2;
  }
  if (retainedCleanup) {
    writeError('still-server: cleanup is incomplete; retry the retained cleanup before another command.\n');
    return 1;
  }
  if (argv[0] !== 'start') {
    try {
      return await runLocalCli(argv, {
        openRuntime: () => {
          const config = (dependencies.loadConfig ?? loadServerConfig)();
          const foundation = (dependencies.openFoundation ?? openServerFoundation)(config);
          return {
            auth: foundation.auth,
            initialWorkspaceSnapshot: foundation.initialWorkspaceSnapshot,
            readStatus: foundation.readStatus,
            close: foundation.close,
          };
        },
        promptHidden: dependencies.promptHidden ?? promptHidden,
        writeOut,
        writeError,
      });
    } catch (error) {
      if (!(error instanceof ServerFoundationStartupCleanupError)) throw error;
      retainedCleanup = { state: 'cleanup_pending', retryClose: () => error.retryClose() };
      if (dependencies.installSignalHandlers !== false) installCleanupRetrySignals();
      writeError('still-server: CLI cleanup is incomplete; the retained owner can be retried in this process.\n');
      return 1;
    }
  }

  let foundation;
  try {
    const port = (dependencies.parsePort ?? parseStillPort)(process.env.STILL_PORT);
    const config = (dependencies.loadConfig ?? loadServerConfig)();
    let listening;
    if (dependencies.startHttp || dependencies.openFoundation) {
      foundation = (dependencies.openFoundation ?? openServerFoundation)(config);
      listening = await (dependencies.startHttp ?? startStillHttp)(config, foundation, port);
    } else {
      listening = await (dependencies.startApplicationHost ?? startApplicationHost)({ config, port,
        createRuntime: createProductionApplicationRuntimeFactory(config) });
    }
    writeOut(`Still server listening at ${config.canonicalOrigin}.\n`);
    let closing;
    const owner = { state: 'running', retryClose: undefined };
    const close = () => {
      if (closing) return closing;
      owner.state = 'cleanup_pending';
      const attempt = Promise.resolve().then(() => listening.close());
      closing = attempt;
      void attempt.then(() => { if (retainedCleanup === owner) retainedCleanup = undefined; }, () => {
        if (closing === attempt) closing = undefined;
      });
      return attempt;
    };
    owner.retryClose = close;
    retainedCleanup = owner;
    if (dependencies.installSignalHandlers !== false) installCleanupRetrySignals();
    return 0;
  } catch (error) {
    let cleanupIncomplete = false;
    if (error instanceof ApplicationHostStartupCleanupError) {
      retainedCleanup = { state: 'cleanup_pending', retryClose: () => error.retryClose() };
      cleanupIncomplete = true;
    } else if (error instanceof ServerFoundationStartupCleanupError) {
      retainedCleanup = { state: 'cleanup_pending', retryClose: () => error.retryClose() };
      cleanupIncomplete = true;
    } else if (foundation) {
      const exactFoundation = foundation;
      try { await exactFoundation.close(); }
      catch {
        retainedCleanup = { state: 'cleanup_pending', retryClose: () => exactFoundation.close() };
        cleanupIncomplete = true;
      }
    }
    if (cleanupIncomplete && dependencies.installSignalHandlers !== false) installCleanupRetrySignals();
    writeError(cleanupIncomplete
      ? 'still-server: startup failed and cleanup is incomplete; the retained owner can be retried in this process.\n'
      : 'still-server: startup failed. Check the private server configuration and logs.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runStillServer();
}
