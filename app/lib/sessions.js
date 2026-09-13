'use strict';

// 起動セッション（電源が入って記録が続いた区間）の分析。
// 1時間ロールアップしかない古い期間では、区間の開始/終了を1時間より細かく特定できないため
// 「分解能が粗い」ことを結果に含めて画面で明示する。

const {
  UJ_PER_KWH,
  aggregatedExpression,
  energyExpression,
  hasTable,
  hasTimestampTable,
  periodSecondsExpression,
  wattsExpression,
} = require('./db');
const { applyAdjustments, adjustedWatts, categoryFor, processSampleFilter, processWindow } = require('./aggregate');

const BUCKET_MS = 5 * 60000;
const MAX_SESSIONS = 12;

function idleThreshold(config) {
  return Math.max(20, Number(config.baseWatts || 0) + Number(config.monitorWatts || 0) + 15);
}

function readSessionBuckets(db, since, config) {
  const watts = wattsExpression(db, 'total_data');
  const energy = energyExpression(db, 'total_data');
  if (!watts || !energy) return [];
  const seconds = periodSecondsExpression(db, 't');
  const aggregated = aggregatedExpression(db, 'd', 't');
  const threshold = idleThreshold(config);
  return db.prepare(`
    SELECT CAST(t.timestamp / ${BUCKET_MS} AS INTEGER) * ${BUCKET_MS} AS bucket,
           COUNT(*) AS samples,
           COALESCE(SUM(${energy}), 0) AS energy_uj,
           COALESCE(SUM(${seconds}), 0) AS active_seconds,
           SUM(CASE WHEN ${watts} <= ${threshold} THEN ${seconds} ELSE 0 END) AS idle_seconds,
           MAX(${watts}) AS max_watts,
           MIN(t.timestamp) AS first_ts,
           MAX(t.timestamp) AS last_ts
      FROM timestamp t JOIN total_data d ON d.timestamp_id = t.id
     WHERE t.timestamp >= ? AND NOT (${aggregated})
     GROUP BY bucket ORDER BY bucket`).all(since);
}

function sessionApps(db, start, end, config) {
  if (!hasTable(db, 'process_data')) return [];
  const watts = wattsExpression(db, 'process_data', 'p');
  if (!watts) return [];
  const seconds = periodSecondsExpression(db, 't');
  const window = processWindow(db, { start, end }, { maxRows: 40000, maxDays: 30 });
  if (!window.rows) return [];
  const rows = db.prepare(`
    SELECT p.app_name AS name, COALESCE(SUM(${watts} * ${seconds}), 0) AS watt_seconds
      FROM timestamp t JOIN process_data p ON p.timestamp_id = t.id
     WHERE t.timestamp >= ? AND t.timestamp <= ?
       ${processSampleFilter('p', window.step)}
     GROUP BY p.app_name ORDER BY watt_seconds DESC LIMIT 3`).all(start, end);
  const total = rows.reduce((sum, row) => sum + Number(row.watt_seconds || 0), 0);
  return rows.map((row) => {
    const category = categoryFor(row.name, config);
    return {
      name: String(row.name || '不明'),
      share: total > 0 ? Number(row.watt_seconds || 0) / total * 100 : 0,
      category: category.key,
      categorySource: category.source,
    };
  });
}

function buildSessions(rows, config, options = {}) {
  const sessions = [];
  let current = null;
  for (const row of rows) {
    const stamp = Number(row.bucket);
    const activeSeconds = Number(row.active_seconds || 0);
    const gapLimit = current
      ? Math.max(10 * 60000, Math.min(2 * 3600000, current.lastSampleSeconds * 3000))
      : 10 * 60000;
    if (!current || stamp - current.lastBucket > gapLimit) {
      if (current) sessions.push(current);
      current = {
        start: Number(row.first_ts || stamp),
        end: Number(row.last_ts || stamp),
        lastBucket: stamp,
        lastSampleSeconds: activeSeconds,
        energyUj: 0,
        activeSeconds: 0,
        idleSeconds: 0,
        maxWatts: null,
        samples: 0,
      };
    }
    current.end = Number(row.last_ts || stamp);
    current.lastBucket = stamp;
    current.lastSampleSeconds = activeSeconds;
    current.energyUj += Number(row.energy_uj || 0);
    current.activeSeconds += activeSeconds;
    current.idleSeconds += Number(row.idle_seconds || 0);
    current.samples += Number(row.samples || 0);
    const maxWatts = row.max_watts == null ? null : Number(row.max_watts);
    if (maxWatts != null) current.maxWatts = current.maxWatts == null ? maxWatts : Math.max(current.maxWatts, maxWatts);
  }
  if (current) sessions.push(current);

  const now = Date.now();
  return sessions
    .sort((a, b) => b.start - a.start)
    .slice(0, options.maxSessions || MAX_SESSIONS)
    .map((session) => {
      const totals = applyAdjustments(session.energyUj / UJ_PER_KWH, session.activeSeconds, config);
      const durationSeconds = Math.max(0, (session.end - session.start) / 1000);
      return {
        start: session.start,
        end: session.end,
        durationSeconds,
        activeSeconds: session.activeSeconds,
        idleSeconds: session.idleSeconds,
        activeRatio: durationSeconds > 0 ? Math.min(100, session.activeSeconds / durationSeconds * 100) : 100,
        kwh: totals.adjustedKwh,
        cost: totals.cost,
        averageWatts: totals.averageWatts,
        maxWatts: session.maxWatts == null ? null : adjustedWatts(session.maxWatts, config),
        samples: session.samples,
        status: now - session.end < 10 * 60000 ? 'recording' : 'closed',
        resolution: 'second',
        estimated: true,
      };
    });
}

function recentSessions(db, config, options = {}) {
  if (!hasTimestampTable(db) || !hasTable(db, 'total_data')) {
    return { sessions: [], note: '記録データがまだありません。' };
  }
  const since = options.since || Date.now() - 30 * 86400000;
  const rows = readSessionBuckets(db, since, config);
  const sessions = buildSessions(rows, config, options);
  const withApps = sessions.slice(0, options.detailSessions || 5).map((session) => {
    const apps = sessionApps(db, session.start, session.end, config);
    return {
      ...session,
      topApps: apps,
      topApp: apps[0]?.name || null,
      topCategory: apps[0]?.category || null,
    };
  });
  const rest = sessions.slice(withApps.length);
  return {
    sessions: [...withApps, ...rest],
    note: 'セッションは1秒記録が残っている期間から推定しています。1時間ごとの平均記録しかない期間は開始/終了を分けられません。',
    resolutionNote: sessions.length ? null : '1秒記録の残っている期間にセッションはありません。',
  };
}

module.exports = { BUCKET_MS, buildSessions, idleThreshold, recentSessions, sessionApps };
