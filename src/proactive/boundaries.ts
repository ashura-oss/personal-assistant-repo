import { evaluateProactive } from './index';
import type { ProactiveRule, ProactiveSnooze, ProactiveSource } from './types';

const MAX_INPUT = 10_000;
const MINUTE_MS = 60_000;
const MAX_QUIET_SCAN_MINUTES = 2_880;
const OFFSET_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(Z|[+-](\d{2}):(\d{2}))$/i;
const NAIVE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?$/;

export interface ComputeProactiveNextCheckInput {
  nowUtc: string;
  timeZone: string;
  rules: ProactiveRule[];
  sources: ProactiveSource[];
  snoozes?: ProactiveSnooze[];
  /** Absolute expiry timestamps for currently fresh remote snapshots, supplied by the caller. */
  freshnessExpiresAt?: string[];
}

function parseSourceTime(value: string | undefined, certifiedUtcNaive?: boolean): number | undefined {
  if (value === undefined || typeof value !== 'string') return undefined;
  const match = OFFSET_TIMESTAMP.exec(value);
  if (match) {
    const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', fraction = '0', , zoneHour = '0', zoneMinute = '0'] = match;
    const year = Number(yearText), month = Number(monthText), day = Number(dayText);
    const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
    if (!validDate(year, month, day, hour, minute, second) || Number(zoneHour) > 23 || Number(zoneMinute) > 59) return undefined;
    const normalized = fraction === '0' ? value : value.replace(`.${fraction}`, `.${fraction.slice(0, 3).padEnd(3, '0')}`);
    const epoch = Date.parse(normalized);
    return Number.isFinite(epoch) ? epoch : undefined;
  }
  const naive = NAIVE_TIMESTAMP.exec(value);
  if (!naive || certifiedUtcNaive !== true) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '0', fraction = '0'] = naive;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  if (!validDate(year, month, day, hour, minute, second)) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, Number(fraction.slice(0, 3).padEnd(3, '0')));
  return date.getTime();
}

function validDate(year: number, month: number, day: number, hour: number, minute: number, second: number): boolean {
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function sourceDate(source: ProactiveSource): number | undefined {
  if (source.kind === 'meeting') return parseSourceTime(source.startAt, source.startAtUtcCertified);
  if (source.kind === 'task') return parseSourceTime(source.dueAt, source.dueAtUtcCertified);
  return undefined;
}

function ruleApplies(rule: ProactiveRule, source: ProactiveSource): boolean {
  return rule.accountIds.length === 0 || (source.accountId !== undefined && rule.accountIds.includes(source.accountId));
}

function matches(rule: ProactiveRule, source: ProactiveSource): boolean {
  return (source.kind === 'meeting' && rule.trigger.type === 'meeting_soon') ||
    (source.kind === 'task' && rule.trigger.type === 'task_due');
}

function inQuietWindow(localMinute: number, startText: string, endText: string): boolean {
  if (startText === endText) return false;
  const start = Number(startText.slice(0, 2)) * 60 + Number(startText.slice(3));
  const end = Number(endText.slice(0, 2)) * 60 + Number(endText.slice(3));
  return start < end ? localMinute >= start && localMinute < end : localMinute >= start || localMinute < end;
}

/** Returns the earliest known future input boundary; it performs no timers or I/O. */
export function computeProactiveNextCheckAt(input: ComputeProactiveNextCheckInput): string | null {
  if (!Array.isArray(input.sources) || input.sources.length > MAX_INPUT) throw new Error(`Proactive source input exceeds ${MAX_INPUT} entries.`);
  if (input.freshnessExpiresAt !== undefined && (!Array.isArray(input.freshnessExpiresAt) || input.freshnessExpiresAt.length > MAX_INPUT)) {
    throw new Error(`Freshness expiry input exceeds ${MAX_INPUT} entries.`);
  }
  // Reuse the evaluator's strict canonical-now, IANA-zone, rule, and snooze validation.
  evaluateProactive({ nowUtc: input.nowUtc, timeZone: input.timeZone, rules: input.rules, sources: [], snoozes: input.snoozes });
  const now = Date.parse(input.nowUtc);
  let earliest = Number.POSITIVE_INFINITY;
  const addFuture = (epoch: number | undefined) => {
    if (epoch !== undefined && Number.isFinite(epoch) && epoch > now && epoch < earliest) earliest = epoch;
  };

  for (const rule of input.rules) {
    if (!rule.enabled) continue;
    if ((rule.trigger.type === 'meeting_soon' || rule.trigger.type === 'task_due')) {
      for (const source of input.sources) {
        if (source.availability !== 'available' || source.freshness !== 'fresh' || !ruleApplies(rule, source) || !matches(rule, source)) continue;
        if (source.kind === 'task' && source.status !== 'open') continue;
        const epoch = sourceDate(source);
        if (epoch === undefined) continue;
        addFuture(epoch - rule.trigger.minutes * MINUTE_MS);
        if (source.kind === 'meeting') addFuture(epoch);
      }
    }
  }

  for (const expiration of input.freshnessExpiresAt ?? []) {
    if (typeof expiration !== 'string') continue;
    const epoch = parseSourceTime(expiration, false);
    addFuture(epoch);
  }
  for (const snooze of input.snoozes ?? []) addFuture(parseSourceTime(snooze.until, false));

  const quietWindows = new Map<string, { start: string; end: string }>();
  for (const rule of input.rules) {
    const quiet = rule.enabled ? rule.quietHours : undefined;
    if (!quiet || quiet.start === quiet.end) continue;
    quietWindows.set(`${quiet.start}/${quiet.end}`, quiet);
  }
  if (quietWindows.size > 0) {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const localMinuteAt = (epoch: number) => {
      const parts = formatter.formatToParts(epoch);
      return Number(parts.find((part) => part.type === 'hour')?.value) * 60 + Number(parts.find((part) => part.type === 'minute')?.value);
    };
    const baseline = localMinuteAt(now);
    const alignedNextMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
    for (let minute = 1; minute <= MAX_QUIET_SCAN_MINUTES; minute++) {
      const epoch = alignedNextMinute + (minute - 1) * MINUTE_MS;
      const localMinute = localMinuteAt(epoch);
      if ([...quietWindows.values()].some((quiet) => inQuietWindow(localMinute, quiet.start, quiet.end) !== inQuietWindow(baseline, quiet.start, quiet.end))) {
        addFuture(epoch);
        break;
      }
    }
  }

  if (!Number.isFinite(earliest)) return null;
  return new Date(earliest).toISOString();
}
