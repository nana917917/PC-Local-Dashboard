'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DB_PATH = process.env.PC_POWER_DB || path.join(APP_DIR, 'power_monitoring.db');
const CONFIG_PATH = process.env.PC_POWER_CONFIG || path.join(APP_DIR, 'config.json');
const PID_PATH = path.join(APP_DIR, 'dashboard.pid');
const STORAGE_DASHBOARD_PATH = path.join(APP_DIR, 'storage-map', 'dashboard.vbs');
const STORAGE_SERVER_PATH = path.join(APP_DIR, 'storage-map', 'server.js');
const STORAGE_RESULT_PATH = path.join(APP_DIR, 'storage-map', 'data', 'last-scan.json');
const WATTSEAL_PATH = path.join(APP_DIR, 'WattSeal.exe');
const PORT = Number(process.env.PC_POWER_PORT || 17891);
const UJ_PER_KWH = 3_600_000_000_000;
const APP_VERSION = '0.11.0';
const DEFAULT_CONFIG = Object.freeze({
  electricityRate: 31,
  sensorFactor: 1.10,
  baseWatts: 25,
  monitorWatts: 0,
  monthlyBudget: 0,
  lanAccess: false,
  gameKeywords: [
    'steam', 'epicgames', 'riotclient', 'valorant', 'apex', 'genshin',
    'terraria', 'edf', 'earthdefenseforce', 'darkanddarker', 'mgs', 'metalgear',
  ],
});

let lastActivity = Date.now();

function numberInRange(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function booleanValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function keywordList(value, fallback = []) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : fallback;
  return [...new Set(source
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => item.length >= 2 && item.length <= 80))]
    .slice(0, 80);
}

function loadConfig() {
  let source = {};
  try {
    source = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    source = {};
  }
  return {
    electricityRate: numberInRange(source.electricityRate, DEFAULT_CONFIG.electricityRate, 0, 200),
    sensorFactor: numberInRange(source.sensorFactor, DEFAULT_CONFIG.sensorFactor, 0.5, 2),
    baseWatts: numberInRange(source.baseWatts, DEFAULT_CONFIG.baseWatts, 0, 300),
    monitorWatts: numberInRange(source.monitorWatts, DEFAULT_CONFIG.monitorWatts, 0, 500),
    monthlyBudget: numberInRange(source.monthlyBudget, DEFAULT_CONFIG.monthlyBudget, 0, 100000),
    lanAccess: booleanValue(source.lanAccess, DEFAULT_CONFIG.lanAccess),
    gameKeywords: keywordList(source.gameKeywords, DEFAULT_CONFIG.gameKeywords),
  };
}

function saveConfig(input) {
  const current = loadConfig();
  const next = {
    electricityRate: numberInRange(input.electricityRate, current.electricityRate, 0, 200),
    sensorFactor: numberInRange(input.sensorFactor, current.sensorFactor, 0.5, 2),
    baseWatts: numberInRange(input.baseWatts, current.baseWatts, 0, 300),
    monitorWatts: numberInRange(input.monitorWatts, current.monitorWatts, 0, 500),
    monthlyBudget: numberInRange(input.monthlyBudget, current.monthlyBudget, 0, 100000),
    lanAccess: booleanValue(input.lanAccess, current.lanAccess),
    gameKeywords: keywordList(input.gameKeywords, current.gameKeywords),
  };
  const tempPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, CONFIG_PATH);
  return next;
}

const HOST = process.env.PC_POWER_HOST || (loadConfig().lanAccess ? '0.0.0.0' : '127.0.0.1');
const LOCAL_HOST = '127.0.0.1';

function openDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    const error = new Error('記録データを準備中です。1～2分待ってから更新してください。');
    error.code = 'DB_NOT_READY';
    throw error;
  }
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

function hasTable(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(tableName));
}

