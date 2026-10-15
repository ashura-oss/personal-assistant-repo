/** Maximum canonical JSON source tuple size from namespace/account/provider component rules. */
export const MAX_PROACTIVE_SOURCE_ID =
  10 + // JSON array brackets, separators, and three quoted values
  (6 * 128) + // Namespace: up to 128 UTF-16 units, including lone-surrogate JSON escapes
  (2 * 1024) + // Account ID: valid Unicode, but quotes and backslashes may double
  (6 * 1024); // Provider ID: up to 1,024 UTF-16 units, including lone-surrogate escapes

const MAX_JSON_STRING_VALUE = (maxUtf16Units: number) => 2 + 6 * maxUtf16Units;
const MAX_ESCAPED_SOURCE_ID_VALUE = 2 + 2 * MAX_PROACTIVE_SOURCE_ID;
const MAX_SAFE_INTEGER_DECIMAL_UNITS = 16;

/** JSON composite [ruleId, revision, sourceId, sourceVersion] under current field bounds. */
export const MAX_PROACTIVE_CANDIDATE_ID =
  5 + // Four-item array brackets and separators
  MAX_JSON_STRING_VALUE(160) +
  MAX_SAFE_INTEGER_DECIMAL_UNITS +
  MAX_ESCAPED_SOURCE_ID_VALUE +
  MAX_JSON_STRING_VALUE(512);

/** JSON composite [ruleId, sourceId] used as a snooze suppression key. */
export const MAX_PROACTIVE_SUPPRESSION_KEY = 3 + MAX_JSON_STRING_VALUE(160) + MAX_ESCAPED_SOURCE_ID_VALUE;
