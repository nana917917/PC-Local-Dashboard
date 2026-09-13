'use strict';

// テスト用のWattSeal形式DBを作る。
// 実DBと同じ列構成（v1.0.2系）と、旧形式（sampling_period / *_energy_uj）の両方に対応する。

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MODERN_SCHEMA = `
  CREATE TABLE timestamp (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, period_type INTEGER DEFAULT 1);
  CREATE TABLE total_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp_id INTEGER, total_power_watts REAL, period_type TEXT);
  CREATE TABLE cpu_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp_id INTEGER, total_power_watts REAL, pp0_power_watts REAL, pp1_power_watts REAL, dram_power_watts REAL, usage_percent REAL);
  CREATE TABLE gpu_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp_id INTEGER, total_power_watts REAL, usage_percent REAL, vram_usage_percent REAL);
  CREATE TABLE ram_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp_id INTEGER, total_power_watts REAL, usage_percent REAL);
  CREATE TABLE disk_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp_id INTEGER, total_power_watts REAL, read_usage_mb_s REAL, write_usage_mb_s REAL);
  CREATE TABLE network_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp_id INTEGER, total_power_watts REAL, download_speed_mb_s REAL, upload_speed_mb_s REAL);
  CREATE TABLE process_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp_id INTEGER, app_name TEXT, process_exe_path TEXT, process_power_watts REAL, process_cpu_usage REAL, process_gpu_usage REAL, process_mem_usage REAL, read_bytes_per_sec REAL, written_bytes_per_sec REAL, subprocess_count INTEGER);
  CREATE TABLE hardware_info (id INTEGER PRIMARY KEY AUTOINCREMENT, tables TEXT, hardware_data TEXT);
  CREATE TABLE component_all_time_data (id INTEGER PRIMARY KEY AUTOINCREMENT, component_name TEXT, total_energy_wh REAL);
`;

// 旧形式: 電力量(µJ)列と sampling_period を使う構成
const LEGACY_SCHEMA = `
  CREATE TABLE timestamp (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, sampling_period INTEGER DEFAULT 1);
  CREATE TABLE total_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp_id INTEGER, total_energy_uj REAL);
  CREATE TABLE cpu_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp_id INTEGER, total_energy_uj REAL, usage_percent REAL);
  CREATE TABLE gpu_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp_id INTEGER, total_energy_uj REAL, usage_percent REAL);
  CREATE TABLE ram_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp_id INTEGER, total_energy_uj REAL, usage_percent REAL);
  CREATE TABLE process_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp_id INTEGER, app_name TEXT, process_energy_uj REAL);
`;

const DAY_MS = 86400000;

function insertSample(db, sample) {
  const { ts, watts, periodSeconds = 1, legacy = false, apps = [], components = null, usage = null, rollup = false } = sample;
  const info = legacy
    ? db.prepare('INSERT INTO timestamp (timestamp, sampling_period) VALUES (?, ?)').run(ts, periodSeconds)
    : db.prepare('INSERT INTO timestamp (timestamp, period_type) VALUES (?, ?)').run(ts, periodSeconds);
  const id = Number(info.lastInsertRowid);
  const energyUj = (watts == null ? null : watts * 1000000 * periodSeconds);
  if (legacy) {
    db.prepare('INSERT INTO total_data (timestamp_id, total_energy_uj) VALUES (?, ?)').run(id, energyUj);
  } else {
    db.prepare('INSERT INTO total_data (timestamp_id, total_power_watts, period_type) VALUES (?, ?, ?)')
      .run(id, watts, rollup ? 'hour' : 'second');
  }
  const parts = components || { cpu: watts == null ? null : watts * 0.45, gpu: watts == null ? null : watts * 0.35, ram: watts == null ? null : watts * 0.05, disk: watts == null ? null : watts * 0.03, network: watts == null ? null : watts * 0.02 };
  for (const [table, value] of [['cpu_data', parts.cpu], ['gpu_data', parts.gpu], ['ram_data', parts.ram], ['disk_data', parts.disk], ['network_data', parts.network]]) {
    if (value === undefined) continue;
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    if (legacy) {
      db.prepare(`INSERT INTO ${table} (timestamp_id, total_energy_uj, usage_percent) VALUES (?, ?, ?)`)
        .run(id, value == null ? null : value * 1000000 * periodSeconds, usage?.[table] ?? null);
    } else if (table === 'disk_data' || table === 'network_data') {
      db.prepare(`INSERT INTO ${table} (timestamp_id, total_power_watts) VALUES (?, ?)`).run(id, value);
    } else {
      db.prepare(`INSERT INTO ${table} (timestamp_id, total_power_watts, usage_percent) VALUES (?, ?, ?)`)
        .run(id, value, usage?.[table] ?? null);
    }
  }
  for (const app of apps) {
    if (legacy) {
      db.prepare('INSERT INTO process_data (timestamp_id, app_name, process_energy_uj) VALUES (?, ?, ?)')
        .run(id, app.name, (app.watts || 0) * 1000000 * periodSeconds);
    } else {
      db.prepare('INSERT INTO process_data (timestamp_id, app_name, process_exe_path, process_power_watts) VALUES (?, ?, ?, ?)')
        .run(id, app.name, app.path || null, app.watts);
    }
  }
  return id;
}

