'use strict';

// WattSeal系 SQLite DB への読み取り専用アクセス。
// v1.0.2 系（timestamp / total_data / cpu_data ...）と旧形式（sampling_period,
// total_energy_uj 等）の両方を扱い、列の有無で自動的に切り替える。

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const UJ_PER_KWH = 3_600_000_000_000;
const UJ_PER_WATT_SECOND = 1_000_000;

const COMPONENT_TABLES = Object.freeze([
  ['cpu_data', 'CPU', 'cpu'],
  ['gpu_data', 'GPU', 'gpu'],
  ['ram_data', 'メモリ', 'ram'],
  ['disk_data', 'ストレージ', 'disk'],
  ['network_data', 'ネットワーク', 'network'],
]);

function hasTable(db, tableName) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(tableName));
}

function tableColumns(db, tableName) {
  if (!hasTable(db, tableName)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function firstExistingColumn(columns, candidates) {
  return candidates.find((name) => columns.has(name)) || null;
}

function powerColumn(db, tableName) {
  const columns = tableColumns(db, tableName);
  return firstExistingColumn(columns, tableName === 'process_data'
    ? ['process_power_watts', 'power_watts', 'total_power_watts']
    : ['total_power_watts', 'power_watts']);
}

function energyColumn(db, tableName) {
  const columns = tableColumns(db, tableName);
  return firstExistingColumn(columns, tableName === 'process_data'
    ? ['process_energy_uj', 'energy_uj']
    : ['total_energy_uj', 'energy_uj']);
}

// 1サンプルの継続秒数。WattSeal v1.0.2 は timestamp.period_type に秒（1 か 3600）を持つ。
function periodSecondsExpression(db, alias = 't') {
  const columns = tableColumns(db, 'timestamp');
  const column = firstExistingColumn(columns, ['sampling_period', 'period_type', 'period_seconds']);
  if (!column) return '1';
  return `CASE WHEN CAST(${alias}.${column} AS REAL) > 0 THEN CAST(${alias}.${column} AS REAL) ELSE 1 END`;
}

function hasTimestampTable(db) {
  return hasTable(db, 'timestamp');
}

// サンプルの瞬時電力(W)を返す式。列が無い場合は null。
function wattsExpression(db, tableName, alias = 'd') {
  const column = powerColumn(db, tableName);
  if (column) return `${alias}.${column}`;
  const energy = energyColumn(db, tableName);
  if (energy) return `${alias}.${energy} / ${UJ_PER_WATT_SECOND} / MAX(1, ${periodSecondsExpression(db, 't')})`;
  return null;
}

// サンプルの電力量(µJ)を返す式。列が無い場合は null。
function energyExpression(db, tableName, alias = 'd') {
  const energy = energyColumn(db, tableName);
  if (energy) return `COALESCE(${alias}.${energy}, 0)`;
  const watts = powerColumn(db, tableName);
  if (watts) return `(${alias}.${watts} * ${UJ_PER_WATT_SECOND} * ${periodSecondsExpression(db, 't')})`;
  return null;
}

function samplesPerSecondEstimate(db) {
  try {
    const row = db.prepare(`SELECT AVG(${periodSecondsExpression(db, 't')}) AS seconds FROM (SELECT * FROM timestamp ORDER BY timestamp DESC LIMIT 200) t`).get();
    const seconds = Number(row?.seconds);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 1;
  } catch (_) {
    return 1;
  }
}

// 1時間（またはそれ以上）の平均に畳まれた記録かどうかを 1/0 で返す式。
// v1.0.2 は total_data.period_type に 'second' / 'hour' を持つ。
// 列が無い旧形式では、1サンプルが5分以上を代表している場合を畳まれた記録とみなす。
function aggregatedExpression(db, dataAlias = 'd', timestampAlias = 't') {
  const columns = tableColumns(db, 'total_data');
  if (columns.has('period_type')) {
    return `CASE WHEN LOWER(CAST(COALESCE(${dataAlias}.period_type, 'second') AS TEXT)) IN ('hour', 'day', 'minute') THEN 1 ELSE 0 END`;
  }
  return `CASE WHEN ${periodSecondsExpression(db, timestampAlias)} >= 300 THEN 1 ELSE 0 END`;
}

// 例: 1秒記録なら 1、1時間ロールアップのみなら 3600。
function resolutionLabel(seconds) {
  return Number(seconds) >= 60 ? 'hour' : 'second';
}

function createDatabase(options) {
  const dbPath = options.path;
  let cached = null;

  function invalidate() {
    if (cached) {
      try { cached.close(); } catch (_) {}
      cached = null;
    }
  }

  function open() {
    if (cached) return cached;
    if (!fs.existsSync(dbPath)) {
      const error = new Error('記録データを準備中です。1〜2分待ってから更新してください。');
      error.code = 'DB_NOT_READY';
      throw error;
    }
    cached = new DatabaseSync(dbPath, { readOnly: true });
    return cached;
  }

  function withDatabase(work) {
    try {
      return work(open());
    } catch (error) {
      const message = String(error?.message || '');
      const closed = /closed|not open|no such|cannot start a transaction/i.test(message);
      if (!closed) throw error;
      invalidate();
      return work(open());
    }
  }

  // 削除系の操作だけが書き込みモードでDBを開く（呼び出し側で対象パスを厳格に確認する）。
  function withWritableDatabase(work) {
    const db = new DatabaseSync(dbPath);
    try {
      return work(db);
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  function bounds() {
    return withDatabase((db) => {
      if (!hasTimestampTable(db)) return { first: null, last: null, samples: 0 };
      const row = db.prepare('SELECT MIN(timestamp) AS first, MAX(timestamp) AS last, COUNT(*) AS samples FROM timestamp').get();
      return { first: row?.first ?? null, last: row?.last ?? null, samples: Number(row?.samples || 0) };
    });
  }

  function exists() {
    try { return fs.existsSync(dbPath); } catch (_) { return false; }
  }

  return {
    path: dbPath,
    invalidate,
    withDatabase,
    withWritableDatabase,
    bounds,
    exists,
  };
}

module.exports = {
  COMPONENT_TABLES,
  UJ_PER_KWH,
  UJ_PER_WATT_SECOND,
  aggregatedExpression,
  createDatabase,
  energyColumn,
  energyExpression,
  firstExistingColumn,
  hasTable,
  hasTimestampTable,
  periodSecondsExpression,
  powerColumn,
  resolutionLabel,
  samplesPerSecondEstimate,
  tableColumns,
  wattsExpression,
};
