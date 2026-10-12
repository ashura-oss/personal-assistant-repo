import { describe, expect, it } from 'vitest';
import { boundGraphText, extractGmailMessageText } from '../src/connectors/mailText';

const encoded = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};
const textPart = (text: string, extra: Record<string, unknown> = {}) => ({ mimeType: 'text/plain', body: { data: encoded(text) }, ...extra });

describe('selected mail text extraction', () => {
  it('chooses plain text from multipart/alternative without concatenating HTML', () => {
    const result = extractGmailMessageText({ mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/html', body: { data: encoded('<p>HTML copy</p>') } }, textPart('Plain copy'),
    ] });
    expect(result).toMatchObject({ text: 'Plain copy', representation: 'plain', completeness: 'complete_text', bytes: 10 });
    expect(result.text).not.toContain('HTML copy');
    expect(result.reasons).not.toContain('html_conversion_unavailable');
  });

  it.each([
    ['second text part', { mimeType: 'text/plain', body: { data: encoded('second body') } }, 'additional_text_part_omitted'],
    ['malformed text sibling', { mimeType: 'text/plain', body: { data: '%%%bad%%%' } }, 'malformed_base64'],
    ['missing nested parts', { mimeType: 'multipart/related' }, 'malformed_mime_parts'],
  ])('marks omitted %s as an excerpt while preserving the selected plain text', (_label, omitted, reason) => {
    const result = extractGmailMessageText({ mimeType: 'multipart/mixed', parts: [textPart('Selected body'), omitted] });
    expect(result).toMatchObject({ text: 'Selected body', representation: 'plain', completeness: 'excerpt' });
    expect(result.reasons).toContain(reason);
  });

  it('keeps multipart/alternative HTML as a harmless alternative when plain text is complete', () => {
    const result = extractGmailMessageText({ mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/html', body: { data: encoded('<p>alternate</p>') } }, textPart('Complete plain body'),
    ] });
    expect(result).toMatchObject({ text: 'Complete plain body', completeness: 'complete_text' });
    expect(result.reasons).not.toContain('html_conversion_unavailable');
  });

  it('marks an unsupported mixed HTML fragment as incomplete beside plain text', () => {
    const result = extractGmailMessageText({ mimeType: 'multipart/mixed', parts: [
      textPart('Plain fragment'), { mimeType: 'text/html', body: { data: encoded('<p>other body fragment</p>') } },
    ] });
    expect(result).toMatchObject({ text: 'Plain fragment', completeness: 'excerpt' });
    expect(result.reasons).toContain('html_conversion_unavailable');
  });

  it('uses a labeled snippet for HTML-only and never strips or renders HTML', () => {
    const result = extractGmailMessageText({ mimeType: 'text/html', body: { data: encoded('<script>bad()</script><p>body</p>') } }, 'Provider excerpt');
    expect(result).toMatchObject({ text: 'Provider excerpt', representation: 'snippet', completeness: 'excerpt' });
    expect(result.reasons).toContain('html_conversion_unavailable');
  });

  it('omits attachment, external attachment body, and embedded-message text', () => {
    const result = extractGmailMessageText({ mimeType: 'multipart/mixed', parts: [
      textPart('Main body'), textPart('Attached text', { filename: 'readme.txt' }),
      textPart('Inline file text', { headers: [{ name: 'Content-Disposition', value: 'inline; filename="inline.txt"' }] }),
      { mimeType: 'text/plain', body: { attachmentId: 'external-body' } },
      { mimeType: 'message/rfc822', body: { data: encoded('quoted message') } },
    ] });
    expect(result).toMatchObject({ text: 'Main body', representation: 'plain', completeness: 'excerpt' });
    expect(result.reasons).toEqual(expect.arrayContaining(['attachment_omitted', 'attachment_body_unavailable', 'embedded_message_omitted']));
    expect(result.text).not.toContain('Attached text');
    expect(result.text).not.toContain('Inline file text');
  });

  it('does not mark an ordinary filename attachment incomplete when plain text is complete', () => {
    const result = extractGmailMessageText({ mimeType: 'multipart/mixed', parts: [
      textPart('Main body'), textPart('Attachment text', { filename: 'readme.txt' }),
    ] });
    expect(result).toMatchObject({ text: 'Main body', completeness: 'complete_text' });
    expect(result.reasons).toContain('attachment_omitted');
  });

  it.each([
    ['bad_base64', { mimeType: 'text/plain', body: { data: '%%%not-base64%%%' } }, 'malformed_base64'],
    ['unknown charset', { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=windows-1252' }], body: { data: encoded('hello') } }, 'unsupported_charset'],
    ['invalid utf8', { mimeType: 'text/plain', body: { data: '_w' } }, 'malformed_text'],
  ])('falls back with an explicit reason for %s', (_label, part, reason) => {
    const result = extractGmailMessageText(part, 'Safe snippet');
    expect(result).toMatchObject({ text: 'Safe snippet', representation: 'snippet', completeness: 'excerpt' });
    expect(result.reasons).toContain(reason);
  });

  it('treats an empty base64 body as empty text rather than malformed encoding', () => {
    const result = extractGmailMessageText({ mimeType: 'text/plain', body: { data: '' } });
    expect(result).toMatchObject({ representation: 'plain', completeness: 'complete_text', bytes: 0, text: '' });
    expect(result.reasons).toEqual([]);
  });

  it('truncates plain text to 16 KiB on a UTF-8 codepoint boundary', () => {
    const result = extractGmailMessageText(textPart(`${'a'.repeat(16_383)}😀tail`));
    expect(result.completeness).toBe('excerpt');
    expect(result.bytes).toBeLessThanOrEqual(16 * 1024);
    expect(result.text?.endsWith('😀')).toBe(false);
    expect(result.text?.endsWith('a')).toBe(true);
    expect(result.reasons).toContain('text_byte_limit');
  });

  it('marks depth and part traversal limits as incomplete', () => {
    let nested: unknown = textPart('too deep');
    for (let i = 0; i < 14; i++) nested = { mimeType: 'multipart/mixed', parts: [nested] };
    const depthResult = extractGmailMessageText(nested, 'excerpt');
    expect(depthResult.reasons).toContain('mime_depth_limit');
    expect(depthResult.completeness).toBe('excerpt');

    const partsResult = extractGmailMessageText({ mimeType: 'multipart/mixed', parts: Array.from({ length: 130 }, (_, i) => textPart(i === 0 ? 'first' : `part-${i}`)) });
    expect(partsResult.text).toBe('first');
    expect(partsResult.reasons).toContain('mime_part_limit');
    expect(partsResult.completeness).toBe('excerpt');
  });

  it('bounds Graph text with the same UTF-8 policy', () => {
    const result = boundGraphText(`${'x'.repeat(16_383)}😀`);
    expect(result.bytes).toBe(16_383);
    expect(result.text).toHaveLength(16_383);
    expect(result.completeness).toBe('excerpt');
  });
});