// 決定的な擬似乱数（テストの再現性のため）
function createRandom(seed = 1234) {
  let value = seed % 2147483647;
  if (value <= 0) value += 2147483646;
  return () => {
    value = value * 16807 % 2147483647;
    return (value - 1) / 2147483646;
  };
}

function baseWattsAt(hour) {
  if (hour >= 1 && hour < 7) return 45;
  if (hour >= 9 && hour < 18) return 90;
  if (hour >= 19 && hour < 23) return 160;
  return 70;
}

/**
 * 連続した期間のサンプルを作る。
 * @param {object} db
 * @param {object} options
 */
function generateSamples(db, options) {
  const {
    start, end, stepSeconds = 60, rollupAfter = null, wattsAt = null, legacy = false,
    gaps = [], zeroSpans = [], nullSpans = [], apps = [], seed = 1234,
  } = options;
  const random = createRandom(seed);
  const inSpan = (spans, ts) => spans.some(([from, to]) => ts >= from && ts < to);
  let count = 0;
  let lastRollupHour = null;
  for (let ts = start; ts <= end; ts += stepSeconds * 1000) {
    if (inSpan(gaps, ts)) continue;
    const hour = new Date(ts).getHours();
    const base = wattsAt ? wattsAt(ts, hour) : baseWattsAt(hour);
    const jitter = 1 + (random() - 0.5) * 0.25;
    let watts = Math.round(base * jitter * 10) / 10;
    if (inSpan(zeroSpans, ts)) watts = 0;
    if (inSpan(nullSpans, ts)) watts = null;
    const isRollup = rollupAfter != null && ts < rollupAfter;
    if (isRollup) {
      // 1時間ごとの平均記録に畳まれている期間は、1時間に1件だけ作る
      const hourKey = Math.floor(ts / 3600000);
      if (hourKey === lastRollupHour) continue;
      lastRollupHour = hourKey;
    }
    // 畳まれた記録は1時間を代表し、それ以外は記録間隔ぶんを代表する
    const periodSeconds = isRollup ? 3600 : Math.max(1, stepSeconds);
    const appList = watts == null ? [] : apps.map((app, index) => ({
      name: app.name,
      watts: Math.round(watts * (app.share || (index === 0 ? 0.3 : 0.1)) * 100) / 100,
    }));
    insertSample(db, {
      ts, watts, periodSeconds, legacy, apps: appList, rollup: isRollup,
      usage: legacy ? null : (legacy ? null : { cpu_data: 20 + Math.round(random() * 40), gpu_data: Math.round(random() * 50), ram_data: 40 + Math.round(random() * 20) }),
    });
    count += 1;
  }
  return count;
}

function writeConfig(configPath, overrides = {}) {
  fs.writeFileSync(configPath, `${JSON.stringify({
    electricityRate: 31,
    sensorFactor: 1.1,
    baseWatts: 25,
    monitorWatts: 0,
    monthlyBudget: 3000,
    lanAccess: false,
    gameKeywords: ['steam', 'terraria'],
    ...overrides,
  }, null, 2)}\n`, 'utf8');
}

