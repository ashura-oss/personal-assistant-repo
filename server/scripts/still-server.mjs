#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadServerConfig } from '../dist/config.js';
import { openServerFoundation, parseStillPort, startStillHttp } from '../dist/bootstrap.js';
import { promptHidden, runLocalCli } from '../dist/cli.js';

const COMMANDS = new Set(['start', 'status', 'enroll', 'reset-password']);

export async function runStillServer(argv = process.argv.slice(2), dependencies = {}) {
  const writeOut = dependencies.writeOut ?? ((text) => process.stdout.write(text));
  const writeError = dependencies.writeError ?? ((text) => process.stderr.write(text));
  if (!Array.isArray(argv) || argv.length !== 1 || !COMMANDS.has(argv[0])) {
    writeError('Usage: still-server <start|status|enroll|reset-password>\n');
    return 2;
  }
  if (argv[0] !== 'start') {
    return runLocalCli(argv, {
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
  }

  let foundation;
  try {
    const port = (dependencies.parsePort ?? parseStillPort)(process.env.STILL_PORT);
    const config = (dependencies.loadConfig ?? loadServerConfig)();
    foundation = (dependencies.openFoundation ?? openServerFoundation)(config);
    const listening = await (dependencies.startHttp ?? startStillHttp)(config, foundation, port);
    writeOut(`Still server listening at ${config.canonicalOrigin}.\n`);
    let closing;
    const close = () => closing ??= listening.close();
    if (dependencies.installSignalHandlers !== false) {
      const shutdown = () => { void close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; }); };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    }
    return 0;
  } catch {
    try { foundation?.close(); } catch { /* Keep shutdown failures out of the CLI output. */ }
    writeError('still-server: startup failed. Check the private server configuration and logs.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runStillServer();
}
