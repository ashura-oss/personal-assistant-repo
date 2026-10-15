import type { EmailProposalPayload, MailReplyProvenance, MailReplySourceSnapshot } from '../core';

const HASH = /^[a-f\d]{64}$/i;
const EMAIL = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;

function fail(message: string): never { throw new Error(message); }
function clean(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || (allowEmpty && value.length > 0 && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label} is invalid.`);
  return value;
}
function validEmail(value: string): boolean { return value.length <= 320 && EMAIL.test(value) && !/[\r\n]/.test(value); }
function mailboxAddress(value: string, label: string): string {
  const trimmed = clean(value, label, 998).trim();
  const angle = /<([^<>]+)>\s*$/.exec(trimmed);
  const address = angle ? angle[1].trim() : trimmed;
  if (!validEmail(address)) fail(`${label} is invalid.`);
  return address;
}
function messageId(value: unknown, label: string): string {
  const result = clean(value, label, 998);
  const atom = "A-Za-z0-9!#$%&'*+\\/=?^_`{|}~-";
  const local = `[${atom}]+(?:\\.[${atom}]+)*`;
  const domain = '(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\\[(?:IPv6:)?[A-Fa-f0-9:.]+\\])';
  if (!new RegExp(`^<${local}@${domain}>$`).test(result)) fail(`${label} is not a valid RFC message ID.`);
  return result;
}
function canonicalTime(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${label} is invalid.`);
  return value;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function normalizedIdentity(identity: MailReplySourceSnapshot['identity']): Record<string, string> {
  if (!identity.providerNamespace || !identity.clientId || !identity.subject ||
      (identity.providerNamespace === 'microsoft' && !identity.resourceUserId)) fail('Verified mail account identity is incomplete.');
  return {
    providerNamespace: identity.providerNamespace, clientId: clean(identity.clientId, 'Client ID', 256),
    subject: clean(identity.subject, 'Account subject', 512), ...(identity.issuer ? { issuer: clean(identity.issuer, 'Identity issuer', 512) } : {}),
    ...(identity.tenantId ? { tenantId: clean(identity.tenantId, 'Tenant ID', 256) } : {}),
    ...(identity.resourceUserId ? { resourceUserId: clean(identity.resourceUserId, 'Resource user ID', 512) } : {}),
  };
}

/** Validates all source facts used to create a reply. Observation/generation are not digest inputs. */
export function canonicalMailReplySource(value: MailReplySourceSnapshot): string {
  if (!value || value.version !== 1 || !['gmail', 'graph-immutable'].includes(value.idFormat)) fail('Mail reply source is invalid.');
  const identity = normalizedIdentity(value.identity);
  clean(value.accountId, 'Account ID', 256);
  clean(value.localMessageId, 'Local message ID', 256);
  clean(value.providerMessageId, 'Provider message ID', 1024);
  if (value.providerVersion !== undefined) clean(value.providerVersion, 'Provider message version', 512);
  if (!Number.isSafeInteger(value.connectionGeneration) || value.connectionGeneration < 0) fail('Mail connection generation is invalid.');
  if (value.threadId !== undefined) clean(value.threadId, 'Provider thread ID', 1024);
  mailboxAddress(value.accountEmail, 'Connected account email');
  const verifiedSelfEmail = value.verifiedSelfEmail === undefined ? undefined : mailboxAddress(value.verifiedSelfEmail, 'Verified connected email');
  const internetMessageId = messageId(value.internetMessageId, 'Internet message ID');
  let references: string[] = [];
  if (value.references !== undefined) {
    const text = clean(value.references, 'References header', 8192);
    if (/[\r\n]/.test(text)) fail('References header contains invalid line breaks.');
    references = text.trim().split(/\s+/).filter(Boolean).map((item) => messageId(item, 'References entry'));
  }
  const inReplyTo = value.inReplyTo === undefined ? undefined : messageId(value.inReplyTo, 'In-Reply-To header');
  const subject = clean(value.subject, 'Source subject', 998, true);
  if (/[\r\n]/.test(subject)) fail('Source subject contains invalid line breaks.');
  const from = value.from === undefined ? undefined : clean(value.from, 'From header', 998);
  const senderEmail = value.senderEmail === undefined ? undefined : mailboxAddress(value.senderEmail, 'Sender address');
  const addresses = (list: string[] | undefined, label: string): string[] | undefined => {
    if (list === undefined) return undefined;
    if (!Array.isArray(list) || list.length > 100) fail(`${label} is invalid.`);
    return list.map((item) => mailboxAddress(item, label));
  };
  if (value.replyMetadataComplete !== true) fail('Reply metadata is incomplete.');
  clean(value.snippet ?? '', 'Message snippet', 2000, true);
  canonicalTime(value.observedAt, 'Message observation time');
  return stable({
    version: 1, accountId: value.accountId, accountEmail: value.accountEmail, verifiedSelfEmail: verifiedSelfEmail ?? null,
    identity, localMessageId: value.localMessageId, providerMessageId: value.providerMessageId,
    idFormat: value.idFormat, providerVersion: value.providerVersion ?? null, threadId: value.threadId ?? null, internetMessageId, references, inReplyTo: inReplyTo ?? null,
    subject, from: from ?? null, senderEmail: senderEmail ?? null, replyTo: addresses(value.replyTo, 'Reply-To address') ?? null,
    to: addresses(value.to, 'To address') ?? null, cc: addresses(value.cc, 'Cc address') ?? null,
    snippet: value.snippet ?? null, replyMetadataComplete: value.replyMetadataComplete,
  });
}

export async function createMailReplySource(
  value: Omit<MailReplySourceSnapshot, 'sourceDigest'>,
  sha256: (canonical: string) => Promise<string>,
): Promise<MailReplySourceSnapshot> {
  const candidate = { ...value, sourceDigest: '0'.repeat(64) } as MailReplySourceSnapshot;
  const canonical = canonicalMailReplySource(candidate);
  const sourceDigest = await sha256(canonical);
  if (!HASH.test(sourceDigest)) fail('Mail reply source digest is invalid.');
  return { ...candidate, sourceDigest: sourceDigest.toLowerCase() };
}

export async function validateMailReplySource(
  value: MailReplySourceSnapshot,
  sha256: (canonical: string) => Promise<string>,
): Promise<boolean> {
  if (!HASH.test(value.sourceDigest)) return false;
  return (await sha256(canonicalMailReplySource(value))).toLowerCase() === value.sourceDigest.toLowerCase();
}

function uniqueAddresses(values: string[], accountEmail?: string): string[] {
  const seen = new Set<string>(accountEmail ? [accountEmail.toLowerCase()] : []);
  const output: string[] = [];
  for (const raw of values) {
    const address = mailboxAddress(raw, 'Recipient');
    const key = address.toLowerCase();
    if (!seen.has(key)) { output.push(address); seen.add(key); }
  }
  return output;
}

export function defaultReplyRecipients(source: MailReplySourceSnapshot, accountEmail: string | undefined, mode: 'reply' | 'reply_all'): { to: string[]; cc: string[] } {
  const self = accountEmail ? mailboxAddress(accountEmail, 'Verified connected email') : undefined;
  const primary = source.replyTo?.length ? source.replyTo : source.from ? [mailboxAddress(source.from, 'From address')] : source.senderEmail ? [source.senderEmail] : [];
  if (!primary.length) fail('The message has no safe Reply-To or From address.');
  const to = uniqueAddresses([...primary, ...(mode === 'reply_all' ? source.to ?? [] : [])], self);
  const toKeys = new Set(to.map((item) => item.toLowerCase()));
  const cc = mode === 'reply_all' ? uniqueAddresses(source.cc ?? [], self).filter((item) => !toKeys.has(item.toLowerCase())) : [];
  if (to.length > 100 || cc.length > 100) fail('Reply recipients exceed the supported limit.');
  return { to, cc };
}

export function replyReferences(source: MailReplySourceSnapshot): string | undefined {
  const original = source.references?.trim().split(/\s+/).filter(Boolean) ?? [];
  const values = [...original];
  if (!values.some((item) => item === source.internetMessageId)) values.push(source.internetMessageId);
  const result = values.join(' ');
  if (result.length > 8192) fail('The References header is too long to reply safely.');
  return result || undefined;
}

export function validateReplyBinding(payload: EmailProposalPayload, provenance: MailReplyProvenance, expectedOperation: 'draft' | 'send' = 'draft'): void {
  const source = provenance.source;
  if (payload.operation !== expectedOperation || !payload.reply || payload.reply.mode !== 'reply' && payload.reply.mode !== 'reply_all') fail('Mail reply operation does not match its reviewed operation.');
  if (!Array.isArray(payload.bcc) || !Array.isArray(payload.attachments) || payload.bcc.length || payload.attachments.length) fail('Reply drafts cannot add Bcc recipients or attachments.');
  if (provenance.version !== 2 || provenance.kind !== 'mail_reply' || source.sourceDigest !== provenance.sourceDigest ||
      payload.reply.sourceDigest !== source.sourceDigest || payload.reply.localMessageId !== source.localMessageId ||
      payload.reply.providerMessageId !== source.providerMessageId || payload.reply.idFormat !== source.idFormat ||
      payload.reply.internetMessageId !== source.internetMessageId || payload.reply.threadId !== source.threadId ||
      payload.reply.sourceSubject !== source.subject || payload.subject !== source.subject ||
      payload.reply.references !== replyReferences(source) || payload.reply.inReplyTo !== (source.internetMessageId || source.inReplyTo)) {
    fail('Reply draft is not bound to the verified original message.');
  }
  clean(payload.text, 'Reply body', provenance.outputPolicyVersion === 2 ? Number.MAX_SAFE_INTEGER : 100_000, true);
  if (!payload.to.length || payload.to.length > 100 || payload.cc.length > 100) fail('Reply recipient list is invalid.');
  for (const recipient of [...payload.to, ...payload.cc]) if (!validEmail(recipient)) fail('Reply recipient address is invalid.');
}

export type { MailReplyProvenance, MailReplySourceSnapshot } from '../core';
