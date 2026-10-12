import { describe, expect, it } from 'vitest';
import { validSelectedMailTextSnapshot } from '../src/mailText';

const validSnapshot = (overrides: Record<string, unknown> = {}) => ({
  version: 1, messageId: 'local-1', accountId: 'account-1', identityKey: 'google:client:subject:',
  identity: { providerNamespace: 'google', clientId: 'client', subject: 'subject' }, connectionGeneration: 1,
  providerMessageId: 'provider-1', idFormat: 'gmail', sourceDigest: 'a'.repeat(64), checkedAt: '2026-10-13T00:00:00.000Z',
  text: 'selected body', textDigest: 'b'.repeat(64), bytes: 13, extractionVersion: 'mail-text-v1',
  representation: 'plain', completeness: 'complete_text', omissionReasons: [], ...overrides,
});

describe('selected mail text snapshot versions', () => {
  it('keeps legacy v1 snapshots valid and accepts only excerpted converted HTML in v2', () => {
    expect(validSelectedMailTextSnapshot(validSnapshot())).toBe(true);
    expect(validSelectedMailTextSnapshot(validSnapshot({
      extractionVersion: 'mail-text-v2', representation: 'converted_html', completeness: 'excerpt',
    }))).toBe(true);
    expect(validSelectedMailTextSnapshot(validSnapshot({
      extractionVersion: 'mail-text-v1', representation: 'converted_html', completeness: 'excerpt',
    }))).toBe(false);
    expect(validSelectedMailTextSnapshot(validSnapshot({
      extractionVersion: 'mail-text-v2', representation: 'converted_html', completeness: 'complete_text',
    }))).toBe(false);
    expect(validSelectedMailTextSnapshot(validSnapshot({ representation: 'none' }))).toBe(false);
  });
});
