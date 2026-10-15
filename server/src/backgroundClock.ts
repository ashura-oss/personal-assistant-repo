export type BackgroundPeriodKind = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface CompleteBackgroundPeriod {
  readonly key: string;
  readonly period: BackgroundPeriodKind;
  readonly localPeriod: string;
  readonly timeZone: string;
  readonly startUtc: string;
  readonly endUtc: string;
  readonly dueUtc: string;
  readonly empty: boolean;
  readonly resolutionNotes: readonly string[];
}

export interface ResolveCompletePeriodInput {
  readonly period: BackgroundPeriodKind;
  readonly localPeriod: string;
  readonly timeZone: string;
  readonly localDeliveryTime?: string;
}

export interface ListDuePeriodsInput {
  readonly period: BackgroundPeriodKind;
  readonly timeZone: string;
  readonly localDeliveryTime?: string;
  readonly firstLocalPeriod: string;
  readonly afterLocalPeriod?: string;
  readonly throughUtc: string;
  readonly pageSize: number;
  readonly cursor?: string;
}

export interface DuePeriodsPage {
  readonly periods: readonly CompleteBackgroundPeriod[];
  readonly nextCursor: string | null;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURSOR_VERSION = 1;

interface CivilDate { readonly year: number; readonly month: number; readonly day: number }
interface ZonedMinute { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number; readonly second: number }
interface CursorQuery {
  readonly period: BackgroundPeriodKind;
  readonly timeZone: string;
  readonly localDeliveryTime: string;
  readonly firstLocalPeriod: string;
  readonly afterLocalPeriod: string | null;
  readonly throughUtc: string;
  readonly pageSize: number;
}
interface ClockContext { readonly formatters: Map<string, Intl.DateTimeFormat> }

function fail(message: string): never { throw new TypeError(message); }

function utcEpoch(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime();
}

function parseDate(value: unknown, label: string): CivilDate {
  if (typeof value !== 'string') return fail(`${label} must be a canonical YYYY-MM-DD date.`);
  const match = DATE_RE.exec(value);
  if (!match || match[0] !== value) return fail(`${label} must be a canonical YYYY-MM-DD date.`);
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return fail(`${label} is not a valid Gregorian date.`);
  const date = new Date(utcEpoch(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return fail(`${label} is not a valid Gregorian date.`);
  return Object.freeze({ year, month, day });
}

function dateText(date: CivilDate): string {
  if (date.year < 1 || date.year > 9999) return fail('The period falls outside the supported four-digit Gregorian calendar.');
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function addDays(date: CivilDate, amount: number): CivilDate {
  const value = new Date(utcEpoch(date.year, date.month, date.day) + amount * DAY_MS);
  return Object.freeze({ year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() });
}

function periodAnchor(date: CivilDate, period: BackgroundPeriodKind): CivilDate {
  if (period === 'daily') return date;
  if (period === 'monthly') return Object.freeze({ year: date.year, month: date.month, day: 1 });
  if (period === 'yearly') return Object.freeze({ year: date.year, month: 1, day: 1 });
  const weekday = new Date(utcEpoch(date.year, date.month, date.day)).getUTCDay();
  const sinceMonday = (weekday + 6) % 7;
  return addDays(date, -sinceMonday);
}

function parsePeriodStart(value: unknown, period: BackgroundPeriodKind, label: string): CivilDate {
  const date = parseDate(value, label);
  const anchor = periodAnchor(date, period);
  if (dateText(anchor) !== value) return fail(`${label} must be the canonical start date for its ${period} period.`);
  return anchor;
}

export function nextLocalPeriod(period: BackgroundPeriodKind, localPeriod: string): string {
  validatePeriodKind(period);
  const date = parsePeriodStart(localPeriod, period, 'localPeriod');
  if (period === 'daily') return dateText(addDays(date, 1));
  if (period === 'weekly') return dateText(addDays(date, 7));
  if (period === 'monthly') return dateText(date.month === 12 ? { year: date.year + 1, month: 1, day: 1 } : { year: date.year, month: date.month + 1, day: 1 });
  return dateText({ year: date.year + 1, month: 1, day: 1 });
}

export function previousLocalPeriod(period: BackgroundPeriodKind, localPeriod: string): string {
  validatePeriodKind(period);
  const date = parsePeriodStart(localPeriod, period, 'localPeriod');
  if (period === 'daily') return dateText(addDays(date, -1));
  if (period === 'weekly') return dateText(addDays(date, -7));
  if (period === 'monthly') return dateText(date.month === 1 ? { year: date.year - 1, month: 12, day: 1 } : { year: date.year, month: date.month - 1, day: 1 });
  return dateText({ year: date.year - 1, month: 1, day: 1 });
}

function validPeriod(value: unknown): value is BackgroundPeriodKind {
  return typeof value === 'string' && (value === 'daily' || value === 'weekly' || value === 'monthly' || value === 'yearly');
}

function parseTime(value: unknown): { readonly text: string; readonly hour: number; readonly minute: number } {
  const text = value === undefined ? '08:00' : value;
  if (typeof text !== 'string') return fail('localDeliveryTime must be a canonical HH:mm time.');
  const match = TIME_RE.exec(text);
  if (!match || match[0] !== text) return fail('localDeliveryTime must be a canonical HH:mm time.');
  const hour = Number(match[1]); const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return fail('localDeliveryTime must be a valid local clock time.');
  return Object.freeze({ text, hour, minute });
}

function createClockContext(): ClockContext { return { formatters: new Map() }; }

function formatter(timeZone: string, context: ClockContext): Intl.DateTimeFormat {
  if (/^[+-]/.test(timeZone)) return fail('timeZone must be a named IANA time zone, not a fixed offset.');
  const cached = context.formatters.get(timeZone);
  if (cached) return cached;
  let created: Intl.DateTimeFormat;
  try {
    created = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
  } catch { return fail('timeZone must be a supported IANA time zone.'); }
  context.formatters.set(timeZone, created);
  return created;
}

function localAt(epoch: number, timeZone: string, context: ClockContext): ZonedMinute {
  const values = new Map(formatter(timeZone, context).formatToParts(new Date(epoch)).map((part) => [part.type, part.value]));
  const result = { year: Number(values.get('year')), month: Number(values.get('month')), day: Number(values.get('day')), hour: Number(values.get('hour')), minute: Number(values.get('minute')), second: Number(values.get('second')) };
  if (!Object.values(result).every(Number.isFinite)) return fail('Could not resolve the time zone calendar fields.');
  return result;
}

function sameMinute(a: ZonedMinute, b: ZonedMinute): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

function offsetAt(epoch: number, timeZone: string, context: ClockContext): number {
  const local = localAt(epoch, timeZone, context);
  return utcEpoch(local.year, local.month, local.day, local.hour, local.minute, local.second) - epoch;
}

function offsetsNear(localEpoch: number, timeZone: string, context: ClockContext): readonly number[] {
  const offsets = new Set<number>();
  // Three days on either side covers the ordinary transition around a period boundary,
  // including non-hour offsets and date-line transitions, without scanning a year.
  for (let delta = -3 * DAY_MS; delta <= 3 * DAY_MS; delta += 3 * 60 * MINUTE_MS) {
    const offset = offsetAt(localEpoch + delta, timeZone, context);
    if (Math.abs(offset) <= DAY_MS) offsets.add(offset);
  }
  return [...offsets];
}

function matchingInstants(wall: ZonedMinute, offsets: readonly number[], timeZone: string, context: ClockContext): number[] {
  const localEpoch = utcEpoch(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second);
  const matches = new Set<number>();
  for (const offset of offsets) {
    const candidate = localEpoch - offset;
    if (sameMinute(localAt(candidate, timeZone, context), wall)) matches.add(candidate);
  }
  return [...matches].sort((a, b) => a - b);
}

interface ResolvedMinute { readonly epoch: number; readonly gapAdvanced: boolean; readonly fold: boolean }

function resolveWallMinute(date: CivilDate, hour: number, minute: number, timeZone: string, context: ClockContext): ResolvedMinute {
  const requestedEpoch = utcEpoch(date.year, date.month, date.day, hour, minute);
  const offsets = offsetsNear(requestedEpoch, timeZone, context);
  // A gap may be shorter than a day, while a skipped civil date can be 24 hours.
  // The fixed 48-hour local scan handles that exceptional boundary without a long-range scan.
  for (let advance = 0; advance <= 48 * 60; advance++) {
    const wallEpoch = requestedEpoch + advance * MINUTE_MS;
    const wallDate = new Date(wallEpoch);
    const wall: ZonedMinute = { year: wallDate.getUTCFullYear(), month: wallDate.getUTCMonth() + 1, day: wallDate.getUTCDate(), hour: wallDate.getUTCHours(), minute: wallDate.getUTCMinutes(), second: wallDate.getUTCSeconds() };
    const matches = matchingInstants(wall, offsets, timeZone, context);
    if (matches.length > 0) return Object.freeze({ epoch: matches[0]!, gapAdvanced: advance > 0, fold: matches.length > 1 });
  }
  return fail('The local period boundary could not be resolved within the supported transition window.');
}

function parseThroughUtc(value: unknown): { readonly text: string; readonly epoch: number } {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value) || value.length !== 24) return fail('throughUtc must be a canonical UTC ISO timestamp.');
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) return fail('throughUtc must be a canonical UTC ISO timestamp.');
  return Object.freeze({ text: value, epoch });
}

function publicPeriod(period: BackgroundPeriodKind, localPeriod: string, timeZone: string, delivery: ReturnType<typeof parseTime>, context: ClockContext): CompleteBackgroundPeriod {
  const date = parsePeriodStart(localPeriod, period, 'localPeriod');
  const nextText = nextLocalPeriod(period, localPeriod);
  const next = parseDate(nextText, 'nextLocalPeriod');
  const start = resolveWallMinute(date, 0, 0, timeZone, context);
  const end = resolveWallMinute(next, 0, 0, timeZone, context);
  const due = resolveWallMinute(next, delivery.hour, delivery.minute, timeZone, context);
  const empty = start.epoch >= end.epoch;
  const resolutionNotes: string[] = [];
  if (start.gapAdvanced) resolutionNotes.push('period_start_advanced_to_first_valid_local_minute');
  if (end.gapAdvanced) resolutionNotes.push('period_end_advanced_to_first_valid_local_minute');
  if (due.gapAdvanced) resolutionNotes.push('delivery_time_advanced_to_first_valid_local_minute');
  if (start.fold) resolutionNotes.push('ambiguous_period_start_uses_first_instant');
  if (end.fold) resolutionNotes.push('ambiguous_period_end_uses_first_instant');
  if (due.fold) resolutionNotes.push('ambiguous_delivery_time_uses_first_instant');
  if (empty) resolutionNotes.push('local_period_has_no_elapsed_time');
  return Object.freeze({
    key: `${period}:${localPeriod}`,
    period,
    localPeriod,
    timeZone,
    startUtc: new Date(start.epoch).toISOString(),
    endUtc: new Date(end.epoch).toISOString(),
    dueUtc: new Date(due.epoch).toISOString(),
    empty,
    resolutionNotes: Object.freeze(resolutionNotes),
  });
}

function validatePeriodKind(value: unknown): asserts value is BackgroundPeriodKind {
  if (!validPeriod(value)) fail('period must be daily, weekly, monthly, or yearly.');
}

export function resolveCompletePeriod(input: ResolveCompletePeriodInput): CompleteBackgroundPeriod {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Period input must be an object.');
  validatePeriodKind(input.period);
  const date = parsePeriodStart(input.localPeriod, input.period, 'localPeriod');
  if (typeof input.timeZone !== 'string' || input.timeZone.length === 0) return fail('timeZone must be a supported IANA time zone.');
  const context = createClockContext();
  const zone = formatter(input.timeZone, context);
  void zone;
  const delivery = parseTime(input.localDeliveryTime);
  return publicPeriod(input.period, dateText(date), input.timeZone, delivery, context);
}

function queryFor(input: ListDuePeriodsInput): CursorQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Due-period query must be an object.');
  validatePeriodKind(input.period);
  if (typeof input.timeZone !== 'string' || input.timeZone.length === 0) return fail('timeZone must be a supported IANA time zone.');
  formatter(input.timeZone, createClockContext());
  const first = dateText(parsePeriodStart(input.firstLocalPeriod, input.period, 'firstLocalPeriod'));
  const after = input.afterLocalPeriod === undefined ? null : dateText(parsePeriodStart(input.afterLocalPeriod, input.period, 'afterLocalPeriod'));
  const delivery = parseTime(input.localDeliveryTime);
  if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) return fail('pageSize must be an integer from 1 to 100.');
  const through = parseThroughUtc(input.throughUtc);
  return Object.freeze({ period: input.period, timeZone: input.timeZone, localDeliveryTime: delivery.text, firstLocalPeriod: first, afterLocalPeriod: after, throughUtc: through.text, pageSize: input.pageSize });
}

