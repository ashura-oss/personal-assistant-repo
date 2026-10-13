import { Parser, type Handler } from 'htmlparser2';

export interface HtmlTextConversion {
  text: string;
  reasons: string[];
}

const MAX_HTML_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_DEPTH = 64;
const MAX_TAGS = 4096;
const MAX_CALLBACKS = 32768;
const MAX_ATTRIBUTE_LENGTH = 2048;
const OMIT_CONTENT = new Set(['head', 'script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'code']);
const BLOCKS = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function utf8Length(value: string): number { return new TextEncoder().encode(value).byteLength; }

function boundedHtml(value: string): { text: string; truncated: boolean } {
  let text = '';
  let bytes = 0;
  for (const character of value) {
    const size = utf8Length(character);
    if (bytes + size > MAX_HTML_BYTES) return { text, truncated: true };
    text += character;
    bytes += size;
  }
  return { text, truncated: false };
}

function safeAttributes(attributes: Record<string, string>, reasons: Set<string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ['alt', 'aria-hidden', 'hidden', 'style']) {
    const value = attributes[key];
    if (typeof value !== 'string') continue;
    if (value.length > MAX_ATTRIBUTE_LENGTH) {
      reasons.add('html_attribute_limit');
      continue;
    }
    result[key] = value;
  }
  return result;
}

/** Converts bounded HTML into a conservative text excerpt using parser callbacks only. */
export function convertHtmlToText(html: string): HtmlTextConversion {
  const reasons = new Set<string>(['html_non_rendering_conversion', 'html_css_visibility_not_computed']);
  const bounded = boundedHtml(html);
  if (bounded.truncated) {
    reasons.add('html_input_byte_limit');
    return { text: '', reasons: [...reasons] };
  }

  const chunks: string[] = [];
  let outputBytes = 0;
  let callbacks = 0;
  let tags = 0;
  let stopped = false;
  let parser: Parser | undefined;
  let pendingSpace = false;
  let openAttributes: Record<string, string> = {};
  let currentTag = '';
  let openHasLinkDestination = false;
  const stack: { name: string; skip: boolean; pre: boolean }[] = [];

  const stop = (reason: string) => {
    reasons.add(reason);
    stopped = true;
    parser?.pause();
  };
  const tick = () => {
    callbacks++;
    if (callbacks > MAX_CALLBACKS) stop('html_callback_limit');
    return !stopped;
  };
  const last = () => chunks[chunks.length - 1] ?? '';
  const appendCharacter = (character: string): boolean => {
    const size = utf8Length(character);
    if (outputBytes + size > MAX_OUTPUT_BYTES) { stop('html_output_byte_limit'); return false; }
    chunks.push(character);
    outputBytes += size;
    return true;
  };
  const appendText = (value: string, preserve: boolean) => {
    for (const character of value) {
      if (stopped) return;
      if (!preserve && /\s/u.test(character)) {
        pendingSpace = true;
        continue;
      }
      if (pendingSpace && chunks.length && !/[\s]$/u.test(last())) {
        if (!appendCharacter(' ')) return;
      }
      pendingSpace = false;
      if (!appendCharacter(character)) return;
    }
  };
  const separator = (kind: 'space' | 'line' | 'cell') => {
    pendingSpace = false;
    if (!chunks.length) return;
    if (kind === 'line') {
      if (last() !== '\n') appendCharacter('\n');
    } else if (kind === 'cell') {
      if (!/[\s]$/u.test(last())) appendText(' | ', true);
    } else if (!/[\s]$/u.test(last())) appendCharacter(' ');
  };
  const hiddenByAttributes = (attributes: Record<string, string>) => {
    const safe = safeAttributes(attributes, reasons);
    return Object.hasOwn(safe, 'hidden') || safe['aria-hidden']?.trim().toLowerCase() === 'true' ||
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!\s*important\s*)?(?:;|$)/i.test(safe.style ?? '');
  };

  const callbacksHandler: Partial<Handler> = {
    onparserinit: (instance) => { parser = instance; tick(); },
    onopentagname: (name) => {
      currentTag = name;
      openAttributes = {};
      openHasLinkDestination = false;
      if (tick()) { tags++; if (tags > MAX_TAGS) stop('html_tag_limit'); }
    },
    onattribute: (name, value) => {
      if (!tick()) return;
      if (currentTag === 'a' && name === 'href') openHasLinkDestination = true;
      if (name === 'hidden') { openAttributes.hidden = ''; return; }
      if (!['alt', 'aria-hidden', 'hidden', 'style'].includes(name)) return;
      if (value.length > MAX_ATTRIBUTE_LENGTH) reasons.add('html_attribute_limit');
      else openAttributes[name] = value;
    },
    onopentag: (name) => {
      if (!tick()) return;
      const parent = stack[stack.length - 1];
      const depth = stack.length + 1;
      if (depth > MAX_DEPTH) { stop('html_depth_limit'); return; }
      const attributes = openAttributes;
      openAttributes = {};
      const ownHidden = hiddenByAttributes(attributes);
      const hidden = Boolean(parent?.skip) || OMIT_CONTENT.has(name) || ownHidden;
      if (ownHidden) reasons.add('html_hidden_content_omitted');
      if (OMIT_CONTENT.has(name) && name !== 'code') reasons.add('html_active_content_omitted');
      if (name === 'a' && openHasLinkDestination) reasons.add('html_link_destination_omitted');
      const pre = Boolean(parent?.pre) || name === 'pre';
      stack.push({ name, skip: hidden, pre });
      if (hidden) {
        if (name === 'code') reasons.add('html_code_omitted');
      } else if (name === 'img') {
        const alt = safeAttributes(attributes, reasons).alt;
        if (alt) {
          separator('space');
          appendText(`[Image: ${alt}]`, false);
          separator('space');
        }
      } else if (!parent?.skip && (BLOCKS.has(name) || name === 'br')) {
        separator('line');
      } else if (!parent?.skip && name === 'li') {
        separator('line');
        appendText('• ', true);
      } else if (!parent?.skip && (name === 'td' || name === 'th')) separator('cell');
      if (VOID.has(name)) stack.pop();
    },
    ontext: (value) => {
      if (!tick()) return;
      if (!stack.some((entry) => entry.skip)) appendText(value, Boolean(stack[stack.length - 1]?.pre));
    },
    onclosetag: (name, implied) => {
      if (!tick()) return;
      const index = stack.map((entry) => entry.name).lastIndexOf(name);
      if (index < 0) return;
      const [closed] = stack.splice(index);
      if (implied && !stopped) reasons.add('html_unclosed_tags');
      if (!closed.skip && (BLOCKS.has(name) || name === 'br' || name === 'li' || name === 'tr')) separator('line');
    },
    oncomment: () => { tick(); },
    onprocessinginstruction: () => { tick(); },
    oncdatastart: () => { tick(); },
    oncdataend: () => { tick(); },
    onerror: () => { tick(); reasons.add('html_parse_error'); },
  };

  try {
    parser = new Parser(callbacksHandler, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
    parser.end(bounded.text);
  } catch {
    reasons.add('html_parse_error');
  }

  const normalized = chunks.join('').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').normalize('NFC').trim();
  let output = '';
  let finalBytes = 0;
  for (const character of normalized) {
    const size = utf8Length(character);
    if (finalBytes + size > MAX_OUTPUT_BYTES) { reasons.add('html_output_byte_limit'); break; }
    output += character;
    finalBytes += size;
  }
  return { text: output, reasons: [...reasons].slice(0, 16) };
}
