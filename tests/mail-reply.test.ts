import { describe, expect, it } from 'vitest';
import type { MailReplySourceSnapshot } from '../src/core';
import { canonicalMailReplySource, defaultReplyRecipients, replyReferences } from '../src/mailReply';

function source(overrides: Partial<MailReplySourceSnapshot> = {}): MailReplySourceSnapshot {
  return {
    version: 1, accountId: 'account-1', accountEmail: 'display@example.test', verifiedSelfEmail: 'me@example.test',
    identity: { providerNamespace: 'google', clientId: 'client-1', subject: 'subject-1' }, connectionGeneration: 2,
    localMessageId: 'local-1', providerMessageId: 'provider-1', idFormat: 'gmail', providerVersion: 'etag-1',
    threadId: 'thread-1', internetMessageId: '<message@example.test>', references: '<parent@example.test>',
    subject: 'Hello', from: 'Me <me@example.test>', senderEmail: 'me@example.test', replyTo: ['me@example.test'],
    to: ['me@example.test', 'alex@example.test'], cc: ['casey@example.test'], replyMetadataComplete: true,
    observedAt: '2026-10-12T01:00:00.000Z', sourceDigest: 'a'.repeat(64), ...overrides,
  };
}

describe('mail reply source binding', () => {
  it('keeps Reply all available when Reply-To resolves only to the verified self address', () => {
    expect(defaultReplyRecipients(source(), 'me@example.test', 'reply')).toEqual({ to: [], cc: [] });
    expect(defaultReplyRecipients(source(), 'me@example.test', 'reply_all')).toEqual({
      to: ['alex@example.test'], cc: ['casey@example.test'],
    });
  });

  it('binds the provider message version and appends the original message ID once', () => {
    const original = source();
    const changed = source({ providerVersion: 'etag-2' });
    expect(canonicalMailReplySource(original)).not.toBe(canonicalMailReplySource(changed));
    expect(replyReferences(original)).toBe('<parent@example.test> <message@example.test>');
    expect(replyReferences(source({ references: '<message@example.test>' }))).toBe('<message@example.test>');
  });
});
