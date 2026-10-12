import { describe, expect, it } from 'vitest';
import { boundGraphText, extractGmailMessageText } from '../src/connectors/mailText';
import { convertHtmlToText } from '../src/connectors/htmlText';

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

  it('selects plain text and records an omitted mixed HTML branch', () => {
    const result = extractGmailMessageText({ mimeType: 'multipart/mixed', parts: [
      textPart('Plain fragment'), { mimeType: 'text/html', body: { data: encoded('<p>other body fragment</p>') } },
    ] });
    expect(result).toMatchObject({ text: 'Plain fragment', completeness: 'excerpt' });
    expect(result.reasons).toContain('additional_text_part_omitted');
  });

  it('converts HTML-only Gmail bodies without rendering markup', () => {
    const result = extractGmailMessageText({ mimeType: 'text/html', body: { data: encoded('<script>bad()</script><p>body</p>') } }, 'Provider excerpt');
    expect(result).toMatchObject({ text: 'body', representation: 'converted_html', completeness: 'excerpt' });
    expect(result.reasons).toContain('html_non_rendering_conversion');
    expect(result.text).not.toContain('bad()');
  });

  it('uses plain content in multipart/alternative and does not include converted HTML', () => {
    const result = extractGmailMessageText({ mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/html', body: { data: encoded('<p>rich version</p>') } }, textPart('plain version'),
    ] });
    expect(result).toMatchObject({ text: 'plain version', representation: 'plain', completeness: 'complete_text' });
    expect(result.reasons).not.toContain('html_non_rendering_conversion');
  });

  it('prefers readable HTML over a whitespace-only plain alternative', () => {
    const result = extractGmailMessageText({ mimeType: 'multipart/alternative', parts: [
      textPart('  \r\n  '), { mimeType: 'text/html', body: { data: encoded('<p>Readable rich body</p>') } },
    ] });
    expect(result).toMatchObject({ text: 'Readable rich body', representation: 'converted_html', completeness: 'excerpt' });
    expect(result.reasons).toContain('html_non_rendering_conversion');
  });

  it('keeps nested related HTML reasons local when an outer alternative has usable plain text', () => {
    const result = extractGmailMessageText({ mimeType: 'multipart/alternative', parts: [
      { mimeType: 'multipart/related', parts: [{ mimeType: 'text/html', body: { data: encoded('<p>rich body</p>') } }] },
      textPart('Complete plain body'),
    ] });
    expect(result).toMatchObject({ text: 'Complete plain body', representation: 'plain', completeness: 'complete_text' });
    expect(result.reasons).not.toContain('html_non_rendering_conversion');
    expect(result.reasons).not.toContain('html_css_visibility_not_computed');
  });

  it('ignores a broken HTML alternative when usable plain text is selected', () => {
    const result = extractGmailMessageText({ mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/html', body: {} }, textPart('Complete plain body'),
    ] });
    expect(result).toMatchObject({ text: 'Complete plain body', representation: 'plain', completeness: 'complete_text' });
    expect(result.reasons).not.toContain('html_data_missing');
  });

  it('uses the provider snippet when blank plain and malformed HTML alternatives are unreadable', () => {
    const result = extractGmailMessageText({ mimeType: 'multipart/alternative', parts: [
      textPart('  '), { mimeType: 'text/html', body: { data: '%%%bad%%%' } },
    ] }, 'Saved provider excerpt');
    expect(result).toMatchObject({ text: 'Saved provider excerpt', representation: 'snippet', completeness: 'excerpt' });
    expect(result.reasons).toEqual(expect.arrayContaining(['malformed_base64', 'snippet_fallback']));
  });

  it('selects readable HTML over a blank plain body in multipart/mixed', () => {
    const result = extractGmailMessageText({ mimeType: 'multipart/mixed', parts: [
      textPart('  '), { mimeType: 'text/html', body: { data: encoded('<p>Readable mixed body</p>') } },
    ] });
    expect(result).toMatchObject({ text: 'Readable mixed body', representation: 'converted_html', completeness: 'excerpt' });
    expect(result.reasons).toEqual(expect.arrayContaining(['additional_text_part_omitted', 'html_non_rendering_conversion']));
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

    const hostileParts = extractGmailMessageText({ mimeType: 'multipart/mixed', parts: [...Array(128).fill(null), textPart('too late')] }, 'Safe excerpt');
    expect(hostileParts).toMatchObject({ text: 'Safe excerpt', representation: 'snippet', completeness: 'excerpt' });
    expect(hostileParts.reasons).toContain('mime_part_limit');
  });

  it('bounds Graph text with the same UTF-8 policy', () => {
    const result = boundGraphText(`${'x'.repeat(16_383)}😀`);
    expect(result.bytes).toBe(16_383);
    expect(result.text).toHaveLength(16_383);
    expect(result.completeness).toBe('excerpt');
  });
});

