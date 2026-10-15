import assert from 'node:assert/strict';
import test from 'node:test';
import { listDuePeriods, nextLocalPeriod, previousLocalPeriod, resolveCompletePeriod } from '../dist/backgroundClock.js';

const resolve = (period, localPeriod, timeZone, localDeliveryTime) => resolveCompletePeriod({ period, localPeriod, timeZone, ...(localDeliveryTime ? { localDeliveryTime } : {}) });

test('daily period boundaries use New York spring and fall DST transitions', () => {
  const spring = resolve('daily', '2024-03-10', 'America/New_York');
  assert.equal(spring.startUtc, '2024-03-10T05:00:00.000Z');
  assert.equal(spring.endUtc, '2024-03-11T04:00:00.000Z');
  assert.equal(spring.dueUtc, '2024-03-11T12:00:00.000Z');
  assert.equal(Date.parse(spring.endUtc) - Date.parse(spring.startUtc), 23 * 60 * 60_000);

  const fall = resolve('daily', '2024-11-03', 'America/New_York');
  assert.equal(fall.startUtc, '2024-11-03T04:00:00.000Z');
  assert.equal(fall.endUtc, '2024-11-04T05:00:00.000Z');
  assert.equal(Date.parse(fall.endUtc) - Date.parse(fall.startUtc), 25 * 60 * 60_000);
  assert.equal(fall.dueUtc, '2024-11-04T13:00:00.000Z');
  const fold = resolve('daily', '2024-11-02', 'America/New_York', '01:30');
  assert.equal(fold.dueUtc, '2024-11-03T05:30:00.000Z');
  assert.ok(fold.resolutionNotes.includes('ambiguous_delivery_time_uses_first_instant'));
});

test('midnight gaps and Lord Howe half-hour gaps advance to the first valid minute', () => {
  const midnightGap = resolve('daily', '2018-11-04', 'America/Sao_Paulo');
  assert.equal(midnightGap.startUtc, '2018-11-04T03:00:00.000Z');
  assert.ok(midnightGap.resolutionNotes.includes('period_start_advanced_to_first_valid_local_minute'));

  const lordHowe = resolve('daily', '2024-10-05', 'Australia/Lord_Howe', '02:15');
  assert.equal(lordHowe.dueUtc, '2024-10-05T15:30:00.000Z');
  assert.ok(lordHowe.resolutionNotes.includes('delivery_time_advanced_to_first_valid_local_minute'));
});

test('a skipped Apia date retains its key and is empty', () => {
  const skipped = resolve('daily', '2011-12-30', 'Pacific/Apia');
  assert.equal(skipped.key, 'daily:2011-12-30');
  assert.equal(skipped.startUtc, '2011-12-30T10:00:00.000Z');
  assert.equal(skipped.endUtc, skipped.startUtc);
  assert.equal(skipped.dueUtc, '2011-12-30T18:00:00.000Z');
  assert.equal(skipped.empty, true);
  assert.ok(skipped.resolutionNotes.includes('local_period_has_no_elapsed_time'));
});

test('historical Paris boundaries preserve second-resolution offsets', () => {
  const historical = resolve('daily', '1900-01-01', 'Europe/Paris');
  assert.equal(historical.startUtc, '1899-12-31T23:50:39.000Z');
  assert.equal(historical.endUtc, '1900-01-01T23:50:39.000Z');
});

test('Gregorian period arithmetic handles leap dates, ISO Mondays, and calendar boundaries', () => {
  assert.equal(nextLocalPeriod('daily', '2024-02-29'), '2024-03-01');
  assert.equal(previousLocalPeriod('daily', '2024-03-01'), '2024-02-29');
  assert.equal(nextLocalPeriod('weekly', '2021-01-04'), '2021-01-11');
  assert.equal(previousLocalPeriod('weekly', '2021-01-04'), '2020-12-28');
  assert.equal(resolve('weekly', '2026-10-12', 'Asia/Singapore').dueUtc, '2026-10-19T00:00:00.000Z');
  assert.equal(nextLocalPeriod('monthly', '2024-12-01'), '2025-01-01');
  assert.equal(previousLocalPeriod('monthly', '2025-01-01'), '2024-12-01');
  assert.equal(nextLocalPeriod('yearly', '2024-01-01'), '2025-01-01');
  assert.equal(previousLocalPeriod('yearly', '2025-01-01'), '2024-01-01');
  assert.equal(resolve('monthly', '2024-02-01', 'UTC').endUtc, '2024-03-01T00:00:00.000Z');
  assert.equal(resolve('yearly', '2024-01-01', 'UTC').endUtc, '2025-01-01T00:00:00.000Z');
  assert.equal(resolve('monthly', '2026-10-01', 'Asia/Singapore').dueUtc, '2026-11-01T00:00:00.000Z');
  assert.equal(resolve('yearly', '2026-01-01', 'Asia/Singapore').dueUtc, '2027-01-01T00:00:00.000Z');
});

