/** Formats an actual provider-reported USD value without rounding away small charges. */
export function formatProviderReportedCostUsd(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return `US$${value === 0 ? value.toFixed(8) : String(value)}`;
}
