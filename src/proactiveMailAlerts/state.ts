import type {
  MailAlertAccountBinding, MailAlertCancellationEvidence, ProactiveMailAlertConsent,
  ProactiveMailAlertReceipt, ProactiveMailAlertState,
} from './types';
import { isValidAccountId } from '../core/accountIds';

export const MAX_MAIL_ALERT_CONSENTS = 64;
export const MAX_MAIL_ALERT_ACCOUNTS_PER_CONSENT = 64;
export const MAX_MAIL_ALERT_RECEIPTS = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Row = Record<string, unknown>;
function object(value: unknown): value is Row { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function fail(message: string): never { throw new Error(message); }
function exactKeys(value: Row, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    fail('Mail alert state contains an unknown or missing field.');
  }
}
function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} is invalid.`);
  return value;
}
function safeIdentifier(value: unknown, label: string, max = 256): string {
  return boundedString(value, label, max);
}
function accountIdentifier(value: unknown): string {
  if (!isValidAccountId(value)) fail('Mail alert account ID is invalid.');
  return value;
}
function uuid(value: unknown, label: string): string {
  const text = boundedString(value, label, 36);
  if (!UUID.test(text)) fail(`${label} must be a canonical UUID.`);
  return text.toLowerCase();
}
function timestamp(value: unknown, label: string): string {
  const text = boundedString(value, label, 24);
  if (!CANONICAL_UTC.test(text)) fail(`${label} must be canonical UTC.`);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) fail(`${label} is invalid.`);
  return text;
}
function timeZone(value: unknown): string {
  const text = boundedString(value, 'Mail alert time zone', 128);
  try { new Intl.DateTimeFormat('en', { timeZone: text }).format(0); }
  catch { fail('Mail alert time zone is invalid.'); }
  return text;
}
function revision(value: unknown, label: string, minimum = 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) fail(`${label} is invalid.`);
  return Number(value);
}
function binding(value: unknown): MailAlertAccountBinding {
  if (!object(value)) fail('Mail alert account binding is invalid.');
  exactKeys(value, ['accountId', 'identityKey', 'connectionGeneration']);
  return {
    accountId: accountIdentifier(value.accountId),
    identityKey: boundedString(value.identityKey, 'Verified identity key', 2048),
    connectionGeneration: revision(value.connectionGeneration, 'Connection generation', 0),
  };
}
function consent(value: unknown): ProactiveMailAlertConsent {
  if (!object(value)) fail('Mail alert consent is invalid.');
  exactKeys(value, ['id', 'ruleId', 'ruleVersion', 'ruleRevision', 'timeZone', 'activatedAt', 'accounts', 'status'], ['revokedAt', 'revocationReason']);
  if (!Array.isArray(value.accounts) || value.accounts.length < 1 || value.accounts.length > MAX_MAIL_ALERT_ACCOUNTS_PER_CONSENT) {
    fail('Mail alert consent must bind 1 to 64 verified accounts.');
  }
  const accounts = value.accounts.map(binding);
  const accountIds = accounts.map((item) => item.accountId);
  if (new Set(accountIds).size !== accountIds.length) fail('Mail alert consent account IDs must be unique.');
  if (value.status !== 'active' && value.status !== 'revoked') fail('Mail alert consent status is invalid.');
  const revokedAt = value.revokedAt === undefined ? undefined : timestamp(value.revokedAt, 'Consent revocation time');
  const revocationReason = value.revocationReason;
  const reasons = ['rule_disabled', 'rule_changed', 'time_zone_changed', 'account_changed', 'user_revoked'];
  if (value.status === 'active' && (revokedAt !== undefined || revocationReason !== undefined)) fail('Active mail alert consent cannot carry revocation data.');
  if (value.status === 'revoked' && (!revokedAt || typeof revocationReason !== 'string' || !reasons.includes(revocationReason))) {
    fail('Revoked mail alert consent requires bounded revocation evidence.');
  }
  return {
    id: uuid(value.id, 'Mail alert consent ID'), ruleId: safeIdentifier(value.ruleId, 'Mail alert rule ID'),
    ruleVersion: revision(value.ruleVersion, 'Mail alert rule version'),
    ruleRevision: revision(value.ruleRevision, 'Mail alert rule revision'), timeZone: timeZone(value.timeZone),
    activatedAt: timestamp(value.activatedAt, 'Consent activation time'), accounts, status: value.status,
    ...(revokedAt ? { revokedAt } : {}), ...(revocationReason ? { revocationReason: revocationReason as ProactiveMailAlertConsent['revocationReason'] } : {}),
  };
}
function cancellation(value: unknown): MailAlertCancellationEvidence {
  if (!object(value)) fail('Mail alert cancellation evidence is invalid.');
  exactKeys(value, ['requestedAt', 'result'], ['attemptedAt', 'observedAt']);
  if (!['requested', 'absent', 'unknown'].includes(String(value.result))) fail('Mail alert cancellation result is invalid.');
  const requestedAt = timestamp(value.requestedAt, 'Cancellation request time');
  const attemptedAt = value.attemptedAt === undefined ? undefined : timestamp(value.attemptedAt, 'Cancellation attempt time');
  const observedAt = value.observedAt === undefined ? undefined : timestamp(value.observedAt, 'Cancellation observation time');
  if ((value.result === 'requested' && observedAt !== undefined) || (value.result !== 'requested' && (!attemptedAt || !observedAt))) {
    fail('Mail alert cancellation evidence is inconsistent.');
  }
  return { requestedAt, result: value.result as MailAlertCancellationEvidence['result'], ...(attemptedAt ? { attemptedAt } : {}), ...(observedAt ? { observedAt } : {}) };
}
function receipt(value: unknown, installationId: string): ProactiveMailAlertReceipt {
  if (!object(value)) fail('Mail alert receipt is invalid.');
  exactKeys(value, ['id', 'installationId', 'consentId', 'ruleId', 'ruleVersion', 'ruleRevision', 'timeZone', 'consentActivatedAt', 'accountId', 'identityKey', 'connectionGeneration',
    'providerMessageId', 'sourceVersion', 'receivedAt', 'desired', 'observed', 'createdAt', 'updatedAt'], ['attemptedAt', 'cancellation']);
  const rowInstallationId = uuid(value.installationId, 'Receipt installation ID');
  if (rowInstallationId !== installationId) fail('Mail alert receipt belongs to another installation.');
  if (value.desired !== 'notify' && value.desired !== 'cancel') fail('Mail alert receipt desired action is invalid.');
  const observedValues = ['attempting', 'submitted', 'delivery_unknown', 'cancellation_pending', 'cancelled', 'cancellation_unknown'];
  if (typeof value.observed !== 'string' || !observedValues.includes(value.observed)) fail('Mail alert receipt observation is invalid.');
  const attemptedAt = value.attemptedAt === undefined ? undefined : timestamp(value.attemptedAt, 'Notification attempt time');
  const cancel = value.cancellation === undefined ? undefined : cancellation(value.cancellation);
  const cancellationState = ['cancellation_pending', 'cancelled', 'cancellation_unknown'].includes(value.observed as string);
  if (!attemptedAt) fail('Mail alert receipt must preserve its notification-attempt reservation time.');
  if (value.desired === 'notify' && (cancel !== undefined || cancellationState)) fail('Notification receipt cannot carry cancellation state while notify is desired.');
  if (value.desired === 'cancel' && !cancel) fail('Cancellation intent must preserve cancellation evidence.');
  if (cancellationState && value.desired !== 'cancel') fail('Cancellation observation requires cancel to be desired.');
  if (value.observed === 'attempting' && value.desired === 'notify' && cancel !== undefined) fail('Attempting notification receipt has unexpected cancellation evidence.');
  if (value.observed === 'cancelled' && cancel?.result !== 'absent') fail('A cancelled notification requires verified absence evidence.');
  if (value.observed === 'cancellation_pending' && cancel?.result !== 'requested') fail('Pending cancellation requires an outstanding request.');
  if (value.observed === 'cancellation_unknown' && cancel?.result !== 'unknown') fail('Unknown cancellation requires unknown evidence.');
  return {
    id: uuid(value.id, 'Mail alert receipt ID'), installationId: rowInstallationId,
    consentId: uuid(value.consentId, 'Mail alert consent ID'), ruleId: safeIdentifier(value.ruleId, 'Mail alert rule ID'),
    ruleVersion: revision(value.ruleVersion, 'Mail alert rule version'),
    ruleRevision: revision(value.ruleRevision, 'Mail alert rule revision'), timeZone: timeZone(value.timeZone),
    consentActivatedAt: timestamp(value.consentActivatedAt, 'Receipt consent activation time'), accountId: accountIdentifier(value.accountId),
    identityKey: boundedString(value.identityKey, 'Receipt identity key', 2048), connectionGeneration: revision(value.connectionGeneration, 'Receipt connection generation', 0),
    providerMessageId: boundedString(value.providerMessageId, 'Provider message ID', 1024),
    sourceVersion: boundedString(value.sourceVersion, 'Mail source version', 512), receivedAt: timestamp(value.receivedAt, 'Mail received time'),
    desired: value.desired, observed: value.observed as ProactiveMailAlertReceipt['observed'],
    createdAt: timestamp(value.createdAt, 'Receipt creation time'), updatedAt: timestamp(value.updatedAt, 'Receipt update time'),
    attemptedAt, ...(cancel ? { cancellation: cancel } : {}),
  };
}

/** Creates a valid empty ledger for an installation. It carries no consent or notification authority. */
export function emptyProactiveMailAlertState(installationId: string): ProactiveMailAlertState {
  return { schemaVersion: 1, installationId: uuid(installationId, 'Mail alert installation ID'), revision: 0, consents: [], receipts: [] };
}

/** Validates a single consent without manufacturing a synthetic installation or ledger. */
export function validateProactiveMailAlertConsent(value: unknown): ProactiveMailAlertConsent {
  return consent(value);
}

/** Strict bounded validator: malformed rows fail closed; no truncation or unknown-key preservation. */
export function validateProactiveMailAlertState(value: unknown): ProactiveMailAlertState {
  if (!object(value)) fail('Mail alert state is invalid.');
  exactKeys(value, ['schemaVersion', 'installationId', 'revision', 'consents', 'receipts']);
  if (value.schemaVersion !== 1) fail('Mail alert state version is unsupported.');
  const installationId = uuid(value.installationId, 'Mail alert installation ID');
  const stateRevision = revision(value.revision, 'Mail alert state revision', 0);
  if (!Array.isArray(value.consents) || value.consents.length > MAX_MAIL_ALERT_CONSENTS) fail('Mail alert consent limit is exceeded.');
  if (!Array.isArray(value.receipts) || value.receipts.length > MAX_MAIL_ALERT_RECEIPTS) fail('Mail alert receipt limit is exceeded.');
  const consents = value.consents.map(consent);
  if (new Set(consents.map((row) => row.id)).size !== consents.length) fail('Mail alert consent IDs must be unique.');
  if (new Set(consents.map((row) => row.ruleId)).size !== consents.length) fail('Only one current mail alert consent may exist per rule.');
  const receipts = value.receipts.map((row) => receipt(row, installationId));
  if (new Set(receipts.map((row) => row.id)).size !== receipts.length) fail('Mail alert receipt IDs must be unique.');
  const dedupe = new Set<string>();
  for (const row of receipts) {
    if (Date.parse(row.receivedAt) <= Date.parse(row.consentActivatedAt)) fail('Mail alert receipt predates its explicit consent.');
    const key = JSON.stringify([row.consentId, row.accountId, row.identityKey, row.connectionGeneration, row.providerMessageId]);
    if (dedupe.has(key)) fail('Mail alert source has more than one receipt for the same consent identity.');
    dedupe.add(key);
  }
  return { schemaVersion: 1, installationId, revision: stateRevision, consents, receipts };
}
