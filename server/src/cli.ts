import { AuthError, type AuthService } from './auth.js';

export interface LocalCliRuntime {
  readonly auth: AuthService;
  readonly initialWorkspaceSnapshot: () => unknown;
  readonly readStatus: () => Promise<{ readonly enrolled: boolean }> | { readonly enrolled: boolean };
  readonly close: () => void;
}

export interface LocalCliDependencies {
  /** Runtime composition is supplied by the host; importing this module never opens a database. */
  readonly openRuntime: () => Promise<LocalCliRuntime> | LocalCliRuntime;
  readonly promptHidden: (label: string) => Promise<string>;
  readonly writeOut: (text: string) => void;
  readonly writeError: (text: string) => void;
}

function usage(dependencies: LocalCliDependencies): number {
  dependencies.writeError('Usage: still-server <status|enroll|reset-password>');
  return 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Runs only explicit trusted local operations; password material is read from the hidden prompt, never argv/env. */
export async function runLocalCli(argv: readonly string[], dependencies: LocalCliDependencies): Promise<number> {
  if (!Array.isArray(argv) || argv.length !== 1 || !['status', 'enroll', 'reset-password'].includes(argv[0] ?? '')) {
    return usage(dependencies);
  }
  const command = argv[0];
  let runtime: LocalCliRuntime | undefined;
  try {
    runtime = await dependencies.openRuntime();
    if (command === 'status') {
      const status = await runtime.readStatus();
      if (!isRecord(status) || typeof status.enrolled !== 'boolean') throw new Error('status_invalid');
      dependencies.writeOut(status.enrolled ? 'Owner account is enrolled.\n' : 'Owner account is not enrolled.\n');
      return 0;
    }

    const first = await dependencies.promptHidden(command === 'enroll' ? 'New owner password: ' : 'New password: ');
    const second = await dependencies.promptHidden('Confirm password: ');
    if (first !== second) {
      dependencies.writeError('The passwords do not match.\n');
      return 1;
    }
    if (command === 'enroll') {
      await runtime.auth.enrollOwner(first, runtime.initialWorkspaceSnapshot());
      dependencies.writeOut('Owner account enrolled.\n');
      return 0;
    }
    await runtime.auth.resetPassword(first);
    dependencies.writeOut('Owner password reset.\n');
    return 0;
  } catch (error) {
    dependencies.writeError(`${error instanceof AuthError ? error.code : 'operation_failed'}\n`);
    return 1;
  } finally {
    runtime?.close();
  }
}

/** Hidden TTY prompt. The function rejects non-interactive input rather than echoing a password. */
export async function promptHidden(label: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('interactive_tty_required');
  output.write(label);
  input.setRawMode(true);
  input.setEncoding('utf8');
  input.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const character of text) {
        if (character === '\u0003') { finish(new Error('prompt_cancelled')); return; }
        if (character === '\r' || character === '\n') { finish(); return; }
        if (character === '\u007f' || character === '\b') { value = Array.from(value).slice(0, -1).join(''); continue; }
        if (character >= ' ') value += character;
      }
    };
    input.on('data', onData);
  });
}
