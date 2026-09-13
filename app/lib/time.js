'use strict';

// 期間の境界と、期間に応じた集計粒度（時間／日／月）を扱う。
// 端末のローカル時刻（日本時間）基準で日付・月・年を区切る。

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const MINUTE_MS = 60000;

function localStartOfDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function localStartOfMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function localStartOfYear(date = new Date()) {
  return new Date(date.getFullYear(), 0, 1).getTime();
}

function addDays(stamp, days) {
  const date = new Date(stamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()).getTime();
}

function addMonths(stamp, months) {
  const date = new Date(stamp);
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()).getTime();
}

// 'YYYY-MM-DD' をローカル日付として解釈する。不正なら null。
function parseDateInput(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { start: date.getTime(), end: new Date(year, month - 1, day + 1).getTime() };
}

function formatDateInput(stamp) {
  const date = new Date(stamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 期間の長さに応じた集計粒度。長い期間ではバケット数を抑えて軽く保つ。
function granularityForSpan(spanMs) {
  if (spanMs <= 4 * HOUR_MS) return { granularity: 'minute', bucketSeconds: 60 };
  if (spanMs <= 8 * HOUR_MS) return { granularity: 'minute', bucketSeconds: 300 };
  if (spanMs <= 10 * DAY_MS) return { granularity: 'hour', bucketSeconds: 3600 };
  if (spanMs <= 1200 * DAY_MS) return { granularity: 'day', bucketSeconds: 86400 };
  return { granularity: 'month', bucketSeconds: 0 };
}

function bucketStartFor(stamp, granularity, bucketSeconds) {
  if (granularity === 'month') return localStartOfMonth(new Date(stamp));
  if (granularity === 'day') return localStartOfDay(new Date(stamp));
  const seconds = Math.max(1, bucketSeconds || 3600);
  const size = seconds * 1000;
  const dayStart = localStartOfDay(new Date(stamp));
  return dayStart + Math.floor((stamp - dayStart) / size) * size;
}

function bucketEndFor(start, granularity, bucketSeconds) {
  if (granularity === 'month') return addMonths(start, 1);
  if (granularity === 'day') return addDays(start, 1);
  return start + Math.max(1, bucketSeconds || 3600) * 1000;
}

function bucketKeyFor(stamp, granularity) {
  const date = new Date(stamp);
  const pad = (value) => String(value).padStart(2, '0');
  if (granularity === 'month') return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  if (granularity === 'day') return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return String(stamp);
}

function enumerateBuckets(start, end, granularity, bucketSeconds, maxBuckets = 1500) {
  const buckets = [];
  let cursor = bucketStartFor(start, granularity, bucketSeconds);
  let guard = 0;
  while (cursor < end && guard < maxBuckets * 4 + 64) {
    const next = bucketEndFor(cursor, granularity, bucketSeconds);
    buckets.push({
      start: cursor,
      end: Math.min(next, end),
      key: bucketKeyFor(cursor, granularity),
      clippedStart: Math.max(cursor, start),
    });
    cursor = next;
    guard += 1;
  }
  return buckets;
}

function safeRange(key, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const end = options.end ?? now.getTime();
  const uptimeSeconds = Number(options.uptimeSeconds || 0);
  switch (key) {
    case 'session':
      return { start: Math.max(0, end - Math.max(0, uptimeSeconds * 1000)), end, label: '今回', partial: true };
    case 'yesterday': {
      const start = addDays(localStartOfDay(now), -1);
      return { start, end: localStartOfDay(now), label: '昨日', partial: false };
    }
    case '7d':
      return { start: addDays(localStartOfDay(now), -6), end, label: '直近7日', partial: true };
    case '30d':
      return { start: addDays(localStartOfDay(now), -29), end, label: '直近30日', partial: true };
    case 'month':
      return { start: localStartOfMonth(now), end, label: '今月', partial: true };
    case 'lastMonth': {
      const start = addMonths(localStartOfMonth(now), -1);
      return { start, end: localStartOfMonth(now), label: '先月', partial: false };
    }
    case '90d':
      return { start: addDays(localStartOfDay(now), -89), end, label: '直近90日', partial: true };
    case 'year':
      return { start: addDays(localStartOfDay(now), -364), end, label: '直近1年', partial: true };
    case 'thisYear':
      return { start: localStartOfYear(now), end, label: '今年', partial: true };
    case 'lastYear': {
      const start = new Date(now.getFullYear() - 1, 0, 1).getTime();
      return { start, end: new Date(now.getFullYear(), 0, 1).getTime(), label: '前年', partial: false };
    }
    case 'all':
      return { start: 0, end, label: '全期間', partial: false };
    case 'custom': {
      const from = parseDateInput(options.customStart);
      const to = parseDateInput(options.customEnd);
      if (!from || !to) return null;
      const start = Math.min(from.start, to.start);
      const endDay = from.start <= to.start ? to : from;
      const end = Math.min(endDay.end, now.getTime());
      if (end <= start) return null;
      return { start, end, label: `${formatDateInput(start)}〜${formatDateInput(endDay.start)}`, partial: false, custom: true };
    }
    case 'today':
    default:
      return { start: localStartOfDay(now), end, label: '今日', partial: true };
  }
}

const RANGE_ORDER = Object.freeze([
  'today', 'yesterday', '7d', '30d', 'month', 'lastMonth', 'thisYear', 'year', 'all', 'custom',
]);

// 直前期間（同じ長さ）と前年同期間の境界を返す。
function comparisonBounds(key, bounds, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  if (!bounds || key === 'all') return { previous: null, yearAgo: null };
  const span = Math.max(1, bounds.end - bounds.start);
  let previous = null;
  switch (key) {
    case 'today':
      previous = { start: addDays(bounds.start, -1), end: addDays(bounds.end, -1), label: '昨日の同じ時間帯' };
      break;
    case 'yesterday':
      previous = { start: addDays(bounds.start, -1), end: addDays(bounds.end, -1), label: '一昨日' };
      break;
    case '7d':
      previous = { start: addDays(bounds.start, -7), end: addDays(bounds.end, -7), label: 'その前の7日間' };
      break;
    case '30d':
      previous = { start: addDays(bounds.start, -30), end: addDays(bounds.end, -30), label: 'その前の30日間' };
      break;
    case '90d':
      previous = { start: addDays(bounds.start, -90), end: addDays(bounds.end, -90), label: 'その前の90日間' };
      break;
    case 'year':
      previous = { start: addDays(bounds.start, -365), end: addDays(bounds.end, -365), label: 'その前の1年間' };
      break;
    case 'month': {
      const start = addMonths(bounds.start, -1);
      previous = {
        start,
        end: Math.min(addMonths(bounds.end, -1), bounds.start - 1),
        label: '前月の同じ経過時点',
        differentLength: true,
      };
      break;
    }
    case 'lastMonth': {
      const start = addMonths(bounds.start, -1);
      previous = { start, end: bounds.start, label: '前々月' };
      break;
    }
    case 'thisYear': {
      const start = new Date(bounds.start);
      const end = new Date(bounds.end);
      previous = {
        start: new Date(start.getFullYear() - 1, start.getMonth(), start.getDate()).getTime(),
        end: new Date(end.getFullYear() - 1, end.getMonth(), end.getDate(), end.getHours(), end.getMinutes(), end.getSeconds()).getTime(),
        label: '去年の同じ時期',
      };
      break;
    }
    case 'lastYear': {
      const start = new Date(bounds.start);
      const end = new Date(bounds.end);
      previous = {
        start: new Date(start.getFullYear() - 1, start.getMonth(), start.getDate()).getTime(),
        end: new Date(end.getFullYear() - 1, end.getMonth(), end.getDate()).getTime(),
        label: '前々年',
      };
      break;
    }
    case 'custom':
      previous = { start: bounds.start - span, end: bounds.start - 1, label: '直前の同じ長さの期間' };
      break;
    default:
      previous = null;
  }

  let yearAgo = null;
  if (bounds.start > 0) {
    const start = new Date(bounds.start);
    const end = new Date(bounds.end);
    yearAgo = {
      start: new Date(start.getFullYear() - 1, start.getMonth(), start.getDate(), start.getHours(), start.getMinutes(), start.getSeconds()).getTime(),
      end: new Date(end.getFullYear() - 1, end.getMonth(), end.getDate(), end.getHours(), end.getMinutes(), end.getSeconds()).getTime(),
      label: '前年同期間',
    };
    if (!(yearAgo.start > 0) || yearAgo.end <= yearAgo.start) yearAgo = null;
  }
  if (yearAgo && previous && Math.abs(yearAgo.start - previous.start) < 3600000) yearAgo = null;
  if (previous && previous.end > now.getTime()) previous = { ...previous, end: now.getTime() };
  if (yearAgo && yearAgo.end > now.getTime()) yearAgo = { ...yearAgo, end: now.getTime() };
  return { previous, yearAgo };
}

module.exports = {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  RANGE_ORDER,
  addDays,
  addMonths,
  bucketEndFor,
  bucketKeyFor,
  bucketStartFor,
  comparisonBounds,
  enumerateBuckets,
  formatDateInput,
  granularityForSpan,
  localStartOfDay,
  localStartOfMonth,
  localStartOfYear,
  parseDateInput,
  safeRange,
};
