import type { WorkspaceSnapshotDTO } from './workspaceDto';

export const WORKSPACE_COMMAND_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_COMMAND_MAX_BYTES = 16 * 1024;

export type WorkspaceCommand =
  | { readonly kind: 'tasks.complete'; readonly taskId: string }
  | { readonly kind: 'tasks.reopen'; readonly taskId: string }
  | { readonly kind: 'chat.create'; readonly title?: string };

export interface WorkspaceCommandEnvelope {
  readonly schemaVersion: typeof WORKSPACE_COMMAND_SCHEMA_VERSION;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly expectedPrivacyEpoch: number;
  readonly command: WorkspaceCommand;
}

export interface WorkspaceCommandReceipt {
  readonly schemaVersion: typeof WORKSPACE_COMMAND_SCHEMA_VERSION;
  readonly commandId: string;
  readonly kind: WorkspaceCommand['kind'];
  readonly objectId: string;
}

export type WorkspaceCommandStatus = 'finished' | 'claimed' | 'checkpointed' | 'inspect_required' | 'unverified';

export interface WorkspaceCommandResponse {
  readonly schemaVersion: typeof WORKSPACE_COMMAND_SCHEMA_VERSION;
  readonly commandId: string;
  readonly status: WorkspaceCommandStatus;
  readonly receipt?: WorkspaceCommandReceipt;
  readonly snapshot?: WorkspaceSnapshotDTO;
}

const ENVELOPE_KEYS = ['command', 'commandId', 'expectedPrivacyEpoch', 'expectedRevision', 'schemaVersion'];
const TASK_COMMAND_KEYS = ['kind', 'taskId'];
const CHAT_COMMAND_KEYS = ['kind', 'title'];
const COMMAND_KINDS = ['tasks.complete', 'tasks.reopen', 'chat.create'] as const;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseWorkspaceCommandId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) throw new Error('workspace_command_id_invalid');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainDataProperties(value: Record<string, unknown>): void {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) throw new Error('workspace_command_invalid');
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('workspace_command_invalid');
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): void {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length > allowed.length ||
      keys.some((key) => !allowed.includes(key as string)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('workspace_command_invalid');
  }
  assertPlainDataProperties(value);
}

function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function boundedString(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === 'string' && validUnicode(value) && (allowEmpty || value.length > 0) && utf8Bytes(value) <= maxBytes;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) throw new Error('workspace_command_invalid');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** Validates and freezes the one public command envelope accepted by the Node gateway. */
export function parseWorkspaceCommandEnvelope(value: unknown): WorkspaceCommandEnvelope {
  if (!isRecord(value)) throw new Error('workspace_command_invalid');
  assertExactKeys(value, ENVELOPE_KEYS, ENVELOPE_KEYS);
  if (value.schemaVersion !== WORKSPACE_COMMAND_SCHEMA_VERSION || !UUID_V4.test(typeof value.commandId === 'string' ? value.commandId : '') ||
      !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0 ||
      !Number.isSafeInteger(value.expectedPrivacyEpoch) || (value.expectedPrivacyEpoch as number) < 0 || !isRecord(value.command)) {
    throw new Error('workspace_command_invalid');
  }
  const commandId = parseWorkspaceCommandId(value.commandId);

  const rawCommand = value.command;
  assertPlainDataProperties(rawCommand);
  if (rawCommand.kind === 'tasks.complete' || rawCommand.kind === 'tasks.reopen') {
    assertExactKeys(rawCommand, TASK_COMMAND_KEYS, TASK_COMMAND_KEYS);
    if (!boundedString(rawCommand.taskId, 1024)) throw new Error('workspace_command_invalid');
    assertPhysicalSize(value);
    return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId,
      expectedRevision: value.expectedRevision as number, expectedPrivacyEpoch: value.expectedPrivacyEpoch as number,
      command: Object.freeze({ kind: rawCommand.kind, taskId: rawCommand.taskId }) });
  }
  if (rawCommand.kind === 'chat.create') {
    assertExactKeys(rawCommand, CHAT_COMMAND_KEYS, ['kind']);
    if (Object.hasOwn(rawCommand, 'title') && !boundedString(rawCommand.title, 4096, true)) throw new Error('workspace_command_invalid');
    assertPhysicalSize(value);
    const command = Object.freeze({ kind: 'chat.create' as const,
      ...(Object.hasOwn(rawCommand, 'title') ? { title: rawCommand.title as string } : {}) });
    return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId,
      expectedRevision: value.expectedRevision as number, expectedPrivacyEpoch: value.expectedPrivacyEpoch as number, command });
  }
  if (!(COMMAND_KINDS as readonly unknown[]).includes(rawCommand.kind)) throw new Error('workspace_command_invalid');
  throw new Error('workspace_command_invalid');
}

function assertPhysicalSize(value: WorkspaceCommandEnvelope | Record<string, unknown>): void {
  const physicalText = JSON.stringify(value);
  if (typeof physicalText !== 'string' || utf8Bytes(physicalText) > WORKSPACE_COMMAND_MAX_BYTES) throw new Error('workspace_command_invalid');
}

/** Stable, sorted JSON for command-journal request binding; revision and epoch stay included. */
export function canonicalWorkspaceCommand(envelope: WorkspaceCommandEnvelope): string {
  return canonicalJson(parseWorkspaceCommandEnvelope(envelope));
}

/** Validates a stored or returned receipt before any field is projected to a caller. */
export function parseWorkspaceCommandReceipt(value: unknown, expected?: {
  readonly commandId: string;
  readonly kind?: WorkspaceCommand['kind'];
  readonly objectId?: string;
}): WorkspaceCommandReceipt {
  if (!isRecord(value)) throw new Error('workspace_command_receipt_invalid');
  const keys = ['commandId', 'kind', 'objectId', 'schemaVersion'];
  assertExactKeys(value, keys, keys);
  if (value.schemaVersion !== WORKSPACE_COMMAND_SCHEMA_VERSION || typeof value.commandId !== 'string' || !UUID_V4.test(value.commandId) ||
      !(COMMAND_KINDS as readonly unknown[]).includes(value.kind) || !boundedString(value.objectId, 1024) ||
      (value.kind === 'chat.create' && !UUID_V4.test(value.objectId as string)) ||
      (expected && (value.commandId !== expected.commandId || (expected.kind !== undefined && value.kind !== expected.kind) ||
        (expected.objectId !== undefined && value.objectId !== expected.objectId)))) {
    throw new Error('workspace_command_receipt_invalid');
  }
  return Object.freeze({ schemaVersion: WORKSPACE_COMMAND_SCHEMA_VERSION, commandId: value.commandId,
    kind: value.kind as WorkspaceCommand['kind'], objectId: value.objectId });
}