function createFixture(dir, scenario, options = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, `${scenario}.db`);
  const configPath = path.join(dir, `${scenario}.config.json`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new DatabaseSync(dbPath);
  const now = options.now ? Number(options.now) : Date.now();
  const dayStartDate = new Date(now);
  dayStartDate.setHours(0, 0, 0, 0);
  const day0 = dayStartDate.getTime();
  const legacy = scenario === 'legacy';
  // 何時に実行しても「今日」のデータが入るように、当日0時から現在直前まで作る
  const todayEnd = now - 60000;
  const todayStart = day0;
  const todaySpan = Math.max(10 * 60000, todayEnd - todayStart);
  // 日付が変わった直後でも「一部欠損」を作れるよう、欠損の長さは当日の長さに合わせる
  const gapMs = Math.min(30 * 60000, Math.max(2 * 60000, todaySpan * 0.05));
  const gapStart = todayStart + Math.floor(todaySpan * 0.4);
  const gapEnd = Math.min(todayEnd, gapStart + gapMs);
  // 昨日は必ず24時間あるので、欠損・0Wの検証は昨日の固定時刻で行う
  const yesterdayStart = day0 - 24 * 3600000;
  const yesterdayAt = (hours) => yesterdayStart + hours * 3600000;
  db.exec(legacy ? LEGACY_SCHEMA : MODERN_SCHEMA);
  // 大量のサンプルを高速に作るため、テスト用DBはトランザクション内で組み立てる
  db.exec('PRAGMA journal_mode = MEMORY');
  db.exec('PRAGMA synchronous = OFF');
  db.exec('BEGIN');
  if (!legacy) {
    db.prepare('INSERT INTO hardware_info (tables, hardware_data) VALUES (?, ?)').run(
      'cpu_data,gpu_data,ram_data,disk_data,network_data,total_data,process_data',
      JSON.stringify({ system: { os: 'Windows 11 (test)', hostname: 'TEST-HOST' }, cpu: { name: 'Test CPU', physical_cores: 8, logical_cores: 16, base_frequency_mhz: 3600 }, memory: { total_ram_bytes: 17179869184 } }),
    );
  }

  switch (scenario) {
    case 'empty':
      break;
    case 'single':
      insertSample(db, { ts: now - 5000, watts: 77.5, legacy, apps: [{ name: 'test.exe', watts: 20 }] });
      break;
    case 'stale':
      generateSamples(db, { start: now - 3 * 3600000, end: now - 2 * 3600000, stepSeconds: 60, apps: [{ name: 'chrome.exe', share: 0.4 }] });
      break;
    case 'zero':
      generateSamples(db, {
        start: yesterdayAt(0),
        end: yesterdayAt(6),
        stepSeconds: 60,
        zeroSpans: [[yesterdayAt(2), yesterdayAt(3)]],
      });
      break;
    case 'today':
      generateSamples(db, {
        start: todayStart,
        end: todayEnd,
        stepSeconds: 60,
        gaps: [[gapStart, gapEnd]],
        apps: [{ name: 'chrome.exe', share: 0.3 }, { name: 'steam.exe', share: 0.2 }, { name: 'code.exe', share: 0.1 }],
      });
      // 前日の同じ時間帯（今日と同じ経過時点）にも記録を置く
      generateSamples(db, {
        start: todayStart - 24 * 3600000,
        end: todayEnd - 24 * 3600000,
        stepSeconds: 60,
        apps: [{ name: 'chrome.exe', share: 0.3 }, { name: 'steam.exe', share: 0.2 }],
        seed: 999,
      });
      break;
    case 'week':
      generateSamples(db, {
        start: day0 - 6 * DAY_MS,
        end: now,
        stepSeconds: 300,
        rollupAfter: day0 - 2 * DAY_MS,
        gaps: [[day0 - 4 * DAY_MS + 2 * 3600000, day0 - 4 * DAY_MS + 5 * 3600000]],
        apps: [{ name: 'chrome.exe', share: 0.3 }, { name: 'code.exe', share: 0.15 }, { name: 'steam.exe', share: 0.25 }],
      });
      break;
    case 'days30':
      generateSamples(db, { start: day0 - 29 * DAY_MS, end: now, stepSeconds: 900, rollupAfter: day0 - 2 * DAY_MS, apps: [{ name: 'chrome.exe', share: 0.3 }, { name: 'code.exe', share: 0.2 }] });
      break;
    case 'days400':
      generateSamples(db, { start: day0 - 400 * DAY_MS, end: now, stepSeconds: 1800, rollupAfter: day0 - 1 * DAY_MS, apps: [{ name: 'chrome.exe', share: 0.35 }, { name: 'msedge.exe', share: 0.15 }] });
      break;
    case 'gaps':
      generateSamples(db, {
        start: yesterdayAt(0),
        end: yesterdayAt(12),
        stepSeconds: 60,
        gaps: [
          [yesterdayAt(3), yesterdayAt(7)],
          [yesterdayAt(9), yesterdayAt(9) + 30 * 60000],
        ],
      });
      break;
    case 'longnames':
      // 長いアプリ名・長いドライブ名でもレイアウトが崩れないことを確認するためのデータ
      generateSamples(db, {
        start: todayStart,
        end: todayEnd,
        stepSeconds: 60,
        apps: [
          { name: 'very-long-application-name-with-many-words-and-version-1.2.3-beta+metadata_x64_2026-09-14.exe', share: 0.4 },
          { name: 'Microsoft.Windows.SystemHost.SomeVeryLongPackageName_8wekyb3d8bbwe!App', share: 0.2 },
          { name: '短い名前.exe', share: 0.1 },
        ],
      });
      break;
    case 'overlap': {
      // 秒データと1時間ロールアップが同じ時間帯に併存する人工DB。
      //  01時: 完全重複（秒100W×3600 + 時間平均100W）
      //  02時: 部分重複（秒60W×1800 + 時間平均50W）
      //  03時: ロールアップのみ（瞬間最大は復元できない）
      //  04時: 同一起動内で負荷が変化（時間加重平均の確認用）
      // 実行時刻に関係なく過去の時間帯を使う（未来の時刻は「まだ記録がない」扱いになるため）
      const base = day0 - 24 * 3600000;
      const at = (hours) => base + hours * 3600000;
      for (let index = 0; index < 3600; index += 1) {
        insertSample(db, { ts: at(1) + index * 1000, watts: 100, periodSeconds: 1, apps: [{ name: 'game.exe', watts: 40 }] });
      }
      insertSample(db, { ts: at(1), watts: 100, periodSeconds: 3600, rollup: true, apps: [{ name: 'game.exe', watts: 40 }] });
      for (let index = 0; index < 1800; index += 1) {
        insertSample(db, { ts: at(2) + index * 1000, watts: 60, periodSeconds: 1 });
      }
      insertSample(db, { ts: at(2), watts: 50, periodSeconds: 3600, rollup: true });
      insertSample(db, { ts: at(3), watts: 40, periodSeconds: 3600, rollup: true });
      for (let index = 0; index < 1800; index += 1) {
        insertSample(db, { ts: at(4) + index * 1000, watts: 60, periodSeconds: 1 });
      }
      for (let index = 0; index < 900; index += 1) {
        insertSample(db, { ts: at(4) + 1800000 + index * 1000, watts: 120, periodSeconds: 1 });
      }
      break;
    }
    case 'rolluponly': {
      // 1時間平均しかないDB（瞬間最大・セッションを作れないことの確認用）
      const base = day0 - 24 * 3600000;
      for (let hour = 1; hour <= 3; hour += 1) {
        insertSample(db, { ts: base + hour * 3600000, watts: 50 + hour * 10, periodSeconds: 3600, rollup: true });
      }
      break;
    }
    case 'boundary': {
      // 月末・月初・年末・年始をまたぐサンプル
      const monthStart = new Date(Number(now));
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const from = monthStart.getTime() - 6 * 3600000;
      generateSamples(db, { start: from, end: from + 12 * 3600000, stepSeconds: 60 });
      const yearStart = new Date(new Date(Number(now)).getFullYear(), 0, 1).getTime();
      generateSamples(db, { start: yearStart - 3 * 3600000, end: yearStart + 3 * 3600000, stepSeconds: 60 });
      break;
    }
    default:
      generateSamples(db, { start: todayStart, end: todayEnd, stepSeconds: 60, legacy });
      break;
  }
  db.exec('COMMIT');
  db.close();
  writeConfig(configPath, options.config || {});
  return { dbPath, configPath, dir, scenario };
}

module.exports = {
  DAY_MS,
  LEGACY_SCHEMA,
  MODERN_SCHEMA,
  createFixture,
  createRandom,
  generateSamples,
  insertSample,
  writeConfig,
};
