'use strict';

// 電力履歴の集計。ここでは「0」と「記録なし」を区別し、
// 期間の欠損・粒度（1秒記録/1時間ロールアップ）・比較の可否を必ず持ち回る。

const {
  COMPONENT_TABLES,
  UJ_PER_KWH,
  aggregatedExpression,
  energyExpression,
  hasTable,
  hasTimestampTable,
  periodSecondsExpression,
  powerColumn,
  tableColumns,
  wattsExpression,
} = require('./db');
const {
  DAY_MS,
  HOUR_MS,
  bucketEndFor,
  bucketKeyFor,
  bucketStartFor,
  enumerateBuckets,
  formatDateInput,
} = require('./time');

// 設定値による補正。生のWattSeal値（内部センサー）に倍率と校正係数を掛け、
// 基板・モニターなど取得できない分を固定Wとして加える。
function applyAdjustments(rawKwh, activeSeconds, config) {
  const raw = Number(rawKwh || 0);
  const seconds = Number(activeSeconds || 0);
  const scale = Number(config.sensorFactor || 1) * Number(config.wallCalibration || 1);
  const fixedWatts = Number(config.baseWatts || 0) + Number(config.monitorWatts || 0);
  const sensorKwh = raw * scale;
  const fixedKwh = fixedWatts * seconds / 3_600_000;
  const adjustedKwh = sensorKwh + fixedKwh;
  return {
    rawKwh: raw,
    sensorKwh,
    fixedKwh,
    adjustedKwh,
    cost: adjustedKwh * Number(config.electricityRate || 0),
    activeSeconds: seconds,
    averageWatts: seconds > 0 ? adjustedKwh * 3_600_000 / seconds : 0,
  };
}

function adjustedWatts(rawWatts, config) {
  const scale = Number(config.sensorFactor || 1) * Number(config.wallCalibration || 1);
  return Number(rawWatts || 0) * scale + Number(config.baseWatts || 0) + Number(config.monitorWatts || 0);
}

function groupExpression(granularity, bucketSeconds) {
  const sizeMs = Math.max(1, Number(bucketSeconds || 3600)) * 1000;
  if (granularity === 'month') return "strftime('%Y-%m', t.timestamp / 1000, 'unixepoch', 'localtime')";
  if (granularity === 'day') return "strftime('%Y-%m-%d', t.timestamp / 1000, 'unixepoch', 'localtime')";
  return `CAST(t.timestamp / ${sizeMs} AS INTEGER)`;
}

// 同じ1時間に「1秒記録」と「1時間平均（ロールアップ）」が併存する場合の採用規則。
//   → その時間は 1秒記録だけを採用し、1時間平均の行は使わない（二重計上を避ける）
// WattSealは通常ロールアップ後に1秒行を消すため併存しないが、DBの状態によっては
// 併存し得るので、集計側で必ず排除する。
// 判定は total_data.period_type（旧形式では1サンプルの秒数）で行い、
// 時間帯のキーは timestamp から求める。
function hourlyRollupFlag(db, dataAlias) {
  return aggregatedExpression(db, dataAlias, 't');
}

function dedupCondition(db, options = {}) {
  const dataAlias = options.dataAlias || 'd';
  const flag = hourlyRollupFlag(db, dataAlias);
  return `AND NOT ((${flag}) = 1 AND CAST(t.timestamp / 3600000 AS INTEGER) IN (
      SELECT CAST(t2.timestamp / 3600000 AS INTEGER)
        FROM timestamp t2 JOIN total_data d2 ON d2.timestamp_id = t2.id
       WHERE t2.timestamp >= ? AND t2.timestamp <= ?
         AND NOT (${aggregatedExpression(db, 'd2', 't2')})
    ))`;
}