function tableColumns(db, tableName) {
  if (!hasTable(db, tableName)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function timestampPeriodExpression(db, alias = 't') {
  const columns = tableColumns(db, 'timestamp');
  const column = columns.has('sampling_period')
    ? 'sampling_period'
    : columns.has('period_type') ? 'period_type' : null;
  if (!column) throw new Error('WattSealのtimestampテーブル形式を認識できません。');
  return `CASE WHEN CAST(${alias}.${column} AS REAL) > 0 THEN CAST(${alias}.${column} AS REAL) ELSE 1 END`;
}

function tableEnergyExpression(db, tableName, dataAlias = 'd', timestampAlias = 't') {
  const columns = tableColumns(db, tableName);
  const energyColumn = tableName === 'process_data' ? 'process_energy_uj' : 'total_energy_uj';
  const powerColumn = tableName === 'process_data' ? 'process_power_watts' : 'total_power_watts';
  if (columns.has(energyColumn)) return `COALESCE(${dataAlias}.${energyColumn}, 0)`;
  if (columns.has(powerColumn)) {
    return `COALESCE(${dataAlias}.${powerColumn}, 0) * 1000000.0 * ${timestampPeriodExpression(db, timestampAlias)}`;
  }
  return null;
}

function localStartOfDay(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function rangeBounds(range) {
  const now = new Date();
  const end = now.getTime();
  switch (range) {
    case 'session':
      return { start: end - Math.max(0, os.uptime() * 1000), end, label: '今回' };
    case '7d':
      return { start: localStartOfDay(now) - 6 * 86400000, end, label: '直近7日' };
    case 'month':
      return { start: new Date(now.getFullYear(), now.getMonth(), 1).getTime(), end, label: '今月' };
    case '30d':
      return { start: localStartOfDay(now) - 29 * 86400000, end, label: '直近30日' };
    case '90d':
      return { start: localStartOfDay(now) - 89 * 86400000, end, label: '直近90日' };
    case 'year':
      return { start: localStartOfDay(now) - 364 * 86400000, end, label: '直近1年' };
    case 'all':
      return { start: 0, end, label: '全期間' };
    case 'today':
    default:
      return { start: localStartOfDay(now), end, label: '今日' };
  }
}

function adjustedFromRaw(rawEnergyUj, activeSeconds, config) {
  const rawKwh = Number(rawEnergyUj || 0) / UJ_PER_KWH;
  const fixedWatts = config.baseWatts + config.monitorWatts;
  const adjustedKwh = rawKwh * config.sensorFactor + fixedWatts * Number(activeSeconds || 0) / 3_600_000;
  return {
    rawKwh,
    adjustedKwh,
    cost: adjustedKwh * config.electricityRate,
    activeSeconds: Number(activeSeconds || 0),
    averageWatts: activeSeconds > 0 ? adjustedKwh * 3_600_000 / activeSeconds : 0,
  };
}

function periodAggregate(db, bounds, config) {
  if (!hasTable(db, 'total_data')) return adjustedFromRaw(0, 0, config);
  const energyExpression = tableEnergyExpression(db, 'total_data');
  if (!energyExpression) return adjustedFromRaw(0, 0, config);
  const periodExpression = timestampPeriodExpression(db);
  const row = db.prepare(`
    SELECT COALESCE(SUM(${energyExpression}), 0) AS energy,
           COALESCE(SUM(${periodExpression}), 0) AS seconds
      FROM timestamp t
      JOIN total_data d ON d.timestamp_id = t.id
     WHERE t.timestamp >= ? AND t.timestamp <= ?
  `).get(bounds.start, bounds.end);
  return adjustedFromRaw(row.energy, row.seconds, config);
}

function currentReading(db, config) {
  if (!hasTable(db, 'total_data')) return { watts: 0, rawWatts: 0, timestamp: null, ageSeconds: null };
  const energyExpression = tableEnergyExpression(db, 'total_data');
  if (!energyExpression) return { watts: 0, rawWatts: 0, timestamp: null, ageSeconds: null };
  const periodExpression = timestampPeriodExpression(db);
  const row = db.prepare(`
    SELECT t.timestamp,
           ${periodExpression} AS sampling_seconds,
           ${energyExpression} AS energy_uj
      FROM timestamp t
      JOIN total_data d ON d.timestamp_id = t.id
     ORDER BY t.timestamp DESC LIMIT 1
  `).get();
  if (!row) return { watts: 0, rawWatts: 0, timestamp: null, ageSeconds: null };
  const seconds = Math.max(1, Number(row.sampling_seconds));
  const rawWatts = Number(row.energy_uj) / 1_000_000 / seconds;
  return {
    rawWatts,
    watts: rawWatts * config.sensorFactor + config.baseWatts + config.monitorWatts,
    timestamp: Number(row.timestamp),
    ageSeconds: Math.max(0, (Date.now() - Number(row.timestamp)) / 1000),
  };
}

function componentBreakdown(db, bounds, config) {
  const definitions = [
    ['cpu_data', 'CPU'],
    ['gpu_data', 'GPU'],
    ['ram_data', 'メモリ'],
    ['disk_data', 'ストレージ'],
    ['network_data', 'ネットワーク'],
  ];
  const components = [];
  let componentEnergy = 0;
  for (const [table, label] of definitions) {
    if (!hasTable(db, table)) continue;
    const energyExpression = tableEnergyExpression(db, table);
    if (!energyExpression) continue;
    const row = db.prepare(`
      SELECT COALESCE(SUM(${energyExpression}), 0) AS energy
        FROM timestamp t JOIN ${table} d ON d.timestamp_id = t.id
       WHERE t.timestamp >= ? AND t.timestamp <= ?
    `).get(bounds.start, bounds.end);
    const energy = Number(row.energy || 0);
    componentEnergy += energy;
    components.push({ key: table, label, kwh: energy / UJ_PER_KWH * config.sensorFactor });
  }
  const total = periodAggregate(db, bounds, config);
  const measuredAdjusted = Number(componentEnergy) / UJ_PER_KWH * config.sensorFactor;
  const overhead = Math.max(0, total.adjustedKwh - measuredAdjusted - config.monitorWatts * total.activeSeconds / 3_600_000);
  if (overhead > 0) components.push({ key: 'overhead', label: '基板・電源損失等', kwh: overhead });
  const monitor = config.monitorWatts * total.activeSeconds / 3_600_000;
  if (monitor > 0) components.push({ key: 'monitor', label: 'モニター', kwh: monitor });
  const sum = components.reduce((acc, item) => acc + item.kwh, 0);
  return components.map((item) => ({
    ...item,
    percent: sum > 0 ? item.kwh / sum * 100 : 0,
    cost: item.kwh * config.electricityRate,
  })).sort((a, b) => b.kwh - a.kwh);
}

function topApplications(db, bounds, config) {
  if (!hasTable(db, 'process_data')) return [];
  const energyExpression = tableEnergyExpression(db, 'process_data', 'p');
  if (!energyExpression) return [];
  const all = db.prepare(`
    SELECT COALESCE(SUM(${energyExpression}), 0) AS energy
      FROM timestamp t
      JOIN process_data p ON p.timestamp_id = t.id
     WHERE t.timestamp >= ? AND t.timestamp <= ?
  `).get(bounds.start, bounds.end);
  const rows = db.prepare(`
    SELECT p.app_name AS name,
           COALESCE(SUM(${energyExpression}), 0) AS energy
      FROM timestamp t
      JOIN process_data p ON p.timestamp_id = t.id
     WHERE t.timestamp >= ? AND t.timestamp <= ?
     GROUP BY p.app_name
     ORDER BY energy DESC
     LIMIT 15
  `).all(bounds.start, bounds.end);
  const allEnergy = Number(all.energy || 0);
  const total = periodAggregate(db, bounds, config);
  return rows.map((row) => {
    const share = allEnergy > 0 ? Number(row.energy) / allEnergy : 0;
    return {
      name: row.name || '不明',
      share: share * 100,
      kwh: total.adjustedKwh * share,
      cost: total.cost * share,
    };
  });
}

const APP_CATEGORY_RULES = [
  {
    key: 'browser', label: 'ブラウザー・動画',
    keywords: ['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'youtube', 'vlc', 'mpv', 'netflix'],
  },
  {
    key: 'communication', label: '通話・連絡',
    keywords: ['discord', 'teams', 'slack', 'zoom', 'line', 'skype', 'telegram'],
  },
  {
    key: 'work', label: '作業・制作',
    keywords: ['code', 'devenv', 'python', 'excel', 'winword', 'powerpnt', 'photoshop', 'premiere', 'afterfx', 'blender', 'reaper', 'audacity', 'ltspice', 'apx'],
  },
  {
    key: 'system', label: 'Windows・常駐',
    keywords: ['system', 'svchost', 'dwm', 'explorer', 'searchhost', 'startmenuexperience', 'shellexperience', 'runtimebroker', 'audiodg', 'defender', 'antimalware', 'nvidia container', 'wattseal'],
  },
];

function applicationCategory(name, config) {
  const normalized = String(name || '').toLowerCase();
  if (config.gameKeywords.some((keyword) => normalized.includes(keyword))) {
    return { key: 'game', label: 'ゲーム' };
  }
  const matched = APP_CATEGORY_RULES.find((rule) => rule.keywords.some((keyword) => normalized.includes(keyword)));
  return matched ? { key: matched.key, label: matched.label } : { key: 'other', label: 'その他・未分類' };
}

function applicationCategories(db, bounds, config) {
  if (!hasTable(db, 'process_data')) return [];
  const energyExpression = tableEnergyExpression(db, 'process_data', 'p');
  if (!energyExpression) return [];
  const rows = db.prepare(`
    SELECT p.app_name AS name, COALESCE(SUM(${energyExpression}), 0) AS energy
      FROM timestamp t JOIN process_data p ON p.timestamp_id = t.id
     WHERE t.timestamp >= ? AND t.timestamp <= ?
     GROUP BY p.app_name
  `).all(bounds.start, bounds.end);
  const grouped = new Map();
  let allEnergy = 0;
  for (const row of rows) {
    const energy = Number(row.energy || 0);
    allEnergy += energy;
    const category = applicationCategory(row.name, config);
    const current = grouped.get(category.key) || { ...category, energy: 0, apps: 0 };
    current.energy += energy;
    current.apps += 1;
    grouped.set(category.key, current);
  }
  const total = periodAggregate(db, bounds, config);
  return [...grouped.values()].map((item) => {
    const share = allEnergy > 0 ? item.energy / allEnergy : 0;
    return {
      key: item.key,
      label: item.label,
      apps: item.apps,
      share: share * 100,
      kwh: total.adjustedKwh * share,
      cost: total.cost * share,
    };
  }).sort((a, b) => b.share - a.share);
}

function localDateExpression(column = 't.timestamp') {
  return `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch', 'localtime')`;
}

function dailyHistory(db, bounds, config) {
  if (!hasTable(db, 'total_data')) return [];
  const energyExpression = tableEnergyExpression(db, 'total_data');
  if (!energyExpression) return [];
  const periodExpression = timestampPeriodExpression(db);
  const rows = db.prepare(`
    SELECT ${localDateExpression()} AS bucket,
           COALESCE(SUM(${energyExpression}), 0) AS energy,
           COALESCE(SUM(${periodExpression}), 0) AS seconds
      FROM timestamp t JOIN total_data d ON d.timestamp_id = t.id
     WHERE t.timestamp >= ? AND t.timestamp <= ?
     GROUP BY bucket ORDER BY bucket
  `).all(bounds.start, bounds.end);
  return rows.map((row) => ({
    bucket: row.bucket,
    timestamp: new Date(`${row.bucket}T00:00:00`).getTime(),
    ...adjustedFromRaw(row.energy, row.seconds, config),
  }));
}

function hourlyHistory(db, bounds, config) {
  if (!hasTable(db, 'total_data')) return [];
  const energyExpression = tableEnergyExpression(db, 'total_data');
  if (!energyExpression) return [];
  const periodExpression = timestampPeriodExpression(db);
  const rows = db.prepare(`
    SELECT strftime('%Y-%m-%d %H:00', t.timestamp / 1000, 'unixepoch', 'localtime') AS bucket,
           COALESCE(SUM(${energyExpression}), 0) AS energy,
           COALESCE(SUM(${periodExpression}), 0) AS seconds
      FROM timestamp t JOIN total_data d ON d.timestamp_id = t.id
     WHERE t.timestamp >= ? AND t.timestamp <= ?
     GROUP BY bucket ORDER BY bucket
  `).all(bounds.start, bounds.end);
  return rows.map((row) => ({
    bucket: row.bucket,
    timestamp: new Date(`${String(row.bucket).replace(' ', 'T')}:00`).getTime(),
    ...adjustedFromRaw(row.energy, row.seconds, config),
  }));
}

function previousRangeBounds(range, bounds) {
  if (range === 'all' || range === 'session') return null;
  const duration = Math.max(1, bounds.end - bounds.start);
  if (range === 'today') {
    const start = bounds.start - 86400000;
    return { start, end: start + duration, label: '昨日の同じ時刻まで' };
  }
  if (range === 'month') {
    const currentStart = new Date(bounds.start);
    const start = new Date(currentStart.getFullYear(), currentStart.getMonth() - 1, 1).getTime();
    const monthEnd = currentStart.getTime() - 1;
    return { start, end: Math.min(monthEnd, start + duration), label: '前月の同じ経過時点' };
  }
  const fullSpan = range === '7d' ? 7 * 86400000
    : range === '30d' ? 30 * 86400000
      : range === '90d' ? 90 * 86400000
        : 365 * 86400000;
  const start = bounds.start - fullSpan;
  return { start, end: start + duration, label: '直前の同期間' };
}

function percentDifference(current, previous) {
  if (!Number.isFinite(previous) || previous <= 0) return null;
  return (Number(current || 0) - previous) / previous * 100;
}

function periodInsights(db, range, bounds, history, totals, config) {
  const previousBounds = previousRangeBounds(range, bounds);
  const firstSample = hasTable(db, 'timestamp')
    ? Number(db.prepare('SELECT MIN(timestamp) AS value FROM timestamp').get()?.value || 0)
    : 0;
  const previousSpan = previousBounds ? Math.max(1, previousBounds.end - previousBounds.start) : 0;
  const startTolerance = Math.min(86400000, previousSpan * .08);
  const previousPartial = Boolean(previousBounds && firstSample > previousBounds.start + startTolerance);
  const previous = previousBounds && !previousPartial ? periodAggregate(db, previousBounds, config) : null;
  const peak = history.reduce((best, item) => !best || Number(item.cost || 0) > Number(best.cost || 0) ? item : best, null);
  return {
    previousLabel: previousBounds?.label || null,
    previous,
    previousPartial,
    previousBounds: previous && previousBounds ? previousBounds : null,
    costDifference: previous ? totals.cost - previous.cost : null,
    costDifferencePercent: previous ? percentDifference(totals.cost, previous.cost) : null,
    energyDifferencePercent: previous ? percentDifference(totals.adjustedKwh, previous.adjustedKwh) : null,
    activeTimeDifferencePercent: previous ? percentDifference(totals.activeSeconds, previous.activeSeconds) : null,
    peak,
    costPerActiveHour: totals.activeSeconds > 0 ? totals.cost / (totals.activeSeconds / 3600) : 0,
    runningCostPerHour: null,
  };
}

function recentSessions(db, config) {
  if (!hasTable(db, 'total_data')) return [];
  const energyExpression = tableEnergyExpression(db, 'total_data');
  if (!energyExpression) return [];
  const periodExpression = timestampPeriodExpression(db);
  const since = Date.now() - 30 * 86400000;
  const rows = db.prepare(`
    SELECT CAST(t.timestamp / 300000 AS INTEGER) * 300000 AS bucket,
           COALESCE(SUM(${energyExpression}), 0) AS energy,
           COALESCE(SUM(${periodExpression}), 0) AS seconds
      FROM timestamp t JOIN total_data d ON d.timestamp_id = t.id
     WHERE t.timestamp >= ?
     GROUP BY bucket ORDER BY bucket
  `).all(since);
  const sessions = [];
  let current = null;
  for (const row of rows) {
    const stamp = Number(row.bucket);
    const rowSeconds = Math.max(1, Number(row.seconds || 0));
    const allowedGap = current
      ? Math.max(10 * 60000, Math.min(2 * 3600000, current.lastSampleSeconds * 1500))
      : 10 * 60000;
    if (!current || stamp - current.lastBucket > allowedGap) {
      if (current) sessions.push(current);
      current = {
        start: stamp,
        end: stamp + Math.max(5 * 60000, rowSeconds * 1000),
        lastBucket: stamp,
        lastSampleSeconds: rowSeconds,
        energy: 0,
        seconds: 0,
      };
    }
    current.end = stamp + Math.max(5 * 60000, rowSeconds * 1000);
    current.lastBucket = stamp;
    current.lastSampleSeconds = rowSeconds;
    current.energy += Number(row.energy || 0);
    current.seconds += Number(row.seconds || 0);
  }
  if (current) sessions.push(current);
  return sessions.reverse().slice(0, 20).map((session) => {
    const totals = adjustedFromRaw(session.energy, session.seconds, config);
    return { start: session.start, end: session.end, ...totals };
  });
}

function quickStats(db, sessions, config) {
  const now = new Date();
  const currentSession = periodAggregate(db, rangeBounds('session'), config);
  const newestLooksCurrent = sessions[0] && sessions[0].end >= Date.now() - 15 * 60000;
  const previousSession = newestLooksCurrent ? sessions[1] || null : sessions[0] || null;
  const monthToDate = periodAggregate(db, rangeBounds('month'), config);
  const dayProgress = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
  const elapsedDays = Math.max(0.5, now.getDate() - 1 + dayProgress);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projectionFactor = daysInMonth / elapsedDays;
  return {
    currentSession,
    previousSession,
    monthProjection: {
      cost: monthToDate.cost * projectionFactor,
      adjustedKwh: monthToDate.adjustedKwh * projectionFactor,
      daysInMonth,
    },
  };
}

function databaseStatus(db) {
  let hardware = null;
  if (hasTable(db, 'hardware_info')) {
    const row = db.prepare('SELECT hardware_data, tables FROM hardware_info ORDER BY id DESC LIMIT 1').get();
    if (row) {
      try { hardware = JSON.parse(row.hardware_data); } catch (_) { hardware = { raw: row.hardware_data }; }
      if (hardware && typeof hardware === 'object') hardware.tables = row.tables;
    }
  }
  return { path: DB_PATH, hardware };
}

function summaryPayload(range) {
  const config = loadConfig();
  const bounds = rangeBounds(range);
  const db = openDatabase();
  try {
    const trendBounds = range === 'today' || range === 'session' ? bounds : rangeBounds(range);
    const sessions = recentSessions(db, config);
    const totals = periodAggregate(db, bounds, config);
    const current = currentReading(db, config);
    const hourly = range === 'today' || range === 'session';
    const history = hourly ? hourlyHistory(db, trendBounds, config) : dailyHistory(db, trendBounds, config);
    const insights = periodInsights(db, range, bounds, history, totals, config);
    insights.runningCostPerHour = current.watts / 1000 * config.electricityRate;
    const comparisonHistory = insights.previousBounds
      ? (hourly ? hourlyHistory(db, insights.previousBounds, config) : dailyHistory(db, insights.previousBounds, config))
        .map((point) => ({
          ...point,
          originalTimestamp: point.timestamp,
          timestamp: bounds.start + (point.timestamp - insights.previousBounds.start),
        }))
      : [];
    return {
      generatedAt: Date.now(),
      range,
      label: bounds.label,
      bounds,
      config,
      current,
      totals,
      components: componentBreakdown(db, bounds, config),
      applications: topApplications(db, bounds, config),
      applicationCategories: applicationCategories(db, bounds, config),
      history,
      comparisonHistory,
      historyGranularity: hourly ? 'hour' : 'day',
      insights,
      sessions,
      quickStats: quickStats(db, sessions, config),
      database: databaseStatus(db),
    };
  } finally {
    db.close();
  }
}

function firstExistingColumn(db, tableName, candidates) {
  const columns = tableColumns(db, tableName);
  return candidates.find((name) => columns.has(name)) || null;
}

function realtimePayload(minutes = 15) {
  const config = loadConfig();
  const safeMinutes = [5, 15, 60].includes(Number(minutes)) ? Number(minutes) : 15;
  const start = Date.now() - safeMinutes * 60000;
  const db = openDatabase();
  try {
    const energyExpression = tableEnergyExpression(db, 'total_data');
    const periodExpression = timestampPeriodExpression(db);
    if (!energyExpression) return { minutes: safeMinutes, points: [], peak: null, leaders: {} };
    const bucketMs = safeMinutes <= 5 ? 1000 : safeMinutes <= 15 ? 2000 : 10000;
    const rows = db.prepare(`
      SELECT CAST(t.timestamp / ? AS INTEGER) * ? AS stamp,
             AVG((${energyExpression}) / 1000000.0 / MAX(1, ${periodExpression})) AS watts
        FROM timestamp t JOIN total_data d ON d.timestamp_id = t.id
       WHERE t.timestamp >= ?
       GROUP BY stamp ORDER BY stamp
    `).all(bucketMs, bucketMs, start);
    const points = rows.map((row) => ({
      timestamp: Number(row.stamp),
      watts: Number(row.watts || 0) * config.sensorFactor + config.baseWatts + config.monitorWatts,
    }));
    const peak = points.reduce((best, point) => !best || point.watts > best.watts ? point : best, null);
    return { minutes: safeMinutes, points, peak, leaders: liveLeaders(db, config) };
  } finally {
    db.close();
  }
}

function liveLeaders(db, config) {
  const latest = hasTable(db, 'timestamp')
    ? db.prepare('SELECT id, timestamp FROM timestamp ORDER BY timestamp DESC LIMIT 1').get()
    : null;
  if (!latest) return { application: null, component: null };
  let application = null;
  if (hasTable(db, 'process_data')) {
    const power = firstExistingColumn(db, 'process_data', ['process_power_watts', 'power_watts']);
    const energy = firstExistingColumn(db, 'process_data', ['process_energy_uj', 'energy_uj']);
    const valueExpression = power ? `COALESCE(${power}, 0)` : energy ? `COALESCE(${energy}, 0) / 1000000.0` : null;
    if (valueExpression) {
      const row = db.prepare(`SELECT app_name AS name, ${valueExpression} AS watts FROM process_data WHERE timestamp_id=? ORDER BY watts DESC LIMIT 1`).get(latest.id);
      if (row) application = { name: row.name || '不明', watts: Number(row.watts || 0) * config.sensorFactor };
    }
  }
  const definitions = [['cpu_data', 'CPU'], ['gpu_data', 'GPU'], ['ram_data', 'メモリ'], ['disk_data', 'ストレージ'], ['network_data', 'ネットワーク']];
  let component = null;
  for (const [table, label] of definitions) {
    if (!hasTable(db, table)) continue;
    const power = firstExistingColumn(db, table, ['total_power_watts', 'power_watts']);
    const energy = firstExistingColumn(db, table, ['total_energy_uj', 'energy_uj']);
    const expression = power ? `COALESCE(${power}, 0)` : energy ? `COALESCE(${energy}, 0) / 1000000.0` : null;
    if (!expression) continue;
    const row = db.prepare(`SELECT ${expression} AS watts FROM ${table} WHERE timestamp_id=? LIMIT 1`).get(latest.id);
    const watts = Number(row?.watts || 0) * config.sensorFactor;
    if (!component || watts > component.watts) component = { name: label, watts };
  }
  return { application, component };
}

let previousCpuTimes = null;
function cpuUsagePercent() {
  const totals = os.cpus().reduce((sum, cpu) => {
    const all = Object.values(cpu.times).reduce((acc, value) => acc + value, 0);
    sum.idle += cpu.times.idle;
    sum.all += all;
    return sum;
  }, { idle: 0, all: 0 });
  let percent = null;
  if (previousCpuTimes) {
    const deltaAll = totals.all - previousCpuTimes.all;
    const deltaIdle = totals.idle - previousCpuTimes.idle;
    if (deltaAll > 0) percent = Math.max(0, Math.min(100, (1 - deltaIdle / deltaAll) * 100));
  }
  previousCpuTimes = totals;
  return percent;
}

function execFileText(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, ...options }, (error, stdout) => {
      resolve(error ? '' : String(stdout || '').trim());
    });
  });
}

