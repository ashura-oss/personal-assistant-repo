import { createHash } from 'node:crypto';
export const CryptoDigestAlgorithm = { SHA256: 'SHA-256' };
export const CryptoEncoding = { HEX: 'hex' };
let uuidCounter = 0;
export function randomUUID() {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, '0')}`;
}
export async function digestStringAsync(_algorithm: string, value: string) { return createHash('sha256').update(value).digest('hex'); }