// 実際に重複していた時間帯の数（画面の注記用）
function overlappingHours(db, bounds) {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT CAST(t.timestamp / 3600000 AS INTEGER) AS hour_key
          FROM timestamp t JOIN total_data d ON d.timestamp_id = t.id
         WHERE t.timestamp >= ? AND t.timestamp <= ?
         GROUP BY hour_key
        HAVING SUM(CASE WHEN (${aggregatedExpression(db, 'd', 't')}) = 1 THEN 1 ELSE 0 END) > 0
           AND SUM(CASE WHEN (${aggregatedExpression(db, 'd', 't')}) = 0 THEN 1 ELSE 0 END) > 0
      )`).get(bounds.start, bounds.end);
    return Number(row?.count || 0);
  } catch (_) {
    return 0;
  }
}

function bucketStartFromGroupKey(key, granularity, bucketSeconds) {
  if (granularity === 'month') {
    const [year, month] = String(key).split('-').map(Number);
    return new Date(year, (month || 1) - 1, 1).getTime();
  }
  if (granularity === 'day') {
    const [year, month, day] = String(key).split('-').map(Number);
    return new Date(year, (month || 1) - 1, day || 1).getTime();
  }
  return Number(key) * Math.max(1, Number(bucketSeconds || 3600)) * 1000;
}

function readGroupedRows(db, bounds, granularity, bucketSeconds) {
  const watts = wattsExpression(db, 'total_data');
  const energy = energyExpression(db, 'total_data');
  if (!watts || !energy) return [];
  const seconds = periodSecondsExpression(db, 't');
  const aggregated = aggregatedExpression(db, 'd', 't');
  const group = groupExpression(granularity, bucketSeconds);
  const sql = `
    SELECT ${group} AS group_key,
           COUNT(*) AS samples,
           SUM(CASE WHEN ${watts} IS NULL THEN 1 ELSE 0 END) AS null_samples,
           SUM(CASE WHEN ${watts} = 0 THEN 1 ELSE 0 END) AS zero_samples,
           COALESCE(SUM(${energy}), 0) AS energy_uj,
           COALESCE(SUM(${seconds}), 0) AS active_seconds,
           SUM(${aggregated}) AS rollup_rows,
           MIN(${watts}) AS min_watts,
           MAX(${watts}) AS max_watts,
           MIN(t.timestamp) AS first_ts,
           MAX(t.timestamp) AS last_ts
      FROM timestamp t
      JOIN total_data d ON d.timestamp_id = t.id
     WHERE t.timestamp >= ? AND t.timestamp <= ?
       ${dedupCondition(db)}
     GROUP BY group_key
     ORDER BY group_key`;
  return db.prepare(sql).all(bounds.start, bounds.end, bounds.start, bounds.end);
}

// 期間内のバケットを欠損込みで生成する（欠損は 0 ではなく missing として扱う）。
function buildBuckets(db, bounds, granularity, bucketSeconds, config, options = {}) {
  const maxBuckets = options.maxBuckets || 1600;
  const expected = enumerateBuckets(bounds.start, bounds.end, granularity, bucketSeconds, maxBuckets);
  const rows = readGroupedRows(db, bounds, granularity, bucketSeconds);
  const byKey = new Map(rows.map((row) => [String(row.group_key), row]));
  const now = Date.now();
  const buckets = [];
  let truncated = false;
  const sizeMs = Math.max(1, Number(bucketSeconds || 3600)) * 1000;
  const usesIndexKey = granularity === 'minute' || granularity === 'hour';
  for (const slot of expected) {
    if (buckets.length >= maxBuckets) { truncated = true; break; }
    const key = bucketKeyFor(slot.start, granularity);
    // 分・時間はエポックからの整数インデックス、日・月はローカル日付キーで突き合わせる
    const row = byKey.get(String(usesIndexKey ? slot.start / sizeMs : key));
    const slotEnd = Math.min(bucketEndFor(slot.start, granularity, bucketSeconds), bounds.end, now);
    const expectedSeconds = Math.max(0, (slotEnd - slot.clippedStart) / 1000);
    if (!row) {
      buckets.push(emptyBucket(slot.start, granularity, expectedSeconds));
      continue;
    }
    const samples = Number(row.samples || 0);
    const nullSamples = Number(row.null_samples || 0);
    const zeroSamples = Number(row.zero_samples || 0);
    const activeSeconds = Number(row.active_seconds || 0);
    const rollupRows = Number(row.rollup_rows || 0);
    const coveragePercent = expectedSeconds > 0 ? Math.min(100, activeSeconds / expectedSeconds * 100) : 0;
    const totals = applyAdjustments(Number(row.energy_uj || 0) / UJ_PER_KWH, activeSeconds, config);
    // 1時間平均しかない区間は、瞬間の最大・最小が分からないため null（創作しない）
    const aggregatedOnly = rollupRows > 0 && rollupRows === samples;
    const maxWatts = (row.max_watts == null || aggregatedOnly) ? null : adjustedWatts(Number(row.max_watts), config);
    const minWatts = (row.min_watts == null || aggregatedOnly) ? null : adjustedWatts(Number(row.min_watts), config);
    const readable = samples - nullSamples;
    let quality = 'complete';
    if (readable <= 0) quality = 'missing';
    else if (coveragePercent < 85) quality = 'partial';
    else if (rollupRows > 0) quality = 'rollup';
    else if (Number(row.max_watts) === 0 && zeroSamples === readable) quality = 'zero';
    if (readable <= 0) {
      buckets.push({
        ...emptyBucket(slot.start, granularity, expectedSeconds),
        samples,
        nullSamples,
        activeSeconds,
        coveragePercent,
      });
      continue;
    }
    buckets.push({
      bucket: key,
      timestamp: slot.start,
      end: slotEnd,
      granularity,
      expectedSeconds,
      activeSeconds,
      coveragePercent: Number(coveragePercent.toFixed(1)),
      samples,
      readableSamples: readable,
      nullSamples,
      zeroSamples,
      rollup: rollupRows > 0,
      rollupRows,
      missing: false,
      quality,
      estimated: true,
      rawKwh: totals.rawKwh,
      kwh: totals.adjustedKwh,
      cost: totals.cost,
      averageWatts: totals.averageWatts,
      maxWatts,
      minWatts,
      firstSampleAt: Number(row.first_ts || slot.start),
      lastSampleAt: Number(row.last_ts || slot.start),
    });
  }
  return { buckets, truncated };
}

function emptyBucket(timestamp, granularity, expectedSeconds) {
  return {
    bucket: bucketKeyFor(timestamp, granularity),
    timestamp,
    end: bucketEndFor(timestamp, granularity, granularity === 'day' ? 86400 : granularity === 'hour' ? 3600 : 60),
    granularity,
    expectedSeconds,
    activeSeconds: 0,
    coveragePercent: 0,
    samples: 0,
    readableSamples: 0,
    nullSamples: 0,
    zeroSamples: 0,
    rollup: false,
    rollupRows: 0,
    missing: true,
    quality: 'missing',
    estimated: true,
    rawKwh: null,
    kwh: null,
    cost: null,
    averageWatts: null,
    maxWatts: null,
    minWatts: null,
    firstSampleAt: null,
    lastSampleAt: null,
  };
}

function summarizeBuckets(buckets, bounds, granularity) {
  let kwh = 0;
  let cost = 0;
  let activeSeconds = 0;
  let expectedSeconds = 0;
  let samples = 0;
  let readableSamples = 0;
  let zeroSamples = 0;
  let missingBuckets = 0;
  let partialBuckets = 0;
  let rollupBuckets = 0;
  let maxWatts = null;
  let minWatts = null;
  let bucketsWithoutMax = 0;
  let peakCostBucket = null;
  let peakWattsBucket = null;
  for (const bucket of buckets) {
    expectedSeconds += bucket.expectedSeconds;
    samples += bucket.samples;
    readableSamples += bucket.readableSamples;
    zeroSamples += bucket.zeroSamples;
    if (bucket.missing) { missingBuckets += 1; continue; }
    kwh += Number(bucket.kwh || 0);
    cost += Number(bucket.cost || 0);
    activeSeconds += Number(bucket.activeSeconds || 0);
    if (bucket.quality === 'partial') partialBuckets += 1;
    if (bucket.rollup) rollupBuckets += 1;
    if (bucket.maxWatts != null && (maxWatts === null || bucket.maxWatts > maxWatts)) maxWatts = bucket.maxWatts;
    if (bucket.minWatts != null && (minWatts === null || bucket.minWatts < minWatts)) minWatts = bucket.minWatts;
    if (bucket.maxWatts == null) bucketsWithoutMax += 1;
    if (!peakCostBucket || Number(bucket.cost) > Number(peakCostBucket.cost)) peakCostBucket = bucket;
    if (bucket.maxWatts != null && (!peakWattsBucket || bucket.maxWatts > peakWattsBucket.maxWatts)) peakWattsBucket = bucket;
  }
  const missingSeconds = Math.max(0, expectedSeconds - activeSeconds);
  const coveragePercent = expectedSeconds > 0 ? Math.min(100, activeSeconds / expectedSeconds * 100) : 0;
  const resolution = rollupBuckets > 0
    ? (rollupBuckets === buckets.length - missingBuckets ? 'hour' : 'mixed')
    : 'second';
  return {
    start: bounds.start,
    end: bounds.end,
    activeSeconds,
    expectedSeconds,
    missingSeconds,
    coveragePercent: Number(coveragePercent.toFixed(1)),
    kwh,
    cost,
    averageWatts: activeSeconds > 0 ? kwh * 3_600_000 / activeSeconds : 0,
    maxWatts,
    minWatts,
    // 1時間平均しかない区間が混ざる場合、最大Wは「1秒記録がある区間だけ」の値になる
    maxWattsPartial: bucketsWithoutMax > 0 && maxWatts != null,
    bucketsWithoutMax,
    samples,
    readableSamples,
    zeroSamples,
    bucketCount: buckets.length,
    missingBuckets,
    partialBuckets,
    rollupBuckets,
    granularity,
    resolution,
    estimated: true,
    activeSecondsEstimated: rollupBuckets > 0,
    isPartial: coveragePercent < 95,
    peakCostBucket: peakCostBucket && !peakCostBucket.missing ? peakCostBucket : null,
    peakWattsBucket: peakWattsBucket && !peakWattsBucket.missing ? peakWattsBucket : null,
  };
}

function periodTotals(db, bounds, granularity, bucketSeconds, config) {
  if (!hasTimestampTable(db) || !hasTable(db, 'total_data')) {
    return {
      totals: summarizeBuckets([], bounds, granularity),
      buckets: [],
      truncated: false,
    };
  }
  const { buckets, truncated } = buildBuckets(db, bounds, granularity, bucketSeconds, config);
  const totals = summarizeBuckets(buckets, bounds, granularity);
  // 同じ時間帯に秒データと1時間平均が併存していた場合は、秒データを採用したことを伝える
  totals.deduplicatedHours = overlappingHours(db, bounds);
  return { totals, buckets, truncated };
}

// 期間の比較。データ不足・長さの違い・0除算を明示的に扱い、誤った増減率を出さない。
function compareTotals(current, previous, options = {}) {
  const label = options.label || '直前期間';
  const minCoverage = Number(options.minCoverage || 80);
  if (!previous) {
    return {
      status: 'no-previous-period',
      comparable: false,
      label,
      reason: 'この表示では比較しません。',
    };
  }
  const previousSeconds = Number(previous.totals?.activeSeconds || 0);
  const previousCoverage = Number(previous.totals?.coveragePercent || 0);
  const currentCoverage = Number(current.coveragePercent || 0);
  if (previousSeconds <= 0 || previous.totals?.readableSamples === 0) {
    return {
      status: 'no-previous-data',
      comparable: false,
      label,
      reason: `${label}の記録がありません。`,
      previous: previous.totals || null,
    };
  }
  if (previousCoverage < minCoverage) {
    return {
      status: 'insufficient-data',
      comparable: false,
      label,
      reason: `${label}は記録が${Math.round(previousCoverage)}%しかないため比較しません。`,
      previous: previous.totals,
      previousCoveragePercent: Number(previousCoverage.toFixed(1)),
    };
  }
  if (currentCoverage < minCoverage) {
    return {
      status: 'insufficient-current-data',
      comparable: false,
      label,
      reason: `表示中の期間は記録が${Math.round(currentCoverage)}%しかないため比較しません。`,
      previous: previous.totals,
      currentCoveragePercent: Number(currentCoverage.toFixed(1)),
    };
  }
  const previousCost = Number(previous.totals.cost || 0);
  const previousKwh = Number(previous.totals.kwh || 0);
  const lengthMismatch = Boolean(options.lengthMismatch)
    || (previous.bounds && Math.abs((previous.bounds.end - previous.bounds.start) - (current.end - current.start)) > Math.max(60000, (current.end - current.start) * 0.02));
  if (previousCost <= 0 && previousKwh <= 0) {
    return {
      status: 'previous-zero',
      comparable: false,
      label,
      reason: `${label}は消費が0のため増減率を出しません。`,
      previous: previous.totals,
      previousCost,
      previousKwh,
    };
  }
  const diffCost = current.cost - previousCost;
  const diffKwh = current.kwh - previousKwh;
  return {
    status: 'ok',
    comparable: true,
    label,
    simple: Boolean(lengthMismatch),
    note: lengthMismatch ? '期間の長さが完全には同じではないため単純比較です。' : null,
    previous: previous.totals,
    previousBounds: previous.bounds || null,
    currentCost: current.cost,
    previousCost,
    diffCost,
    percentCost: previousCost > 0 ? diffCost / previousCost * 100 : null,
    currentKwh: current.kwh,
    previousKwh,
    diffKwh,
    percentKwh: previousKwh > 0 ? diffKwh / previousKwh * 100 : null,
    currentActiveSeconds: current.activeSeconds,
    previousActiveSeconds: previousSeconds,
    percentActiveSeconds: previousSeconds > 0 ? (current.activeSeconds - previousSeconds) / previousSeconds * 100 : null,
  };
}

// カテゴリ分けの既定ルール（設定で上書きできる）
const CATEGORY_RULES = Object.freeze([
  { key: 'browser', keywords: ['chrome', 'msedge', 'edge', 'firefox', 'brave', 'opera', 'vivaldi', 'iexplore'] },
  { key: 'video', keywords: ['youtube', 'vlc', 'mpv', 'netflix', 'spotify', 'musicbee', 'foobar', 'obs', 'spotifywebhelper'] },
  { key: 'dev', keywords: ['code', 'codex', 'devenv', 'node', 'python', 'python3', 'git', 'docker', 'wsl', 'pwsh', 'powershell', 'terminal', 'windowsterminal', 'unity', 'godot', 'rider', 'webstorm', 'pycharm', 'androidstudio', 'xcode', 'claude'] },
  { key: 'work', keywords: ['excel', 'winword', 'powerpnt', 'outlook', 'onenote', 'acrobat', 'photoshop', 'illustrator', 'premiere', 'afterfx', 'blender', 'reaper', 'audacity', 'studio one', 'ltspice', 'apx', 'fusion360'] },
  { key: 'file', keywords: ['7z', 'winrar', 'winzip', 'explorer', 'robocopy', 'teracopy', 'everything', 'defrag'] },
  { key: 'communication', keywords: ['discord', 'teams', 'slack', 'zoom', 'line', 'skype', 'telegram', 'phoneexperiencehost'] },
  { key: 'system', keywords: ['system', 'svchost', 'dwm', 'searchhost', 'startmenuexperience', 'shellexperience', 'runtimebroker', 'audiodg', 'defender', 'msmpeng', 'antimalware', 'nvidia', 'wattseal', 'registry', 'lsass', 'csrss', 'wininit', 'services', 'taskhostw', 'ctfmon', 'sihost', 'fontdrvhost', 'nvdisplay'] },
]);

function categoryFor(name, config) {
  const normalized = String(name || '').toLowerCase();
  const mapped = config.appCategoryMap?.[normalized];
  if (mapped) return { key: mapped, source: 'manual' };
  if ((config.gameKeywords || []).some((keyword) => keyword && normalized.includes(keyword))) {
    return { key: 'game', source: 'keyword' };
  }
  const matched = CATEGORY_RULES.find((rule) => rule.keywords.some((keyword) => normalized.includes(keyword)));
  return matched ? { key: matched.key, source: 'auto' } : { key: 'other', source: 'auto' };
}

// アプリ別の記録はWattSeal側で古い分が整理されるため、実際に記録がある範囲と
// 行数に応じて「一部の記録から推定した配分」であることを明示して返す。
function processWindow(db, bounds, options = {}) {
  const maxRows = Number(options.maxRows || 120000);
  const maxDays = Number(options.maxDays || 30);
  const empty = { bounds, rows: 0, scannedRows: 0, step: 1, limited: false, sampled: false, first: null, last: null, note: null };
  try {
    const start = Math.max(bounds.start, Date.now() - maxDays * DAY_MS);
    const row = db.prepare(`
      SELECT MIN(t.timestamp) AS first, MAX(t.timestamp) AS last, COUNT(*) AS rows
        FROM process_data p JOIN timestamp t ON t.id = p.timestamp_id
       WHERE t.timestamp >= ? AND t.timestamp <= ?`).get(start, bounds.end);
    const rows = Number(row?.rows || 0);
    if (!rows) return { ...empty, bounds: { start, end: bounds.end } };
    const step = Math.max(1, Math.ceil(rows / maxRows));
    const notes = [];
    if (step > 1) notes.push(`記録が多いため${step}件に1件の割合で計算した推定配分です。`);
    if (start > bounds.start) notes.push(`アプリ別の記録は直近${maxDays}日分だけを集計しています。`);
    return {
      bounds: { start, end: bounds.end },
      rows,
      scannedRows: Math.ceil(rows / step),
      step,
      limited: start > bounds.start,
      sampled: step > 1,
      first: row.first ?? null,
      last: row.last ?? null,
      note: notes.length ? notes.join('') : null,
    };
  } catch (_) {
    return empty;
  }
}

function processSampleFilter(alias, step) {
  return step > 1 ? `AND (${alias}.timestamp_id % ${step}) = 0` : '';
}

function applicationUsage(db, bounds, config, options = {}) {
  if (!hasTable(db, 'process_data')) return { apps: [], window: { limited: false, rows: 0, step: 1 }, totalWattSeconds: 0 };
  const watts = wattsExpression(db, 'process_data', 'p');
  if (!watts) return { apps: [], window: { limited: false, rows: 0, step: 1 }, totalWattSeconds: 0 };
  const window = processWindow(db, bounds, options);
  if (!window.rows) return { apps: [], window, totalWattSeconds: 0 };
  const seconds = periodSecondsExpression(db, 't');
  const rows = db.prepare(`
    SELECT p.app_name AS name,
           COALESCE(SUM(${watts} * ${seconds}), 0) AS watt_seconds,
           COUNT(*) AS samples
      FROM timestamp t
      JOIN process_data p ON p.timestamp_id = t.id
      LEFT JOIN total_data td ON td.timestamp_id = t.id
     WHERE t.timestamp >= ? AND t.timestamp <= ?
       ${processSampleFilter('p', window.step)}
       ${dedupCondition(db, { dataAlias: 'td' })}
     GROUP BY p.app_name
     ORDER BY watt_seconds DESC
     LIMIT 200`).all(window.bounds.start, window.bounds.end, window.bounds.start, window.bounds.end);
  const totalWattSeconds = rows.reduce((sum, row) => sum + Number(row.watt_seconds || 0), 0);
  const apps = rows.map((row) => {
    const share = totalWattSeconds > 0 ? Number(row.watt_seconds || 0) / totalWattSeconds : 0;
    const category = categoryFor(row.name, config);
    return {
      name: String(row.name || '不明'),
      share: share * 100,
      samples: Number(row.samples || 0),
      category: category.key,
      categorySource: category.source,
      estimated: true,
    };
  });
  return { apps, window, totalWattSeconds };
}

function applicationBreakdown(db, bounds, config, periodTotalsValue) {
  const usage = applicationUsage(db, bounds, config);
  const apps = usage.apps.map((app) => ({
    ...app,
    kwh: Number(periodTotalsValue.kwh || 0) * app.share / 100,
    cost: Number(periodTotalsValue.cost || 0) * app.share / 100,
  }));
  const categories = new Map();
  for (const app of apps) {
    const current = categories.get(app.category) || { key: app.category, share: 0, apps: 0, kwh: 0, cost: 0 };
    current.share += app.share;
    current.apps += 1;
    current.kwh += app.kwh;
    current.cost += app.cost;
    categories.set(app.category, current);
  }
  return {
    apps,
    categories: [...categories.values()].sort((a, b) => b.share - a.share),
    window: usage.window,
    coverage: { first: usage.window.first, last: usage.window.last, rows: usage.window.rows, step: usage.window.step },
    note: [
      'アプリ別の値は、PC全体の電力とアプリの使用状況から求めた推定配分です。実際にアプリ単体を測った値ではありません。',
      usage.window.note || '',
    ].filter(Boolean).join(''),
  };
}

function componentBreakdown(db, bounds, config, periodTotalsValue) {
  const components = [];
  let measuredSeconds = 0;
  for (const [table, label, key] of COMPONENT_TABLES) {
    if (!hasTable(db, table)) continue;
    const watts = wattsExpression(db, table);
    if (!watts) continue;
    const seconds = periodSecondsExpression(db, 't');
    const row = db.prepare(`
      SELECT COALESCE(SUM(${watts} * ${seconds}), 0) AS watt_seconds,
             COUNT(*) AS samples
        FROM timestamp t JOIN ${table} d ON d.timestamp_id = t.id
        LEFT JOIN total_data td ON td.timestamp_id = t.id
       WHERE t.timestamp >= ? AND t.timestamp <= ?
         ${dedupCondition(db, { dataAlias: 'td' })}`).get(bounds.start, bounds.end, bounds.start, bounds.end);
    const wattSeconds = Number(row?.watt_seconds || 0);
    measuredSeconds = Math.max(measuredSeconds, Number(periodTotalsValue.activeSeconds || 0));
    components.push({
      key,
      label,
      samples: Number(row?.samples || 0),
      kwh: wattSeconds / 3_600_000 * Number(config.sensorFactor || 1) * Number(config.wallCalibration || 1),
      estimated: key === 'ram' || key === 'disk' || key === 'network',
    });
  }
  const scale = Number(config.sensorFactor || 1) * Number(config.wallCalibration || 1);
  const measuredKwh = components.reduce((sum, item) => sum + item.kwh, 0);
  const monitorKwh = Number(config.monitorWatts || 0) * Number(periodTotalsValue.activeSeconds || 0) / 3_600_000;
  const baseKwh = Number(config.baseWatts || 0) * Number(periodTotalsValue.activeSeconds || 0) / 3_600_000;
  const overhead = Math.max(0, Number(periodTotalsValue.kwh || 0) - measuredKwh - monitorKwh - baseKwh);
  if (baseKwh > 0) components.push({ key: 'base', label: 'マザーボード・ファン等（設定値）', kwh: baseKwh, samples: 0, estimated: true });
  if (overhead > 0.0001) components.push({ key: 'overhead', label: '電源損失など（差分）', kwh: overhead, samples: 0, estimated: true });
  if (monitorKwh > 0) components.push({ key: 'monitor', label: 'モニター（設定値）', kwh: monitorKwh, samples: 0, estimated: true });
  const sum = components.reduce((acc, item) => acc + item.kwh, 0);
  return {
    items: components
      .map((item) => ({
        ...item,
        percent: sum > 0 ? item.kwh / sum * 100 : 0,
        cost: item.kwh * Number(config.electricityRate || 0),
      }))
      .filter((item) => item.kwh > 0 || item.key === 'cpu')
      .sort((a, b) => b.kwh - a.kwh),
    note: 'CPU・GPUは内部センサー、メモリ・ストレージ・ネットワークは推定、基板・電源損失は差分と設定値です。',
    measuredSeconds,
  };
}

function currentReading(db, config) {
  if (!hasTimestampTable(db) || !hasTable(db, 'total_data')) {
    return { watts: null, rawWatts: null, timestamp: null, ageSeconds: null, stale: true, reason: 'no-data' };
  }
  const watts = wattsExpression(db, 'total_data');
  if (!watts) return { watts: null, rawWatts: null, timestamp: null, ageSeconds: null, stale: true, reason: 'no-data' };
  const aggregated = aggregatedExpression(db, 'd', 't');
  const row = db.prepare(`
    SELECT t.timestamp AS timestamp,
           ${periodSecondsExpression(db, 't')} AS period_seconds,
           ${aggregated} AS aggregated,
           ${watts} AS raw_watts
      FROM timestamp t JOIN total_data d ON d.timestamp_id = t.id
     ORDER BY t.timestamp DESC LIMIT 1`).get();
  if (!row || row.raw_watts == null) {
    return { watts: null, rawWatts: null, timestamp: row ? Number(row.timestamp) : null, ageSeconds: null, stale: true, reason: 'no-sample' };
  }
  const timestamp = Number(row.timestamp);
  const ageSeconds = Math.max(0, (Date.now() - timestamp) / 1000);
  const periodSeconds = Number(row.period_seconds || 1);
  const aggregatedRow = Number(row.aggregated) === 1;
  const stale = ageSeconds > 15 || aggregatedRow;
  return {
    rawWatts: Number(row.raw_watts),
    watts: adjustedWatts(Number(row.raw_watts), config),
    timestamp,
    ageSeconds,
    periodSeconds,
    resolution: aggregatedRow ? 'hour' : 'second',
    stale,
    reason: aggregatedRow ? 'hourly-rollup' : ageSeconds > 15 ? 'old' : 'fresh',
    estimated: true,
  };
}

function gapsInRange(db, bounds, minimumMs = 5 * 60000) {
  if (!hasTimestampTable(db)) return [];
  const rows = db.prepare('SELECT timestamp FROM timestamp WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp').all(bounds.start, bounds.end);
  const gaps = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = Number(rows[index - 1].timestamp);
    const current = Number(rows[index].timestamp);
    if (current - previous >= minimumMs) {
      gaps.push({ start: previous, end: current, seconds: (current - previous) / 1000 });
    }
  }
  return gaps.sort((a, b) => b.seconds - a.seconds).slice(0, 12);
}

// 日×時間のヒートマップ（平均W）。長期でも軽く動くよう SQL 側で集計する。
function dailyHeatmap(db, bounds, config) {
  if (!hasTimestampTable(db) || !hasTable(db, 'total_data')) return { cells: [], maxWatts: 0 };
  const watts = wattsExpression(db, 'total_data');
  if (!watts) return { cells: [], maxWatts: 0 };
  const rows = db.prepare(`
    SELECT CAST(strftime('%w', d.stamp / 1000, 'unixepoch', 'localtime') AS INTEGER) AS weekday,
           CAST(strftime('%H', d.stamp / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
           AVG(d.value) AS watts,
           COUNT(*) AS samples
      FROM (SELECT t.timestamp AS stamp, (${watts}) AS value
              FROM timestamp t JOIN total_data d ON d.timestamp_id = t.id
             WHERE t.timestamp >= ? AND t.timestamp <= ?
               ${dedupCondition(db)}) d
     GROUP BY weekday, hour`).all(bounds.start, bounds.end, bounds.start, bounds.end);
  const scale = Number(config.sensorFactor || 1) * Number(config.wallCalibration || 1);
  const fixed = Number(config.baseWatts || 0) + Number(config.monitorWatts || 0);
  const cells = rows.map((row) => ({
    weekday: Number(row.weekday || 0),
    hour: Number(row.hour || 0),
    watts: Number(row.watts || 0) * scale + fixed,
    samples: Number(row.samples || 0),
  }));
  return { cells, maxWatts: cells.reduce((max, cell) => Math.max(max, cell.watts), 0) };
}

// 0〜23時の平均的な使い方
function hourlyProfile(db, bounds, config) {
  if (!hasTimestampTable(db) || !hasTable(db, 'total_data')) return [];
  const watts = wattsExpression(db, 'total_data');
  if (!watts) return [];
  const rows = db.prepare(`
    SELECT CAST(strftime('%H', t.timestamp / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
           AVG(${watts}) AS watts,
           MAX(${watts}) AS max_watts,
           COUNT(*) AS samples
      FROM timestamp t JOIN total_data d ON d.timestamp_id = t.id
     WHERE t.timestamp >= ? AND t.timestamp <= ?
       ${dedupCondition(db)}
     GROUP BY hour ORDER BY hour`).all(bounds.start, bounds.end, bounds.start, bounds.end);
  const scale = Number(config.sensorFactor || 1) * Number(config.wallCalibration || 1);
  const fixed = Number(config.baseWatts || 0) + Number(config.monitorWatts || 0);
  const byHour = new Map(rows.map((row) => [Number(row.hour), row]));
  return Array.from({ length: 24 }, (_, hour) => {
    const row = byHour.get(hour);
    return {
      hour,
      watts: row ? Number(row.watts || 0) * scale + fixed : null,
      maxWatts: row && row.max_watts != null ? Number(row.max_watts) * scale + fixed : null,
      samples: row ? Number(row.samples) : 0,
      missing: !row,
    };
  });
}

// 急上昇イベント: 周辺より突出した電力を使った時間帯を抽出する
function powerEvents(buckets, options = {}) {
  const usable = buckets.filter((bucket) => !bucket.missing && bucket.maxWatts != null);
  if (usable.length < 3) return [];
  const averages = usable.map((bucket) => Number(bucket.averageWatts || 0)).sort((a, b) => a - b);
  const median = averages[Math.floor(averages.length / 2)] || 0;
  const floor = Math.max(Number(options.floorWatts || 80), median * 1.8);
  return usable
    .filter((bucket) => bucket.maxWatts >= floor && bucket.maxWatts > Number(bucket.averageWatts || 0) * 1.2)
    .map((bucket) => ({
      timestamp: bucket.timestamp,
      granularity: bucket.granularity,
      maxWatts: bucket.maxWatts,
      averageWatts: bucket.averageWatts,
      kwh: bucket.kwh,
      cost: bucket.cost,
    }))
    .sort((a, b) => b.maxWatts - a.maxWatts)
    .slice(0, 8);
}

// 長時間アイドル（電力をほとんど使わずに記録が続いた区間）
function idleRuns(buckets, config, options = {}) {
  const threshold = Number(options.thresholdWatts || Math.max(20, Number(config.baseWatts || 0) + Number(config.monitorWatts || 0) + 15));
  const runs = [];
  let current = null;
  for (const bucket of buckets) {
    const isIdle = !bucket.missing && bucket.averageWatts != null && bucket.averageWatts <= threshold;
    if (!isIdle) {
      if (current && current.seconds >= 2 * 3600) runs.push(current);
      current = null;
      continue;
    }
    if (!current) current = { start: bucket.timestamp, end: bucket.end || bucket.timestamp, seconds: 0, averageWatts: 0, samples: 0 };
    current.end = bucket.end || bucket.timestamp;
    current.seconds = (current.end - current.start) / 1000;
    current.averageWatts = bucket.averageWatts;
    current.samples += 1;
  }
  if (current && current.seconds >= 2 * 3600) runs.push(current);
  return runs.sort((a, b) => b.seconds - a.seconds).slice(0, 6);
}

// 現在の状態分類（アイドル・通常・高負荷）。期間内の平均Wの分布を基準にする。
function classifyState(currentWatts, buckets) {
  const values = buckets.filter((bucket) => !bucket.missing && bucket.averageWatts != null).map((bucket) => Number(bucket.averageWatts)).sort((a, b) => a - b);
  if (currentWatts == null || values.length < 4) {
    return { key: 'unknown', label: '判定できません', thresholds: null };
  }
  const low = values[Math.floor(values.length * 0.34)];
  const high = values[Math.floor(values.length * 0.8)];
  const key = currentWatts <= low ? 'idle' : currentWatts >= high ? 'high' : 'normal';
  return {
    key,
    label: key === 'idle' ? 'アイドル（低負荷）' : key === 'high' ? '高負荷' : '通常使用',
    thresholds: { low: Number(low.toFixed(1)), high: Number(high.toFixed(1)) },
    note: 'この期間の平均電力の分布（下位34%・上位20%）を基準にした目安です。',
  };
}

function weekdayLabel(weekday) {
  return ['日', '月', '火', '水', '木', '金', '土'][Number(weekday) % 7];
}

module.exports = {
  CATEGORY_RULES,
  applyAdjustments,
  adjustedWatts,
  applicationBreakdown,
  applicationUsage,
  buildBuckets,
  categoryFor,
  classifyState,
  compareTotals,
  componentBreakdown,
  currentReading,
  dailyHeatmap,
  formatDateInput,
  gapsInRange,
  hourlyProfile,
  idleRuns,
  periodTotals,
  powerEvents,
  processSampleFilter,
  processWindow,
  summarizeBuckets,
  weekdayLabel,
};
