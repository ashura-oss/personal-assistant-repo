/** Canonical UUID IDs used by knowledge entities (including imported UUIDv7 IDs). */
const CANONICAL_KNOWLEDGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalKnowledgeId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_KNOWLEDGE_UUID.test(value);
}