function cursorEncode(query: CursorQuery, nextLocalPeriod: string): string {
  return Buffer.from(JSON.stringify({ version: CURSOR_VERSION, query, nextLocalPeriod }), 'utf8').toString('base64url');
}

function cursorDecode(cursor: unknown, query: CursorQuery): string {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return fail('cursor is invalid.');
  let value: unknown;
  try {
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) return fail('cursor is invalid.');
    value = JSON.parse(decoded.toString('utf8'));
  } catch { return fail('cursor is invalid.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('cursor is invalid.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || !['version', 'query', 'nextLocalPeriod'].every((key) => Object.prototype.hasOwnProperty.call(record, key)) ||
      record.version !== CURSOR_VERSION || !record.query || typeof record.query !== 'object' || Array.isArray(record.query) || typeof record.nextLocalPeriod !== 'string') return fail('cursor is invalid.');
  const bound = record.query as Record<string, unknown>;
  const keys = ['period', 'timeZone', 'localDeliveryTime', 'firstLocalPeriod', 'afterLocalPeriod', 'throughUtc', 'pageSize'];
  if (Object.keys(bound).length !== keys.length || keys.some((key) => bound[key] !== query[key as keyof CursorQuery])) return fail('cursor does not match this due-period query.');
  const next = dateText(parsePeriodStart(record.nextLocalPeriod, query.period, 'cursor nextLocalPeriod'));
  if (next < query.firstLocalPeriod || (query.afterLocalPeriod !== null && next <= query.afterLocalPeriod)) return fail('cursor position is invalid.');
  return next;
}

