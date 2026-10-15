/** Account identifiers are opaque snapshot-owned strings; workspace, owner, session, and command IDs remain UUIDs. */
export function isValidAccountId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const bytes = Buffer.from(value, 'utf8');
  return bytes.byteLength <= 1024 && bytes.toString('utf8') === value;
}