async function gpuStatus() {
  const output = await execFileText('nvidia-smi.exe', [
    '--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw',
    '--format=csv,noheader,nounits',
  ]);
  if (!output) return null;
  const rows = output.split(/\r?\n/).filter(Boolean).map((line) => line.split(',').map((value) => value.trim()));
  if (!rows.length) return null;
  const names = rows.map((values) => values[0]).filter(Boolean);
  const numbers = (index) => rows.map((values) => Number(values[index])).filter(Number.isFinite);
  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const maximum = (values) => values.length ? Math.max(...values) : null;
  const sum = (values) => values.length ? values.reduce((total, value) => total + value, 0) : null;
  return {
    name: names.length > 1 ? `${names.length}基（${names.join(' / ')}）` : names[0] || 'NVIDIA GPU',
    count: rows.length,
    usagePercent: maximum(numbers(1)),
    temperatureC: maximum(numbers(2)),
    memoryUsedMb: sum(numbers(3)),
    memoryTotalMb: sum(numbers(4)),
    powerWatts: sum(numbers(5)),
  };
}

async function driveStatus() {
  if (process.platform !== 'win32') {
    try {
      const stat = fs.statfsSync(path.parse(process.cwd()).root);
      return [{ path: '/', label: os.hostname(), total: Number(stat.blocks) * Number(stat.bsize), free: Number(stat.bavail) * Number(stat.bsize), health: null }];
    } catch (_) { return []; }
  }
  const script = "$logical=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object @{N='path';E={$_.DeviceID+'\\'}},VolumeName,@{N='total';E={[double]$_.Size}},@{N='free';E={[double]$_.FreeSpace}}); $physical=@(Get-PhysicalDisk -ErrorAction SilentlyContinue | Select-Object HealthStatus,OperationalStatus); [pscustomobject]@{logical=$logical; physical=$physical} | ConvertTo-Json -Compress";
  const output = await execFileText('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script]);
  if (!output) return [];
  try {
    const parsed = JSON.parse(output);
    const physical = Array.isArray(parsed.physical) ? parsed.physical : parsed.physical ? [parsed.physical] : [];
    const health = physical.length
      ? physical.every((drive) => String(drive.HealthStatus || '').toLowerCase() === 'healthy' && String(drive.OperationalStatus || '').toLowerCase().includes('ok')) ? '正常' : '要確認'
      : null;
    const logical = Array.isArray(parsed.logical) ? parsed.logical : parsed.logical ? [parsed.logical] : [];
    return logical.map((drive) => ({ path: drive.path, label: drive.VolumeName || 'ローカルディスク', total: Number(drive.total || 0), free: Number(drive.free || 0), health }));
  } catch (_) { return []; }
}

function usageHistory(db, range) {
  const start = range === 'today' ? localStartOfDay() : Date.now() - 15 * 60000;
  const bucketMs = range === 'today' ? 5 * 60000 : 15000;
  const definitions = [
    ['cpu_data', 'cpu', ['usage_percent', 'usage_percentage', 'cpu_usage_percent', 'cpu_usage_percentage', 'usage']],
    ['gpu_data', 'gpu', ['usage_percent', 'usage_percentage', 'gpu_usage_percent', 'gpu_usage_percentage', 'usage']],
    ['ram_data', 'ram', ['usage_percent', 'usage_percentage', 'ram_usage_percent', 'ram_usage_percentage', 'usage']],
  ];
  const merged = new Map();
  for (const [table, key, candidates] of definitions) {
    if (!hasTable(db, table)) continue;
    const column = firstExistingColumn(db, table, candidates);
    if (!column) continue;
    const rows = db.prepare(`SELECT CAST(t.timestamp / ? AS INTEGER) * ? AS stamp, AVG(d.${column}) AS value FROM timestamp t JOIN ${table} d ON d.timestamp_id=t.id WHERE t.timestamp >= ? GROUP BY stamp ORDER BY stamp`).all(bucketMs, bucketMs, start);
    for (const row of rows) {
      const point = merged.get(Number(row.stamp)) || { timestamp: Number(row.stamp), cpu: null, gpu: null, ram: null };
      point[key] = row.value == null ? null : Number(row.value);
      merged.set(point.timestamp, point);
    }
  }
  return [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function systemPayload(range = '15m') {
  let latestSample = null;
  let history = [];
  try {
    const db = openDatabase();
    try {
      latestSample = hasTable(db, 'timestamp') ? db.prepare('SELECT timestamp FROM timestamp ORDER BY timestamp DESC LIMIT 1').get()?.timestamp || null : null;
      history = usageHistory(db, range === 'today' ? 'today' : '15m');
    } finally { db.close(); }
  } catch (_) {}
  const [gpu, drives, wattsealTask] = await Promise.all([
    gpuStatus(),
    driveStatus(),
    process.platform === 'win32' ? execFileText('tasklist.exe', ['/FI', 'IMAGENAME eq WattSeal.exe', '/NH']) : Promise.resolve(''),
  ]);
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  return {
    generatedAt: Date.now(),
    cpu: { name: os.cpus()[0]?.model || 'CPU', usagePercent: cpuUsagePercent() },
    ram: { totalBytes: totalMemory, usedBytes: totalMemory - freeMemory, usagePercent: totalMemory ? (totalMemory - freeMemory) / totalMemory * 100 : null },
    gpu,
    uptimeSeconds: os.uptime(),
    drives,
    wattseal: { running: process.platform === 'win32' ? /WattSeal\.exe/i.test(wattsealTask) : fs.existsSync(DB_PATH), latestSample, ageSeconds: latestSample ? Math.max(0, (Date.now() - latestSample) / 1000) : null },
    history,
  };
}

function dataStatusPayload() {
  let startedAt = null;
  let latestAt = null;
  try {
    const db = openDatabase();
    try {
      const row = hasTable(db, 'timestamp') ? db.prepare('SELECT MIN(timestamp) AS startedAt, MAX(timestamp) AS latestAt FROM timestamp').get() : null;
      startedAt = row?.startedAt || null;
      latestAt = row?.latestAt || null;
    } finally { db.close(); }
  } catch (_) {}
  const sizeOf = (filePath) => { try { return fs.statSync(filePath).size; } catch (_) { return 0; } };
  const databaseBytes = sizeOf(DB_PATH) + sizeOf(`${DB_PATH}-wal`) + sizeOf(`${DB_PATH}-shm`);
  return {
    version: APP_VERSION,
    databaseBytes,
    databasePath: DB_PATH,
    startedAt,
    latestAt,
    recordedDays: startedAt ? Math.max(1, Math.ceil((Date.now() - startedAt) / 86400000)) : 0,
    storageCacheBytes: sizeOf(STORAGE_RESULT_PATH),
    warning: databaseBytes >= 1024 ** 3 ? '電力履歴が1GBを超えています。必要ならCSV保存後に初期化できます。' : null,
  };
}

async function clearStorageCache() {
  if (fs.existsSync(STORAGE_RESULT_PATH)) fs.unlinkSync(STORAGE_RESULT_PATH);
  try { await fetch('http://127.0.0.1:17892/api/clear', { method: 'POST', signal: AbortSignal.timeout(1200) }); } catch (_) {}
  return { cleared: true };
}

async function stopOwnWattSeal() {
  if (process.platform !== 'win32') return;
  const targetPath = WATTSEAL_PATH.replace(/'/g, "''");
  const script = `$target='${targetPath}'; @(Get-CimInstance Win32_Process -Filter \"Name='WattSeal.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $target } | Select-Object -ExpandProperty ProcessId)`;
  const output = await execFileText('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script]);
  const processIds = output.split(/\r?\n/).map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
  for (const processId of processIds) await execFileText('taskkill.exe', ['/PID', String(processId), '/T', '/F']);
}

async function clearPowerHistory(confirmation) {
  if (confirmation !== 'DELETE_POWER_HISTORY') throw Object.assign(new Error('確認文字列が一致しません。'), { statusCode: 400 });
  if (path.dirname(path.resolve(DB_PATH)) !== path.resolve(APP_DIR) || path.basename(DB_PATH) !== 'power_monitoring.db') {
    throw Object.assign(new Error('安全確認のため、標準保存場所にある履歴だけ初期化できます。'), { statusCode: 400 });
  }
  if (process.platform !== 'win32') throw Object.assign(new Error('履歴の初期化はWindows上のインストール版から実行してください。'), { statusCode: 400 });
  await stopOwnWattSeal();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      for (const target of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (fs.existsSync(target)) fs.unlinkSync(target);
      break;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const wscriptPath = path.join(systemRoot, 'System32', 'wscript.exe');
  if (fs.existsSync(wscriptPath) && fs.existsSync(path.join(APP_DIR, 'background.vbs'))) execFile(wscriptPath, [path.join(APP_DIR, 'background.vbs')], { windowsHide: true }, () => {});
  return { cleared: true };
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(range) {
  const config = loadConfig();
  const bounds = rangeBounds(range);
  const db = openDatabase();
  try {
    const rows = dailyHistory(db, bounds, config);
    const lines = [['日付', '使用時間(h)', '推定電力量(kWh)', '推定料金(円)', '平均電力(W)']];
    for (const row of rows) {
      lines.push([
        row.bucket,
        (row.activeSeconds / 3600).toFixed(3),
        row.adjustedKwh.toFixed(6),
        row.cost.toFixed(2),
        row.averageWatts.toFixed(1),
      ]);
    }
    return '\uFEFF' + lines.map((line) => line.map(csvEscape).join(',')).join('\r\n');
  } finally {
    db.close();
  }
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(reqPath, res) {
  const relative = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR) + path.sep) && resolved !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
  }[path.extname(resolved)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  fs.createReadStream(resolved).pipe(res);
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(Object.assign(new Error('送信内容が大きすぎます。'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) { throw Object.assign(new Error('送信内容のJSON形式が正しくありません。'), { statusCode: 400 }); }
}

function requestHostname(req) {
  const rawHost = String(req.headers.host || '').trim();
  if (!rawHost) return LOCAL_HOST;
  try {
    const parsed = new URL(`http://${rawHost}`);
    if (parsed.hostname === '0.0.0.0' || parsed.hostname === '::') return LOCAL_HOST;
    return parsed.hostname;
  } catch (_) {
    return LOCAL_HOST;
  }
}

function sameOriginRequest(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  try {
    const expected = new URL(`http://${req.headers.host}`);
    const actual = new URL(origin);
    return actual.protocol === 'http:' && actual.host === expected.host;
  } catch (_) {
    return false;
  }
}

function isLocalNetworkAddress(address) {
  const value = String(address || '').replace(/^::ffff:/i, '').split('%')[0].toLowerCase();
  if (value === '::1' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true;
  const octets = value.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 127 || octets[0] === 10 || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

function networkInfoPayload() {
  const urls = [];
  try {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if ((address.family === 'IPv4' || address.family === 4) && !address.internal) urls.push(`http://${address.address}:${PORT}`);
      }
    }
  } catch (_) {}
  return {
    lanAccess: HOST === '0.0.0.0',
    localUrl: `http://${LOCAL_HOST}:${PORT}`,
    urls: [...new Set(urls)],
  };
}

function restartDashboard() {
  if (process.platform !== 'win32') throw Object.assign(new Error('ダッシュボードの自動再起動はWindows版でのみ使用できます。'), { statusCode: 400 });
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const wscriptPath = path.join(systemRoot, 'System32', 'wscript.exe');
  const dashboardPath = path.join(APP_DIR, 'dashboard.vbs');
  if (!fs.existsSync(wscriptPath) || !fs.existsSync(dashboardPath)) throw Object.assign(new Error('ダッシュボードの再起動ファイルが見つかりません。'), { statusCode: 503 });
  setTimeout(() => {
    server.close(() => {
      execFile(wscriptPath, [dashboardPath], { windowsHide: true }, () => process.exit(0));
    });
  }, 250);
  return { restarting: true };
}

async function openStorageMap(req) {
  if (!fs.existsSync(STORAGE_SERVER_PATH)) {
    const error = new Error('容量マップが見つかりません。統合版のSETUP.cmdをもう一度実行してください。');
    error.statusCode = 503;
    throw error;
  }
  const browserHost = requestHostname(req);
  const storageUrl = `http://${browserHost}:17892`;
  const storageLanAccess = loadConfig().lanAccess;
  try {
    const existing = await fetch('http://127.0.0.1:17892/api/status', { signal: AbortSignal.timeout(500) });
    if (existing.ok) {
      let matchesAccessMode = false;
      try {
        const access = await fetch('http://127.0.0.1:17892/api/access-info', { signal: AbortSignal.timeout(500) });
        const payload = access.ok ? await access.json() : null;
        matchesAccessMode = payload && Boolean(payload.lanAccess) === storageLanAccess;
      } catch (_) {}
      if (matchesAccessMode) return { opened: true, alreadyRunning: true, url: storageUrl };
      try { await fetch('http://127.0.0.1:17892/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(700) }); } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } catch (_) {}
  const child = spawn(process.execPath, [STORAGE_SERVER_PATH], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PC_STORAGE_EMBEDDED: '1', PC_STORAGE_HOST: storageLanAccess ? '0.0.0.0' : LOCAL_HOST },
  });
  child.unref();
  return { opened: true, url: storageUrl };
}

const server = http.createServer(async (req, res) => {
  if (HOST === '0.0.0.0' && !isLocalNetworkAddress(req.socket.remoteAddress)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Local network only');
    return;
  }
  lastActivity = Date.now();
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/summary') {
      const allowed = new Set(['session', 'today', '7d', 'month', '30d', '90d', 'year', 'all']);
      const range = allowed.has(url.searchParams.get('range')) ? url.searchParams.get('range') : 'today';
      jsonResponse(res, 200, summaryPayload(range));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/ping') {
      jsonResponse(res, 200, { ok: true, version: APP_VERSION });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/realtime') {
      jsonResponse(res, 200, realtimePayload(Number(url.searchParams.get('minutes') || 15)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/system') {
      jsonResponse(res, 200, await systemPayload(url.searchParams.get('range') || '15m'));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/data-status') {
      jsonResponse(res, 200, dataStatusPayload());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/access-info') {
      jsonResponse(res, 200, networkInfoPayload());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/export') {
      const allowed = new Set(['session', 'today', '7d', 'month', '30d', '90d', 'year', 'all']);
      const range = allowed.has(url.searchParams.get('range')) ? url.searchParams.get('range') : 'month';
      const csv = buildCsv(range);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="pc-power-${range}.csv"`,
        'Content-Length': Buffer.byteLength(csv),
      });
      res.end(csv);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      jsonResponse(res, 200, loadConfig());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      if (!sameOriginRequest(req)) throw Object.assign(new Error('許可されていない接続元です。'), { statusCode: 403 });
      const current = loadConfig();
      const body = parseJson(await readBody(req));
      const next = saveConfig(body);
      jsonResponse(res, 200, { ...next, restartRequired: current.lanAccess !== next.lanAccess });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/reset-settings') {
      if (!sameOriginRequest(req)) throw Object.assign(new Error('許可されていない接続元です。'), { statusCode: 403 });
      jsonResponse(res, 200, saveConfig(DEFAULT_CONFIG));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/clear-storage-cache') {
      if (!sameOriginRequest(req)) throw Object.assign(new Error('許可されていない接続元です。'), { statusCode: 403 });
      jsonResponse(res, 200, await clearStorageCache());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/clear-power-history') {
      if (!sameOriginRequest(req)) throw Object.assign(new Error('許可されていない接続元です。'), { statusCode: 403 });
      const body = parseJson(await readBody(req));
      jsonResponse(res, 200, await clearPowerHistory(body.confirmation));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/open-storage') {
      if (!sameOriginRequest(req)) throw Object.assign(new Error('許可されていない接続元です。'), { statusCode: 403 });
      jsonResponse(res, 200, await openStorageMap(req));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/restart') {
      if (!sameOriginRequest(req)) throw Object.assign(new Error('許可されていない接続元です。'), { statusCode: 403 });
      jsonResponse(res, 200, restartDashboard());
      return;
    }
    if (req.method === 'GET') {
      serveStatic(url.pathname, res);
      return;
    }
    res.writeHead(405); res.end('Method not allowed');
  } catch (error) {
    const status = error.statusCode || (error.code === 'DB_NOT_READY' ? 503 : 500);
    jsonResponse(res, status, { error: error.message || String(error) });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    if (process.platform === 'win32') execFile('explorer.exe', [`http://${LOCAL_HOST}:${PORT}`], () => process.exit(0));
    else process.exit(0);
  } else {
    process.exitCode = 1;
  }
});

server.listen(PORT, HOST, () => {
  try { fs.writeFileSync(PID_PATH, String(process.pid), 'utf8'); } catch (_) {}
  if (process.platform === 'win32') execFile('explorer.exe', [`http://${LOCAL_HOST}:${PORT}`], () => {});
});

function removeOwnPidFile() {
  try {
    if (fs.readFileSync(PID_PATH, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_PATH);
  } catch (_) {}
}

process.on('exit', removeOwnPidFile);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

const idleTimer = setInterval(() => {
  if (Date.now() - lastActivity > 5 * 60 * 1000) {
    clearInterval(idleTimer);
    server.close(() => process.exit(0));
  }
}, 30 * 1000);
idleTimer.unref();
