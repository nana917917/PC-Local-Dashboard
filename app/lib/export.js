'use strict';

// CSV / JSON 出力とDBバックアップ。出力には「推定値」であることと、
// データ品質（欠損・1時間ロールアップ）を必ず含める。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { hasTable } = require('./db');
const { formatDateInput } = require('./time');

const CHILD_TABLES = Object.freeze([
  'total_data', 'cpu_data', 'gpu_data', 'ram_data', 'disk_data', 'network_data', 'process_data',
]);

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function qualityLabel(bucket) {
  if (bucket.missing) return '記録なし';
  if (bucket.quality === 'partial') return `一部欠損（記録${Math.round(bucket.coveragePercent)}%）`;
  if (bucket.quality === 'rollup') return '1時間平均の記録';
  if (bucket.quality === 'zero') return '0Wとして記録';
  return '通常（1秒記録）';
}

function bucketDateTime(bucket) {
  const date = new Date(bucket.timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  if (bucket.granularity === 'month') return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  if (bucket.granularity === 'day') return day;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildCsv({ buckets, granularity, label, config }) {
  const header = [
    '期間', '区間開始', '区間', '平均電力(W)', '最大電力(W)', '最小電力(W)',
    '推定電力量(kWh)', '推定料金(円)', '使用時間(秒)', 'データ品質', '欠損時間(秒)', 'データ点数', '前期間との差(円)',
  ];
  const lines = [header];
  for (const bucket of buckets) {
    lines.push([
      label,
      bucketDateTime(bucket),
      granularity === 'minute' ? '分' : granularity === 'hour' ? '時間' : granularity === 'month' ? '月' : '日',
      bucket.missing ? '' : Number(bucket.averageWatts || 0).toFixed(2),
      bucket.maxWatts == null ? '' : Number(bucket.maxWatts).toFixed(2),
      bucket.minWatts == null ? '' : Number(bucket.minWatts).toFixed(2),
      bucket.missing ? '' : Number(bucket.kwh || 0).toFixed(6),
      bucket.missing ? '' : Number(bucket.cost || 0).toFixed(3),
      bucket.missing ? '' : Math.round(bucket.activeSeconds),
      qualityLabel(bucket),
      bucket.missing ? Math.round(bucket.expectedSeconds) : Math.round(Math.max(0, bucket.expectedSeconds - bucket.activeSeconds)),
      bucket.missing ? 0 : bucket.samples,
      bucket.previousCost == null ? '' : Number(bucket.previousCost - (bucket.cost || 0)).toFixed(3),
    ]);
  }
  const footer = [
    '# 推定値',
    `# 電流値ではなくWattSealの内部センサー記録（推定）`,
    `# 単価 ${config.electricityRate}円/kWh・センサー倍率 ${config.sensorFactor}・校正 ${config.wallCalibration}・固定 ${config.baseWatts + config.monitorWatts}W`,
    `# 出力日時 ${new Date().toLocaleString('ja-JP')}`,
  ];
  return '\uFEFF' + [...lines.map((line) => line.map(csvEscape).join(',')), '', ...footer.map((line) => csvEscape(line))].join('\r\n');
}

function buildJson(payload) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: '電力値はWattSealの内部センサーによる推定値です。実際のコンセント測定値ではありません。',
    ...payload,
  }, null, 2);
}

// 一貫性のあるDBバックアップ（読み取り専用接続から VACUUM INTO で複製する）
function createDatabaseBackup(dbPath, targetPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const escaped = targetPath.replace(/\\/g, '/').replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    try { db.close(); } catch (_) {}
  }
  const stat = fs.statSync(targetPath);
  return { path: targetPath, bytes: stat.size };
}

function temporaryBackupPath(extension = '.db') {
  return path.join(os.tmpdir(), `pc-local-dashboard-${Date.now()}-${Math.random().toString(16).slice(2, 10)}${extension}`);
}

// 指定期間の削除（呼び出し側でWattSeal停止と対象パス確認を行う）
function deleteRange(dbPath, start, end) {
  const db = new DatabaseSync(dbPath);
  try {
    const ids = db.prepare('SELECT id FROM timestamp WHERE timestamp >= ? AND timestamp <= ?').all(start, end).map((row) => Number(row.id));
    if (!ids.length) return { deletedSamples: 0, deletedRows: 0 };
    let deletedRows = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      // 1件ずつではなく、まとめて削除する（大量の記録でも現実的な時間で終わるようにする）
      const batchSize = 2000;
      for (let offset = 0; offset < ids.length; offset += batchSize) {
        const batch = ids.slice(offset, offset + batchSize);
        const placeholders = batch.map(() => '?').join(',');
        for (const table of CHILD_TABLES) {
          if (!hasTable(db, table)) continue;
          const result = db.prepare(`DELETE FROM ${table} WHERE timestamp_id IN (${placeholders})`).run(...batch);
          deletedRows += Number(result.changes || 0);
        }
        db.prepare(`DELETE FROM timestamp WHERE id IN (${placeholders})`).run(...batch);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
    try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch (_) {}
    return { deletedSamples: ids.length, deletedRows, from: formatDateInput(start), to: formatDateInput(end) };
  } finally {
    try { db.close(); } catch (_) {}
  }
}

module.exports = {
  CHILD_TABLES,
  bucketDateTime,
  buildCsv,
  buildJson,
  createDatabaseBackup,
  deleteRange,
  qualityLabel,
  temporaryBackupPath,
};
