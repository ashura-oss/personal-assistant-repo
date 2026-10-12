import { createHash } from 'node:crypto';
export const CryptoDigestAlgorithm = { SHA256: 'SHA-256' };
export const CryptoEncoding = { HEX: 'hex' };
export async function digestStringAsync(_algorithm: string, value: string) { return createHash('sha256').update(value).digest('hex'); }