test('due paging is ordered, unique across rollback, and cursors bind their exact query', () => {
  const query = { period: 'daily', timeZone: 'America/New_York', firstLocalPeriod: '2024-11-02', throughUtc: '2024-11-05T23:59:59.000Z', pageSize: 1 };
  const first = listDuePeriods(query);
  const second = listDuePeriods({ ...query, cursor: first.nextCursor });
  const third = listDuePeriods({ ...query, cursor: second.nextCursor });
  assert.deepEqual([first.periods[0]?.localPeriod, second.periods[0]?.localPeriod, third.periods[0]?.localPeriod], ['2024-11-02', '2024-11-03', '2024-11-04']);
  assert.equal(new Set([first.periods[0]?.key, second.periods[0]?.key, third.periods[0]?.key]).size, 3);
  assert.equal(third.nextCursor, null);
  assert.throws(() => listDuePeriods({ ...query, throughUtc: '2024-11-06T00:00:00.000Z', cursor: first.nextCursor }), /does not match/);
});

test('persisted afterLocalPeriod prevents repeats when throughUtc moves backward then forward', () => {
  const base = { period: 'daily', timeZone: 'America/New_York', firstLocalPeriod: '2024-11-02', pageSize: 100 };
  const later = listDuePeriods({ ...base, throughUtc: '2024-11-06T23:59:59.000Z' });
  assert.deepEqual(later.periods.map((item) => item.localPeriod), ['2024-11-02', '2024-11-03', '2024-11-04', '2024-11-05']);
  const persistedAfter = later.periods.at(-1).localPeriod;

  const backward = listDuePeriods({ ...base, afterLocalPeriod: persistedAfter, throughUtc: '2024-11-05T10:00:00.000Z' });
  assert.deepEqual(backward.periods, []);
  const forward = listDuePeriods({ ...base, afterLocalPeriod: persistedAfter, throughUtc: '2024-11-07T23:59:59.000Z' });
  assert.deepEqual(forward.periods.map((item) => item.localPeriod), ['2024-11-06']);
});

test('pagination has no total backlog cap', () => {
  const page = listDuePeriods({ period: 'monthly', timeZone: 'UTC', firstLocalPeriod: '2000-01-01', throughUtc: '2025-01-01T00:00:00.000Z', pageSize: 100 });
  assert.equal(page.periods.length, 100);
  assert.equal(page.periods[0]?.localPeriod, '2000-01-01');
  assert.equal(page.periods[99]?.localPeriod, '2008-04-01');
  assert.notEqual(page.nextCursor, null);
  const next = listDuePeriods({ period: 'monthly', timeZone: 'UTC', firstLocalPeriod: '2000-01-01', throughUtc: '2025-01-01T00:00:00.000Z', pageSize: 100, cursor: page.nextCursor });
  assert.equal(next.periods[0]?.localPeriod, '2008-05-01');
});

test('clock inputs reject noncanonical dates, times, zones, periods, and trailing newlines', () => {
  assert.throws(() => resolve('daily', '2024-02-30', 'UTC'), /Gregorian/);
  assert.throws(() => resolve('daily', '2024-02-29\n', 'UTC'), /canonical/);
  assert.throws(() => resolve('weekly', '2024-01-02', 'UTC'), /canonical start/);
  assert.throws(() => resolve('daily', '2024-01-01', 'Not/AZone'), /timeZone/);
  assert.throws(() => resolve('daily', '2024-01-01', '+08:00'), /named IANA/);
  for (const offset of ['+08', '+0800', '-04', '-0400']) assert.throws(() => resolve('daily', '2024-01-01', offset), /named IANA/);
  assert.equal(resolve('daily', '2024-01-01', 'Etc/GMT+8').startUtc, '2024-01-01T08:00:00.000Z');
  assert.equal(resolve('daily', '2024-01-01', 'GMT').startUtc, '2024-01-01T00:00:00.000Z');
  assert.throws(() => resolveCompletePeriod({ period: ['daily'], localPeriod: '2024-01-01', timeZone: 'UTC' }), /period/);
  assert.throws(() => resolve('daily', '2024-01-01', 'UTC', '08:00\n'), /canonical HH:mm/);
  assert.throws(() => listDuePeriods({ period: 'daily', timeZone: 'UTC', firstLocalPeriod: '2024-01-01', throughUtc: '2024-01-01T08:00:00.000Z\n', pageSize: 1 }), /canonical UTC/);
  assert.throws(() => listDuePeriods({ period: 'daily', timeZone: 'UTC', firstLocalPeriod: '2024-01-01', throughUtc: '2024-01-01T08:00:00.000Z', pageSize: 101 }), /pageSize/);
});