describe('non-rendering HTML conversion', () => {
  it('decodes entities, keeps useful spacing and image alt, and excludes link destinations', () => {
    const result = convertHtmlToText('<h2>Trip &amp; costs</h2><p>Hello <strong>there</strong><br>friend <img alt="map"></p><p><a href="https://secret.example">Open</a></p>');
    expect(result.text).toBe('Trip & costs\nHello there\nfriend [Image: map]\nOpen');
    expect(result.text).not.toContain('secret.example');
    expect(result.reasons).toContain('html_non_rendering_conversion');
    expect(result.reasons).toContain('html_css_visibility_not_computed');
    expect(result.reasons).toContain('html_link_destination_omitted');
  });

  it('omits hidden and active content, while retaining preformatted newlines and reporting omitted code', () => {
    const result = convertHtmlToText('<p>shown</p><div hidden>hidden</div><div aria-hidden="TRUE">hidden</div><div style="display:none">hidden</div><div style="visibility: hidden">hidden</div><style>.x{}</style><script>bad()</script><code>secret code</code><pre>row one\nrow two</pre>');
    expect(result.text).toBe('shown\nrow one\nrow two');
    expect(result.reasons).toContain('html_code_omitted');
    expect(result.reasons).toContain('html_hidden_content_omitted');
    expect(result.reasons).toContain('html_active_content_omitted');
    expect(result.text).not.toMatch(/hidden|bad|secret/);
  });

  it('marks list items with bullets and table cells with separators', () => {
    const result = convertHtmlToText('<ul><li>First</li><li>Second</li></ul><table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>');
    expect(result.text).toBe('• First\n• Second\nA | B\nC | D');
  });

  it('separates image alt from adjacent inline text and records blocked embeds', () => {
    const result = convertHtmlToText('<p>Before<img alt="map">After</p><embed src="https://secret.example">');
    expect(result.text).toBe('Before [Image: map] After');
    expect(result.reasons).toContain('html_active_content_omitted');
    expect(result.text).not.toContain('secret.example');
  });

  it('produces the stable selected-message excerpt used by the demo fixture', () => {
    const html = '<p>Project discussion: Could you send the revised timeline by Friday?</p><p>Owners &amp; next steps:</p><ul><li>Confirm release owner</li><li>Share updated dates</li></ul><p>Image: <img alt="Roadmap preview" src="https://assets.invalid/roadmap.png"></p><p><a href="https://secret.example/path">Open project plan</a></p><p hidden>Hidden details must not appear.</p><script>window.secret = true;</script><style>.private{display:none}</style><pre><code>token=do-not-include</code></pre>';
    const result = convertHtmlToText(html);
    expect(result.text).toBe('Project discussion: Could you send the revised timeline by Friday?\nOwners & next steps:\n• Confirm release owner\n• Share updated dates\nImage: [Image: Roadmap preview]\nOpen project plan');
    expect(result.reasons).toEqual(expect.arrayContaining(['html_hidden_content_omitted', 'html_active_content_omitted', 'html_link_destination_omitted', 'html_code_omitted']));
  });

  it('handles malformed and unclosed markup as a bounded excerpt', () => {
    const result = convertHtmlToText('<div><p>Readable &amp; safe');
    expect(result.text).toBe('Readable & safe');
    expect(result.reasons).toContain('html_unclosed_tags');
  });

  it('normalizes astral text on a UTF-8 boundary and enforces input and output caps', () => {
    const astral = convertHtmlToText(`<p>${'x'.repeat(16_380)}🙂tail</p>`);
    expect(new TextEncoder().encode(astral.text).byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(astral.reasons).toContain('html_output_byte_limit');
    expect(astral.text).not.toContain('\uFFFD');

    const inputLimited = convertHtmlToText(`<p>${'a'.repeat(270 * 1024)}</p>`);
    expect(inputLimited.text).toBe('');
    expect(inputLimited.reasons).toContain('html_input_byte_limit');
  });

  it('enforces nesting, tag, attribute, and callback limits', () => {
    expect(convertHtmlToText(`${'<div>'.repeat(66)}x`).reasons).toContain('html_depth_limit');
    expect(convertHtmlToText('<i></i>'.repeat(4100)).reasons).toContain('html_tag_limit');
    const oversizedAlt = convertHtmlToText(`<img alt="${'a'.repeat(2049)}">`);
    expect(oversizedAlt.text).toBe('');
    expect(oversizedAlt.reasons).toContain('html_attribute_limit');
    expect(convertHtmlToText(`<div ${'a '.repeat(33_000)}>`).reasons).toContain('html_callback_limit');
  });

  it('does not create readable text from whitespace-only HTML', () => {
    expect(convertHtmlToText('<p> &nbsp; </p>').text).toBe('');
    const result = extractGmailMessageText({ mimeType: 'text/html', body: { data: encoded('<p> &nbsp; </p>') } }, 'Provider snippet');
    expect(result).toMatchObject({ text: 'Provider snippet', representation: 'snippet', completeness: 'excerpt' });
  });
});
