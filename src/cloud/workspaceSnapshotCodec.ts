import { workspaceSnapshotSchema } from './workspaceSnapshotSchema.generated';
import type { WorkspaceSnapshotDTO } from './workspaceDto';
import type { WorkspaceSnapshotSchemaGraph, WorkspaceSnapshotSchemaNode } from './workspaceSnapshotSchema.types';

export const WORKSPACE_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 128;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const schema: WorkspaceSnapshotSchemaGraph = workspaceSnapshotSchema;

function invalid(path: string): never { throw new TypeError(`workspace_snapshot_invalid:${path}`); }
function ownDataKeys(value: object, path: string): string[] {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) invalid(path);
  const keys = ownKeys as string[];
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid(`${path}.${key}`);
  }
  return keys;
}

function preflightStringBytes(value: string, budget: { used: number }): void {
  const remaining = WORKSPACE_SNAPSHOT_MAX_BYTES - budget.used;
  if (value.length > remaining) invalid('size');
  let bytes = 2; // JSON quotes
  const add = (count: number): void => {
    bytes += count;
    if (bytes > WORKSPACE_SNAPSHOT_MAX_BYTES - budget.used) invalid('size');
  };
  if (bytes > remaining) invalid('size');
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) add(2);
    else if (code < 0x20) add(6);
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { add(4); index += 1; }
      else add(6); // Well-formed JSON.stringify escapes an unpaired surrogate.
    } else if (code >= 0xdc00 && code <= 0xdfff) add(6);
    else if (code <= 0x7f) add(1);
    else if (code <= 0x7ff) add(2);
    else add(3);
  }
  budget.used += bytes;
}

/** Counts JSON UTF-8 bytes without serializing or cloning untrusted input. */
function preflightJSON(value: unknown): void {
  const budget = { used: 0 };
  const active = new WeakSet<object>();
  const add = (count: number): void => {
    budget.used += count;
    if (budget.used > WORKSPACE_SNAPSHOT_MAX_BYTES) invalid('size');
  };
  const visit = (current: unknown, depth: number, path: string): void => {
    if (depth > MAX_DEPTH) invalid(path);
    if (current === null) { add(4); return; }
    if (typeof current === 'string') { preflightStringBytes(current, budget); return; }
    if (typeof current === 'boolean') { add(current ? 4 : 5); return; }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) invalid(path);
      add(String(current === 0 ? 0 : current).length);
      return;
    }
    if (typeof current !== 'object' || current === undefined) invalid(path);
    if (active.has(current)) invalid(path);
    active.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) invalid(path);
        const ownKeys = Reflect.ownKeys(current);
        if (ownKeys.some((key) => typeof key !== 'string')) invalid(path);
        const keys = ownKeys.filter((key) => key !== 'length') as string[];
        if (keys.length !== current.length || keys.some((key, index) => key !== String(index))) invalid(path);
        add(1);
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) invalid(`${path}[${index}]`);
          if (index > 0) add(1);
          visit(descriptor.value, depth + 1, `${path}[${index}]`);
        }
        add(1);
      } else {
        const keys = ownDataKeys(current, path);
        add(1);
        let first = true;
        for (const key of keys) {
          const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
          if (descriptor.value === undefined) continue; // Object JSON encoding omits undefined; requiredness is checked by schema validation.
          if (!first) add(1);
          first = false;
          preflightStringBytes(key, budget);
          add(1);
          visit(descriptor.value, depth + 1, `${path}.${key}`);
        }
        add(1);
      }
    } finally { active.delete(current); }
  };
  visit(value, 0, 'snapshot');
}

