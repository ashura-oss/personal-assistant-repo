import { isValidTimeZone } from './index';

export type ReminderLocalDateTimeResolution = string[];

function localValue(value: string): { year: number; month: number; day: number; hour: number; minute: number; epoch: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, y, m, d, h, min] = match;
  const year = Number(y), month = Number(m), day = Number(d), hour = Number(h), minute = Number(min);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59) return undefined;
  const epoch = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const check = new Date(epoch);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) return undefined;
  return { year, month, day, hour, minute, epoch };
}

function zonedParts(epoch: number, timeZone: string): number[] | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(epoch));
    const values = new Map<string, number>(parts.map((part) => [part.type, Number(part.value)] as [string, number]));
    const result = ['year', 'month', 'day', 'hour', 'minute'].map((part) => values.get(part) ?? NaN);
    return result.every(Number.isFinite) ? result : undefined;
  } catch { return undefined; }
}

function offsetAt(epoch: number, timeZone: string): number | undefined {
  const parts = zonedParts(epoch, timeZone);
  if (!parts) return undefined;
  const [year, month, day, hour, minute] = parts;
  const localAsUtc = Date.UTC(year!, month! - 1, day, hour, minute);
  return (localAsUtc - Math.floor(epoch / 60_000) * 60_000) / 60_000;
}

/**
 * Resolve a wall-clock minute without guessing through DST gaps or folds.
 * Returns zero instants for invalid/nonexistent input, one normally, and two in a fold.
 */
export function resolveReminderLocalDateTime(localDateTime: string, timeZone: string): ReminderLocalDateTimeResolution {
  const local = typeof localDateTime === 'string' ? localValue(localDateTime) : undefined;
  if (!local || !isValidTimeZone(timeZone)) return [];
  const offsets = new Set<number>();
  const searchWindow = 48 * 60 * 60_000;
  const step = 3 * 60 * 60_000;
  for (let delta = -searchWindow; delta <= searchWindow; delta += step) {
    const offset = offsetAt(local.epoch + delta, timeZone);
    if (offset !== undefined && Number.isFinite(offset) && Math.abs(offset) <= 24 * 60) offsets.add(offset);
  }
  const matches = new Set<number>();
  for (const offset of offsets) {
    const candidate = local.epoch - offset * 60_000;
    const parts = zonedParts(candidate, timeZone);
    if (parts && parts[0] === local.year && parts[1] === local.month && parts[2] === local.day && parts[3] === local.hour && parts[4] === local.minute) matches.add(candidate);
  }
  const result = [...matches].sort((left, right) => left - right).map((epoch) => new Date(epoch).toISOString());
  return result.length <= 2 ? result : [];
}