function periodForThroughDate(period: BackgroundPeriodKind, throughUtc: string, timeZone: string, context: ClockContext): string {
  const local = localAt(Date.parse(throughUtc), timeZone, context);
  return dateText(periodAnchor({ year: local.year, month: local.month, day: local.day }, period));
}

export function listDuePeriods(input: ListDuePeriodsInput): DuePeriodsPage {
  const query = queryFor(input);
  const through = parseThroughUtc(query.throughUtc);
  const context = createClockContext();
  const currentLocalPeriod = periodForThroughDate(query.period, through.text, query.timeZone, context);
  // A daily date-line rollback can place the following civil date before throughUtc;
  // include one extra daily label. Weekly/monthly/yearly starts are farther away than
  // any zone offset transition and the current containing period is sufficient.
  const terminal = query.period === 'daily' ? nextLocalPeriod('daily', currentLocalPeriod) : currentLocalPeriod;
  const resume = input.cursor !== undefined
    ? cursorDecode(input.cursor, query)
    : (query.afterLocalPeriod ? nextLocalPeriod(query.period, query.afterLocalPeriod) : query.firstLocalPeriod);
  let candidate = resume < query.firstLocalPeriod ? query.firstLocalPeriod : resume;
  const periods: CompleteBackgroundPeriod[] = [];
  while (candidate <= terminal) {
    const resolved = publicPeriod(query.period, candidate, query.timeZone, parseTime(query.localDeliveryTime), context);
    const dueEpoch = Date.parse(resolved.dueUtc);
    candidate = nextLocalPeriod(query.period, candidate);
    if (dueEpoch > through.epoch) continue;
    periods.push(resolved);
    if (periods.length === query.pageSize) {
      // Look ahead to the next due item so continuation resumes at it, not after it.
      while (candidate <= terminal) {
        const lookahead = publicPeriod(query.period, candidate, query.timeZone, parseTime(query.localDeliveryTime), context);
        if (Date.parse(lookahead.dueUtc) <= through.epoch) {
          return Object.freeze({ periods: Object.freeze(periods), nextCursor: cursorEncode(query, candidate) });
        }
        candidate = nextLocalPeriod(query.period, candidate);
      }
      return Object.freeze({ periods: Object.freeze(periods), nextCursor: null });
    }
  }
  return Object.freeze({ periods: Object.freeze(periods), nextCursor: null });
}
