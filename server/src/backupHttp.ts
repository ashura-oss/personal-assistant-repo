import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import type { WorkspaceHttpAdmission, WorkspaceHttpApi } from './workspaceHttp.js';
import { isCanonicalKnowledgeId } from './knowledgeId.js';

export const PORTABLE_BACKUP_BODY_LIMIT = 32 * 1024 * 1024;
const BACKUP_BODY_TIMEOUT_MS = 10_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type BackupRoute = Readonly<{
  pathname: string;
  rawQuery?: string;
  hasQuery: boolean;
  request: IncomingMessage;
  response: ServerResponse;
}>;
type Dependencies = Readonly<{
  workspaceApi?: WorkspaceHttpApi;
  admissionOpen?: () => boolean;
  readAdmission: () => WorkspaceHttpAdmission;
  mutationAdmission: () => WorkspaceHttpAdmission;
  strictQuery: (raw: string | undefined, allowed: readonly string[]) => Map<string, string>;
  exactObject: (value: unknown, keys: string[]) => Record<string, unknown>;
  readJsonBody: (request: IncomingMessage, response: ServerResponse) => Promise<unknown>;
  uniqueHeader: (request: IncomingMessage, name: string, required?: boolean) => string | undefined;
  problem: (status: number, code: string) => unknown;
  sendJson: (response: ServerResponse, status: number, value: unknown) => void;
  sendWorkspaceFailure: (response: ServerResponse, error: unknown) => void;
}>;

async function readBackupBytes(route: BackupRoute, deps: Dependencies): Promise<Uint8Array> {
  const { request, response } = route;
  const contentType = deps.uniqueHeader(request, 'content-type', true) ?? '';
  const contentEncoding = deps.uniqueHeader(request, 'content-encoding');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType) ||
      (contentEncoding !== undefined && contentEncoding.toLowerCase() !== 'identity')) throw deps.problem(415, 'unsupported_media_type');
  const lengthHeader = deps.uniqueHeader(request, 'content-length');
  if (lengthHeader !== undefined && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > PORTABLE_BACKUP_BODY_LIMIT)) {
    response.setHeader('Connection', 'close');
    request.resume();
    throw deps.problem(413, 'request_too_large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const cleanup = () => {
      clearTimeout(timeout);
      request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onAborted);
    };
    const fail = (error: unknown) => { cleanup(); rejectPromise(error); };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > PORTABLE_BACKUP_BODY_LIMIT) {
        response.setHeader('Connection', 'close'); fail(deps.problem(413, 'request_too_large')); request.resume(); return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => { cleanup(); resolvePromise(); };
    const onError = () => fail(deps.problem(400, 'bad_request'));
    const onAborted = () => fail(deps.problem(400, 'bad_request'));
    const timeout = setTimeout(() => { response.setHeader('Connection', 'close'); fail(deps.problem(408, 'request_timeout')); request.resume(); }, BACKUP_BODY_TIMEOUT_MS);
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onAborted);
  });
  const bytes = Buffer.concat(chunks, size);
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw deps.problem(400, 'bad_request'); }
  return new Uint8Array(bytes);
}

function expectedRevision(values: Map<string, string>, key: string, deps: Dependencies): number {
  const raw = values.get(key);
  if (raw === undefined || !/^(0|[1-9][0-9]{0,15})$/.test(raw)) throw deps.problem(400, 'bad_request');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw deps.problem(400, 'bad_request');
  return value;
}

