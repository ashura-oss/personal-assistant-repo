/** Account identifiers are opaque snapshot-owned values; other ID types keep their own rules. */
export function isValidAccountId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  let byteLength = 0;
  for (const point of value) {
    const codePoint = point.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
    byteLength += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (byteLength > 1024) return false;
  }
  return true;
}