function normalize(input: unknown, rule: WorkspaceSnapshotSchemaNode, path: string, active: WeakSet<object>, depth: number): unknown {
  if (depth > MAX_DEPTH) invalid(path);
  if (rule.kind === 'ref') {
    const target = schema.definitions[rule.name];
    if (!target) invalid(path);
    return normalize(input, target, path, active, depth + 1);
  }
  if (rule.kind === 'never') invalid(path);
  if (rule.kind === 'string') {
    if (typeof input !== 'string') invalid(path);
    return input;
  }
  if (rule.kind === 'number') {
    if (typeof input !== 'number' || !Number.isFinite(input)) invalid(path);
    return input;
  }
  if (rule.kind === 'boolean') {
    if (typeof input !== 'boolean') invalid(path);
    return input;
  }
  if (rule.kind === 'literal') {
    if (input !== rule.value) invalid(path);
    return input;
  }
  if (rule.kind === 'union') {
    for (const alternative of rule.alternatives) {
      try { return normalize(input, alternative, path, active, depth + 1); } catch { /* try the next declared alternative */ }
    }
    return invalid(path);
  }
  if (rule.kind === 'array') {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || Object.getOwnPropertySymbols(input).length) invalid(path);
    if (active.has(input)) invalid(path);
    active.add(input);
    try {
      const keys = Object.keys(input);
      const ownKeys = Reflect.ownKeys(input).filter((key) => key !== 'length');
      if (ownKeys.some((key) => typeof key !== 'string') || keys.length !== input.length || keys.some((key, index) => key !== String(index)) || ownKeys.length !== input.length) invalid(path);
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid(`${path}[${index}]`);
      }
      return input.map((item, index) => normalize(item, rule.element, `${path}[${index}]`, active, depth + 1));
    } finally { active.delete(input); }
  }
  if (!input || typeof input !== 'object') invalid(path);
  if (active.has(input)) invalid(path);
  active.add(input);
  try {
    const keys = ownDataKeys(input, path);
    if (rule.kind === 'dictionary') {
      const result: Record<string, unknown> = {};
      for (const key of keys) Object.defineProperty(result, key, { value: normalize((input as Record<string, unknown>)[key], rule.value, `${path}.${key}`, active, depth + 1), enumerable: true, writable: true, configurable: true });
      return result;
    }
    if (rule.kind !== 'object') invalid(path);
    const properties = rule.properties;
    const required = rule.required;
    for (const key of keys) if (!Object.prototype.hasOwnProperty.call(properties, key)) invalid(`${path}.${key}`);
    for (const key of required) if (!keys.includes(key) || (input as Record<string, unknown>)[key] === undefined) invalid(`${path}.${key}`);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const value = (input as Record<string, unknown>)[key];
      if (value === undefined && !required.includes(key)) continue;
      Object.defineProperty(result, key, { value: normalize(value, properties[key]!, `${path}.${key}`, active, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return result;
  } finally { active.delete(input); }
}

function validateSemantics(snapshot: Record<string, unknown>): void {
  if (typeof snapshot.workspaceId !== 'string' || !UUID_V4.test(snapshot.workspaceId)) invalid('workspaceId');
  for (const name of ['privacyEpoch', 'revision']) if (!Number.isSafeInteger(snapshot[name]) || (snapshot[name] as number) < 0) invalid(name);
  const state = snapshot.state as Record<string, unknown>;
  const notes = state.notes as Record<string, unknown>[];
  for (const [index, note] of notes.entries()) {
    const audio = note.audio as Record<string, unknown> | undefined;
    if (!audio) continue;
    if (audio.available !== (audio.mediaId !== undefined)) invalid(`state.notes[${index}].audio`);
    if (audio.mediaId !== undefined && (typeof audio.mediaId !== 'string' || !UUID_V4.test(audio.mediaId))) invalid(`state.notes[${index}].audio.mediaId`);
    if (audio.byteLength !== undefined && (!Number.isSafeInteger(audio.byteLength) || (audio.byteLength as number) < 0)) invalid(`state.notes[${index}].audio.byteLength`);
  }
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(costUsd|providerReportedCostUsd|estimatedCostUsd|reservedUsd)$/i.test(key) && typeof child === 'number' && child < 0) invalid(`${path}.${key}`);
      if (/^(inputTokens|outputTokens|promptTokens|completionTokens|totalTokens)$/i.test(key) && typeof child === 'number' && (!Number.isSafeInteger(child) || child < 0)) invalid(`${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(state, 'state');
}

function canonicalClone(value: unknown): WorkspaceSnapshotDTO {
  preflightJSON(value);
  const normalized = normalize(value, schema.root, 'snapshot', new WeakSet(), 0) as Record<string, unknown>;
  validateSemantics(normalized);
  const freeze = (current: unknown): void => {
    if (!current || typeof current !== 'object' || Object.isFrozen(current)) return;
    for (const child of Object.values(current)) freeze(child);
    Object.freeze(current);
  };
  freeze(normalized);
  return normalized as WorkspaceSnapshotDTO;
}

/** Validates an untrusted wire DTO and returns an owned, deeply-frozen copy. */
export function decodeWorkspaceSnapshotDTO(value: unknown): WorkspaceSnapshotDTO { return canonicalClone(value); }

/** Applies the same closed-schema and semantic checks to server-projected DTOs. */
export function encodeWorkspaceSnapshotDTO(value: unknown): WorkspaceSnapshotDTO { return canonicalClone(value); }