/** Routes the authenticated, same-origin portable-backup protocol. Returns false for other paths. */
export async function handlePortableBackupHttpRoute(route: BackupRoute, deps: Dependencies): Promise<boolean> {
  const { pathname, request, response } = route;
  const workspaceApi = deps.workspaceApi;
  if (pathname === '/api/workspace/backup/export') {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); throw deps.problem(405, 'method_not_allowed'); }
    const values = deps.strictQuery(route.rawQuery, ['expectedRevision', 'expectedPrivacyEpoch']);
    if (values.size !== 2) throw deps.problem(400, 'bad_request');
    if (!workspaceApi || typeof workspaceApi.exportPortableBackup !== 'function') throw deps.problem(503, 'service_unavailable');
    const admission = deps.readAdmission();
    try {
      admission.assertCurrent();
      const result = await workspaceApi.exportPortableBackup(admission, {
        expectedRevision: expectedRevision(values, 'expectedRevision', deps),
        expectedPrivacyEpoch: expectedRevision(values, 'expectedPrivacyEpoch', deps),
      });
      admission.assertCurrent();
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof (result as Record<string, unknown>).content !== 'string') {
        throw deps.problem(503, 'service_unavailable');
      }
      const body = Buffer.from((result as Record<string, unknown>).content as string, 'utf8');
      if (body.byteLength > PORTABLE_BACKUP_BODY_LIMIT) throw deps.problem(413, 'request_too_large');
      try { JSON.parse(body.toString('utf8')) as unknown; } catch { throw deps.problem(503, 'service_unavailable'); }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(body.byteLength),
        'Content-Disposition': 'attachment; filename="still-backup.json"', 'Cache-Control': 'no-store', Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff' });
      response.end(body);
    } catch (error) { if (!response.destroyed && !response.headersSent) deps.sendWorkspaceFailure(response, error); else if (!response.destroyed) response.destroy(); }
    return true;
  }
  if (pathname === '/api/workspace/backup/import/preview') {
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw deps.problem(405, 'method_not_allowed'); }
    const values = deps.strictQuery(route.rawQuery, ['expectedRevision', 'expectedPrivacyEpoch']);
    if (values.size !== 2) throw deps.problem(400, 'bad_request');
    const revision = expectedRevision(values, 'expectedRevision', deps);
    const privacyEpoch = expectedRevision(values, 'expectedPrivacyEpoch', deps);
    if (!workspaceApi || typeof workspaceApi.preparePortableBackupImport !== 'function') throw deps.problem(503, 'service_unavailable');
    const admission = deps.mutationAdmission();
    try {
      const bytes = await readBackupBytes(route, deps);
      admission.assertCurrent();
      if (deps.admissionOpen && !deps.admissionOpen()) throw deps.problem(503, 'service_unavailable');
      const result = await workspaceApi.preparePortableBackupImport(admission, { bytes, expectedRevision: revision, expectedPrivacyEpoch: privacyEpoch });
      admission.assertCurrent();
      if (!response.destroyed) deps.sendJson(response, 200, result);
    } catch (error) { if (!response.destroyed && !response.headersSent) deps.sendWorkspaceFailure(response, error); }
    return true;
  }
  if (pathname === '/api/workspace/backup/knowledge/preview') {
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw deps.problem(405, 'method_not_allowed'); }
    if (route.hasQuery) throw deps.problem(400, 'bad_request');
    if (!workspaceApi || typeof workspaceApi.prepareImportedKnowledgeActivation !== 'function') throw deps.problem(503, 'service_unavailable');
    const admission = deps.mutationAdmission();
    try {
      const input = deps.exactObject(await deps.readJsonBody(request, response), ['archiveId', 'cohortId', 'kind', 'entityId', 'expectedRevision', 'expectedPrivacyEpoch']);
      const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      if (typeof input.archiveId !== 'string' || !UUID_V4.test(input.archiveId) || typeof input.cohortId !== 'string' || !UUID_V4.test(input.cohortId) ||
          (input.kind !== 'person' && input.kind !== 'project') || !isCanonicalKnowledgeId(input.entityId) ||
          !integer(input.expectedRevision) || !integer(input.expectedPrivacyEpoch)) throw deps.problem(400, 'bad_request');
      admission.assertCurrent();
      if (deps.admissionOpen && !deps.admissionOpen()) throw deps.problem(503, 'service_unavailable');
      const result = await workspaceApi.prepareImportedKnowledgeActivation(admission, { archiveId: input.archiveId, cohortId: input.cohortId,
        kind: input.kind, entityId: input.entityId, expectedRevision: input.expectedRevision as number, expectedPrivacyEpoch: input.expectedPrivacyEpoch as number });
      admission.assertCurrent();
      if (!response.destroyed) deps.sendJson(response, 200, result);
    } catch (error) { if (!response.destroyed && !response.headersSent) deps.sendWorkspaceFailure(response, error); }
    return true;
  }
  if (pathname === '/api/workspace/backup/knowledge/cancel') {
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); throw deps.problem(405, 'method_not_allowed'); }
    if (route.hasQuery) throw deps.problem(400, 'bad_request');
    if (!workspaceApi || typeof workspaceApi.cancelImportedKnowledgeActivation !== 'function') throw deps.problem(503, 'service_unavailable');
    const admission = deps.mutationAdmission();
    try {
      const input = deps.exactObject(await deps.readJsonBody(request, response), ['sessionId', 'expectedRevision', 'expectedPrivacyEpoch']);
      const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      if (typeof input.sessionId !== 'string' || !UUID_V4.test(input.sessionId) || !integer(input.expectedRevision) || !integer(input.expectedPrivacyEpoch)) {
        throw deps.problem(400, 'bad_request');
      }
      admission.assertCurrent();
      if (deps.admissionOpen && !deps.admissionOpen()) throw deps.problem(503, 'service_unavailable');
      await workspaceApi.cancelImportedKnowledgeActivation(admission, { sessionId: input.sessionId,
        expectedRevision: input.expectedRevision as number, expectedPrivacyEpoch: input.expectedPrivacyEpoch as number });
      admission.assertCurrent();
      if (!response.destroyed) deps.sendJson(response, 200, { schemaVersion: 1, status: 'cancelled' });
    } catch (error) { if (!response.destroyed && !response.headersSent) deps.sendWorkspaceFailure(response, error); }
    return true;
  }
  return false;
}
