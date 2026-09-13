'use strict';

// PC Local Dashboard 本体。127.0.0.1 を既定の待ち受けにして、
// 設定した場合だけ同一LANへ公開する（LAN側は読み取り専用）。

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const { createConfigStore, APP_CATEGORIES, DISPLAY_UNITS, RANGE_KEYS } = require('./lib/config');
const { createLogger } = require('./lib/logs');
const { createCache } = require('./lib/cache');
const { createDatabase, hasTable, wattsExpression, aggregatedExpression } = require('./lib/db');
const {
  applicationBreakdown, classifyState, compareTotals, componentBreakdown,
  currentReading, dailyHeatmap, gapsInRange, hourlyProfile, idleRuns, periodTotals, powerEvents,
} = require('./lib/aggregate');
const { recentSessions } = require('./lib/sessions');
const { systemPayload } = require('./lib/system');
const { buildCsv, buildJson, createDatabaseBackup, deleteRange, temporaryBackupPath } = require('./lib/export');
const { DAY_MS, comparisonBounds, formatDateInput, granularityForSpan, localStartOfMonth, safeRange } = require('./lib/time');
const {
  clientKind, collectLocalNetworks, evaluateAccess, normalizeAddress, normalizeNetworkList,
  requestHostname, sameOriginRequest,
} = require('./lib/security');

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DB_PATH = process.env.PC_POWER_DB || path.join(APP_DIR, 'power_monitoring.db');
const CONFIG_PATH = process.env.PC_POWER_CONFIG || path.join(APP_DIR, 'config.json');
const LOG_DIR = process.env.PC_POWER_LOG_DIR || path.join(APP_DIR, 'logs');
const PID_PATH = path.join(APP_DIR, 'dashboard.pid');
const STORAGE_SERVER_PATH = path.join(APP_DIR, 'storage-map', 'server.js');
const STORAGE_RESULT_PATH = path.join(APP_DIR, 'storage-map', 'data', 'last-scan.json');
const WATTSEAL_PATH = path.join(APP_DIR, 'WattSeal.exe');
const PORT = Number(process.env.PC_POWER_PORT || 17891);
const STORAGE_PORT = Number(process.env.PC_STORAGE_PORT || 17892);
const APP_VERSION = '0.12.0';
const IDLE_EXIT_MS = 10 * 60 * 1000;

const configStore = createConfigStore(CONFIG_PATH);
const logger = createLogger({ dir: LOG_DIR, paths: [APP_DIR, DB_PATH, CONFIG_PATH] });
const database = createDatabase({ path: DB_PATH });
// 重い集計は短期キャッシュして、数秒ごとの更新でも軽く保つ
const heavyCache = createCache({ ttlMs: 120000, maxEntries: 24 });
const initialConfig = configStore.load();
const HOST = process.env.PC_POWER_HOST || (initialConfig.lanAccess ? '0.0.0.0' : '127.0.0.1');
const LOCAL_HOST = '127.0.0.1';

const startedAt = Date.now();
let lastActivity = Date.now();
let browserOpened = false;

// ---------------------------------------------------------------- utilities

function httpError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
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

// LAN（スマホ）へ返す内容から、個人情報につながる項目を外す。
//  - DBやログの絶対パス
//  - PC名（hostname）
//  - ドライブのボリューム名（利用者が付けた名前）
function redactForLan(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const clone = structuredClone(payload);
  if (clone.database && typeof clone.database === 'object') {
    if ('path' in clone.database) clone.database.path = null;
    if (clone.database.hardware?.system?.hostname) delete clone.database.hardware.system.hostname;
  }
  if (clone.hardware?.system?.hostname) delete clone.hardware.system.hostname;
  if ('databasePath' in clone) clone.databasePath = null;
  if ('logDirectory' in clone) clone.logDirectory = null;
  if ('rootPath' in clone) clone.rootPath = null;
  for (const key of ['drives', 'physicalDisks']) {
    if (Array.isArray(clone[key])) clone[key] = clone[key].map((drive) => ({ ...drive, label: null }));
  }
  clone.redactedForLan = true;
  return clone;
}

function readBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflowed = false;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        // 送信が大きすぎる場合は、残りを読み捨ててから413を返す（接続は切らずに理由を伝える）
        overflowed = true;
        chunks.length = 0;
        return;
      }
      if (overflowed) return;
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (overflowed) { reject(httpError('送信内容が大きすぎます。', 413)); return; }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
  });
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch (_) {
    throw httpError('送信内容のJSON形式が正しくありません。');
  }
}

function numberParam(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

// ネットワーク構成は頻繁には変わらないため、60秒キャッシュして使う
let localNetworkCache = { at: 0, networks: [], virtualNetworks: [] };

function localNetworks(force = false) {
  if (!force && Date.now() - localNetworkCache.at < 60000) return localNetworkCache;
  let interfaces = {};
  try { interfaces = os.networkInterfaces(); } catch (_) {}
  localNetworkCache = {
    at: Date.now(),
    networks: collectLocalNetworks(interfaces, { includeVirtual: false }),
    virtualNetworks: collectLocalNetworks(interfaces, { includeVirtual: true })
      .filter((network) => network.virtual),
  };
  return localNetworkCache;
}

// 接続元の判定と、LAN公開時の応答内容の調整
function evaluateRequest(req) {
  const address = req.socket?.remoteAddress;
  const config = configStore.load();
  const { networks, virtualNetworks } = localNetworks();
  const extraNetworks = normalizeNetworkList(config.lanAllowedNetworks);
  const access = evaluateAccess(address, networks, extraNetworks);
  return {
    kind: access.kind,
    allowed: access.allowed,
    matched: access.matched,
    address: normalizeAddress(address),
    networks,
    virtualNetworks,
    extraNetworks,
    config,
  };
}

function networkInfoPayload(req) {
  const context = evaluateRequest(req);
  const config = configStore.load();
  const keepAlive = Boolean(config.lanKeepAlive && config.lanAccess);
  const addresses = context.networks.map((network) => ({
    name: network.interfaceName,
    address: network.address,
    url: `http://${network.address}:${PORT}`,
    network: network.cidr,
    virtual: Boolean(network.virtual),
  }));
  return {
    client: context.kind,
    canWrite: context.kind === 'local',
    matchedNetwork: context.matched,
    lanAccess: HOST === '0.0.0.0',
    localUrl: `http://${LOCAL_HOST}:${PORT}`,
    urls: [...new Set(addresses.map((item) => item.url))],
    addresses,
    // スマホから開く候補（同じサブネットのアドレス）
    smartphoneUrls: [...new Set(addresses.map((item) => item.url))],
    allowedNetworks: context.networks.map((network) => `${network.cidr}（${network.interfaceName}）`),
    extraAllowedNetworks: context.extraNetworks.map((network) => network.cidr),
    excludedVirtualNetworks: context.virtualNetworks.map((network) => `${network.cidr}（${network.interfaceName}）`),
    readOnlyForLan: true,
    readOnlyNote: 'LAN側からは設定変更・削除・再起動・DBバックアップを実行できません。',
    keepAlive,
    idleExitMinutes: Math.round(IDLE_EXIT_MS / 60000),
    serverState: {
      startedAt,
      lastActivityAt: lastActivity,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      keepAliveEnabled: keepAlive,
      port: PORT,
      host: HOST,
    },
  };
}

// ---------------------------------------------------------------- data

function withDb(work) {
  return database.withDatabase(work);
}

// 計算条件が変わったら集計キャッシュを作り直すためのキー
function configSignature(config) {
  return [
    config.electricityRate, config.sensorFactor, config.wallCalibration,
    config.baseWatts, config.monitorWatts, config.thresholdWatts,
  ].join('-');
}

function databaseSummary(db) {
  let hardware = null;
  let recorded = { first: null, last: null, samples: 0 };
  try {
    const row = db.prepare('SELECT MIN(timestamp) AS first, MAX(timestamp) AS last, COUNT(*) AS samples FROM timestamp').get();
    recorded = { first: row?.first ?? null, last: row?.last ?? null, samples: Number(row?.samples || 0) };
  } catch (_) {}
  if (hasTable(db, 'hardware_info')) {
    const row = db.prepare('SELECT hardware_data, tables FROM hardware_info ORDER BY id DESC LIMIT 1').get();
    if (row) {
      try { hardware = JSON.parse(row.hardware_data); } catch (_) { hardware = null; }
      if (hardware && typeof hardware === 'object') hardware.tables = row.tables;
    }
  }
  return { path: DB_PATH, hardware, recorded };
}

function resolvePeriod(params, config) {
  const requested = String(params.get('range') || config.defaultRange || 'today');
  const key = RANGE_KEYS.includes(requested) ? requested : 'today';
  const bounds = safeRange(key, {
    customStart: params.get('from'),
    customEnd: params.get('to'),
    uptimeSeconds: os.uptime(),
  });
  if (!bounds) throw httpError('期間の指定が正しくありません。日付を確認してください。');

  let recorded = { first: null, last: null };
  try { recorded = database.bounds(); } catch (_) {}
  if (key === 'all' && recorded.first) {
    const firstDay = new Date(recorded.first);
    bounds.start = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate()).getTime();
  }
  if (bounds.end <= bounds.start) bounds.end = bounds.start + 60000;

  const requestedGranularity = String(params.get('granularity') || 'auto');
  let { granularity, bucketSeconds } = granularityForSpan(bounds.end - bounds.start);
  if (['minute', 'hour', 'day', 'month'].includes(requestedGranularity)) {
    granularity = requestedGranularity;
    bucketSeconds = granularity === 'minute' ? 60 : granularity === 'hour' ? 3600 : granularity === 'day' ? 86400 : 0;
    const bucketCount = (bounds.end - bounds.start) / Math.max(1, bucketSeconds * 1000);
    if (granularity !== 'month' && bucketCount > 1600) {
      const fallback = granularityForSpan(bounds.end - bounds.start);
      granularity = fallback.granularity;
      bucketSeconds = fallback.bucketSeconds;
    }
  }
  return { key, bounds, granularity, bucketSeconds, recorded };
}

function periodReport(params, config) {
  const period = resolvePeriod(params, config);
  return withDb((db) => {
    const { totals, buckets, truncated } = periodTotals(db, period.bounds, period.granularity, period.bucketSeconds, config);
    const comparisons = comparisonBounds(period.key, period.bounds, {});
    const previous = comparisons.previous
      ? { ...comparisons.previous, ...periodTotals(db, comparisons.previous, period.granularity, period.bucketSeconds, config) }
      : null;
    const yearAgo = comparisons.yearAgo
      ? { ...comparisons.yearAgo, ...periodTotals(db, comparisons.yearAgo, period.granularity, period.bucketSeconds, config) }
      : null;
    const comparison = compareTotals(totals, previous, {
      label: comparisons.previous?.label || '直前期間',
      lengthMismatch: Boolean(comparisons.previous?.differentLength),
    });
    const yearAgoComparison = compareTotals(totals, yearAgo, { label: comparisons.yearAgo?.label || '前年同期間' });
    const gaps = gapsInRange(db, period.bounds);
    const qualification = (period.recorded.first != null && period.bounds.start < period.recorded.first)
      ? { reason: 'before-first-record', note: '記録開始前の期間を含んでいます。記録がある範囲だけを集計しています。' }
      : null;
    return {
      key: period.key,
      label: period.bounds.label,
      bounds: { start: period.bounds.start, end: period.bounds.end, partial: Boolean(period.bounds.partial) },
      granularity: period.granularity,
      bucketSeconds: period.bucketSeconds,
      truncated,
      totals,
      buckets,
      previous: previous ? { label: previous.label, bounds: { start: previous.start, end: previous.end }, totals: previous.totals, buckets: previous.buckets } : null,
      yearAgo: yearAgo ? { label: yearAgo.label, bounds: { start: yearAgo.start, end: yearAgo.end }, totals: yearAgo.totals, buckets: yearAgo.buckets } : null,
      comparison,
      yearAgoComparison,
      gaps,
      qualification,
      recorded: period.recorded,
    };
  });
}

function dataStatePayload(config, report) {
  const current = withDb((db) => currentReading(db, config));
  const warnings = [];
  if (current.watts == null) {
    warnings.push({ key: 'no-current', level: 'warn', text: '現在の電力値を取得できていません。WattSealの記録を確認してください。' });
  } else if (current.reason === 'hourly-rollup') {
    warnings.push({ key: 'rollup-current', level: 'warn', text: '最新の記録が1時間平均のため、現在値としては表示しません。' });
  } else if (current.ageSeconds > 15) {
    warnings.push({ key: 'stale-current', level: 'warn', text: `最終取得から${Math.round(current.ageSeconds)}秒経過しています（現在値ではありません）。` });
  }
  if (report?.totals?.coveragePercent < 95) {
    warnings.push({ key: 'partial', level: 'info', text: `表示期間の記録は${report.totals.coveragePercent}%です。記録のない時間は0円として加算していません。` });
  }
  if (report?.totals?.rollupBuckets > 0) {
    warnings.push({ key: 'rollup', level: 'info', text: '1時間ごとの平均記録が含まれるため、使用時間は概算です。' });
  }
  if (report?.totals?.zeroSamples > 0) {
    warnings.push({ key: 'zero', level: 'info', text: '0Wとして記録された区間があります（記録なしとは区別しています）。' });
  }
  if (report?.comparison && !report.comparison.comparable) {
    warnings.push({ key: 'comparison', level: 'info', text: report.comparison.reason });
  }
  if (report?.qualification) {
    warnings.push({ key: 'qualification', level: 'info', text: report.qualification.note });
  }
  return {
    current,
    quality: {
      coveragePercent: report?.totals?.coveragePercent ?? null,
      missingSeconds: report?.totals?.missingSeconds ?? null,
      expectedSeconds: report?.totals?.expectedSeconds ?? null,
      resolution: report?.totals?.resolution || null,
      samples: report?.totals?.samples ?? 0,
      readableSamples: report?.totals?.readableSamples ?? 0,
      zeroSamples: report?.totals?.zeroSamples ?? 0,
      rollupBuckets: report?.totals?.rollupBuckets ?? 0,
      partialBuckets: report?.totals?.partialBuckets ?? 0,
      missingBuckets: report?.totals?.missingBuckets ?? 0,
      estimated: true,
    },
    warnings,
  };
}

function quickStatsPayload(config) {
  const now = new Date();
  return withDb((db) => {
    const sessionBounds = safeRange('session', { uptimeSeconds: os.uptime() });
    const sessionTotals = periodTotals(db, sessionBounds, 'hour', 3600, config).totals;
    const monthBounds = { start: localStartOfMonth(now), end: now.getTime() };
    const monthTotals = periodTotals(db, monthBounds, 'day', 86400, config).totals;
    const dayProgress = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
    const elapsedDays = Math.max(0.5, now.getDate() - 1 + dayProgress);
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const factor = daysInMonth / elapsedDays;
    const monthKwh = Number(monthTotals.kwh || 0);
    return {
      currentSession: { ...sessionTotals, adjustedKwh: sessionTotals.kwh },
      monthToDate: { ...monthTotals, adjustedKwh: monthKwh },
      monthProjection: {
        cost: Number(monthTotals.cost || 0) * factor,
        adjustedKwh: monthKwh * factor,
        kwh: monthKwh * factor,
        daysInMonth,
        elapsedDays,
        coveragePercent: monthTotals.coveragePercent,
      },
    };
  });
}

function legacyHistory(buckets) {
  return buckets.map((bucket) => ({
    bucket: bucket.bucket,
    timestamp: bucket.timestamp,
    rawKwh: bucket.missing ? 0 : bucket.rawKwh,
    adjustedKwh: bucket.missing ? 0 : bucket.kwh,
    cost: bucket.missing ? 0 : bucket.cost,
    activeSeconds: bucket.activeSeconds,
    averageWatts: bucket.missing ? 0 : bucket.averageWatts,
    maxWatts: bucket.maxWatts,
    missing: Boolean(bucket.missing),
    quality: bucket.quality,
    coveragePercent: bucket.coveragePercent,
    rollup: Boolean(bucket.rollup),
  }));
}

function comparisonHistory(report) {
  if (!report.previous || !report.previous.buckets?.length) return [];
  const offset = report.bounds.start - report.previous.bounds.start;
  return legacyHistory(report.previous.buckets)
    .map((point) => ({ ...point, originalTimestamp: point.timestamp, timestamp: point.timestamp + offset }));
}

function summaryPayload(params, config) {
  const report = periodReport(params, config);
  const state = dataStatePayload(config, report);
  const light = params.get('light') === '1';
  const history = light ? [] : legacyHistory(report.buckets);
  const cacheKey = `breakdown:${report.key}:${new Date(report.bounds.start).toDateString()}:${report.bounds.end - report.bounds.end % 600000}:${configSignature(config)}`;
  const extras = heavyCache.get(cacheKey, () => withDb((db) => ({
    applications: applicationBreakdown(db, report.bounds, config, report.totals),
    components: componentBreakdown(db, report.bounds, config, report.totals),
    sessions: light ? { sessions: [], note: null } : recentSessions(db, config, { maxSessions: 12, detailSessions: 2, since: Date.now() - 30 * DAY_MS }),
    database: databaseSummary(db),
    hourlyProfile: hourlyProfile(db, report.bounds, config),
  }))).value;
  const quickStats = quickStatsPayload(config);
  const peakBucket = report.totals.peakCostBucket;
  const runningCostPerHour = state.current.watts == null ? null : state.current.watts / 1000 * config.electricityRate;
  const previousForCompat = report.previous ? { ...report.previous.totals, adjustedKwh: report.previous.totals.kwh } : null;
  const insights = {
    previousLabel: report.previous?.label || null,
    previous: previousForCompat,
    previousPartial: report.comparison.status === 'insufficient-data',
    previousBounds: report.previous?.bounds || null,
    costDifference: report.comparison.comparable ? report.comparison.diffCost : null,
    costDifferencePercent: report.comparison.comparable ? report.comparison.percentCost : null,
    energyDifferencePercent: report.comparison.comparable ? report.comparison.percentKwh : null,
    activeTimeDifferencePercent: report.comparison.comparable ? report.comparison.percentActiveSeconds : null,
    peak: peakBucket && !peakBucket.missing ? { ...peakBucket } : null,
    costPerActiveHour: report.totals.activeSeconds > 0 ? report.totals.cost / (report.totals.activeSeconds / 3600) : 0,
    runningCostPerHour,
    comparisonStatus: report.comparison.status,
    comparisonReason: report.comparison.comparable ? report.comparison.note : report.comparison.reason,
  };

  return {
    generatedAt: Date.now(),
    version: APP_VERSION,
    range: report.key,
    label: report.label,
    bounds: { start: report.bounds.start, end: report.bounds.end, partial: report.bounds.partial },
    granularity: report.granularity,
    historyGranularity: report.granularity === 'minute' ? 'hour' : report.granularity,
    bucketSeconds: report.bucketSeconds,
    config,
    current: state.current,
    totals: { ...report.totals, adjustedKwh: report.totals.kwh },
    quality: state.quality,
    warnings: state.warnings,
    comparison: report.comparison,
    yearAgoComparison: report.yearAgoComparison,
    previous: previousForCompat,
    history,
    // light=1（新しい画面の概要タブ）では、表やグラフ用の細かい配列を返さない。
    // 期間の詳細は /api/history と /api/breakdown が担当する。
    buckets: light ? [] : report.buckets,
    comparisonHistory: light ? [] : comparisonHistory(report),
    gaps: report.gaps,
    insights,
    components: extras.components.items,
    componentNote: extras.components.note,
    applications: light ? [] : extras.applications.apps,
    applicationNote: extras.applications.note,
    applicationWindow: extras.applications.window,
    applicationCategories: extras.applications.categories.map((item) => ({
      ...item,
      label: APP_CATEGORIES.find((category) => category.key === item.key)?.label || item.key,
    })),
    sessions: extras.sessions.sessions,
    sessionNote: extras.sessions.note,
    quickStats,
    state: classifyState(state.current.watts, report.buckets),
    peak: {
      cost: peakBucket && !peakBucket.missing ? {
        timestamp: peakBucket.timestamp,
        cost: peakBucket.cost,
        kwh: peakBucket.kwh,
        averageWatts: peakBucket.averageWatts,
        granularity: peakBucket.granularity,
      } : null,
      watts: report.totals.peakWattsBucket && !report.totals.peakWattsBucket.missing ? {
        timestamp: report.totals.peakWattsBucket.timestamp,
        maxWatts: report.totals.peakWattsBucket.maxWatts,
        averageWatts: report.totals.peakWattsBucket.averageWatts,
      } : null,
    },
    hourlyProfile: extras.hourlyProfile,
    database: extras.database,
    categories: APP_CATEGORIES,
    displayUnits: DISPLAY_UNITS,
    estimatedNotice: 'すべての電力・料金はWattSealの内部センサー記録から求めた推定値です。コンセントでの実測値ではありません。',
  };
}

function historyPayload(params, config) {
  const report = periodReport(params, config);
  const state = dataStatePayload(config, report);
  const previousByIndex = report.previous?.buckets || [];
  const yearAgoByIndex = report.yearAgo?.buckets || [];
  const rows = report.buckets.map((bucket, index) => ({
    ...bucket,
    previousCost: previousByIndex[index] && !previousByIndex[index].missing ? previousByIndex[index].cost : null,
    previousKwh: previousByIndex[index] && !previousByIndex[index].missing ? previousByIndex[index].kwh : null,
    previousAverageWatts: previousByIndex[index] && !previousByIndex[index].missing ? previousByIndex[index].averageWatts : null,
    yearAgoCost: yearAgoByIndex[index] && !yearAgoByIndex[index].missing ? yearAgoByIndex[index].cost : null,
    yearAgoKwh: yearAgoByIndex[index] && !yearAgoByIndex[index].missing ? yearAgoByIndex[index].kwh : null,
    yearAgoAverageWatts: yearAgoByIndex[index] && !yearAgoByIndex[index].missing ? yearAgoByIndex[index].averageWatts : null,
  }));
  return withDb((db) => ({
    generatedAt: Date.now(),
    version: APP_VERSION,
    range: report.key,
    label: report.label,
    bounds: report.bounds,
    granularity: report.granularity,
    bucketSeconds: report.bucketSeconds,
    config,
    totals: { ...report.totals, adjustedKwh: report.totals.kwh },
    quality: state.quality,
    warnings: state.warnings,
    comparison: report.comparison,
    yearAgoComparison: report.yearAgoComparison,
    previous: report.previous ? { label: report.previous.label, bounds: report.previous.bounds, totals: { ...report.previous.totals, adjustedKwh: report.previous.totals.kwh } } : null,
    yearAgo: report.yearAgo ? { label: report.yearAgo.label, bounds: report.yearAgo.bounds, totals: { ...report.yearAgo.totals, adjustedKwh: report.yearAgo.totals.kwh } } : null,
    buckets: rows,
    gaps: report.gaps,
    events: powerEvents(rows),
    idle: idleRuns(report.buckets, config),
    heatmap: dailyHeatmap(db, report.bounds, config),
    hourlyProfile: hourlyProfile(db, report.bounds, config),
    truncated: report.truncated,
    estimatedNotice: '区間の値は記録から求めた推定値です。記録がない区間は0ではなく「記録なし」として扱います。',
  }));
}

function realtimePayload(minutes, config) {
  const safeMinutes = [5, 15, 60].includes(Number(minutes)) ? Number(minutes) : 15;
  const bounds = { start: Date.now() - safeMinutes * 60000, end: Date.now() };
  return withDb((db) => {
    const watts = hasTable(db, 'total_data') ? wattsExpression(db, 'total_data') : null;
    if (!watts) return { minutes: safeMinutes, points: [], peak: null, leaders: { application: null, component: null } };
    const bucketMs = safeMinutes <= 5 ? 1000 : safeMinutes <= 15 ? 2000 : 10000;
    const aggregated = aggregatedExpression(db, 'd', 't');
    const rows = db.prepare(`
      SELECT CAST(t.timestamp / ? AS INTEGER) * ? AS stamp,
             AVG(${watts}) AS raw_watts,
             MAX(${watts}) AS max_watts,
             COUNT(*) AS samples
        FROM timestamp t JOIN total_data d ON d.timestamp_id = t.id
       WHERE t.timestamp >= ? AND NOT (${aggregated})
       GROUP BY stamp ORDER BY stamp`).all(bucketMs, bucketMs, bounds.start);
    const scale = Number(config.sensorFactor || 1) * Number(config.wallCalibration || 1);
    const fixed = Number(config.baseWatts || 0) + Number(config.monitorWatts || 0);
    const points = rows
      .filter((row) => row.raw_watts != null)
      .map((row) => ({
        timestamp: Number(row.stamp),
        rawWatts: Number(row.raw_watts),
        watts: Number(row.raw_watts) * scale + fixed,
        maxWatts: row.max_watts == null ? null : Number(row.max_watts) * scale + fixed,
        samples: Number(row.samples || 0),
      }));
    const peak = points.reduce((best, point) => (!best || point.watts > best.watts ? point : best), null);
    return { minutes: safeMinutes, bounds, points, peak, leaders: liveLeaders(db, config) };
  });
}

function liveLeaders(db, config) {
  if (!hasTable(db, 'timestamp')) return { application: null, component: null };
  const latest = db.prepare('SELECT id, timestamp FROM timestamp ORDER BY timestamp DESC LIMIT 1').get();
  if (!latest) return { application: null, component: null };
  const scale = Number(config.sensorFactor || 1) * Number(config.wallCalibration || 1);
  let application = null;
  if (hasTable(db, 'process_data')) {
    const watts = wattsExpression(db, 'process_data', 'p');
    if (watts) {
      const row = db.prepare(`SELECT p.app_name AS name, ${watts} AS watts FROM process_data p WHERE p.timestamp_id = ? ORDER BY watts DESC LIMIT 1`).get(latest.id);
      if (row && row.watts != null) application = { name: row.name || '不明', watts: Number(row.watts) * scale, estimated: true };
    }
  }
  let component = null;
  for (const [table, label] of [['cpu_data', 'CPU'], ['gpu_data', 'GPU'], ['ram_data', 'メモリ'], ['disk_data', 'ストレージ'], ['network_data', 'ネットワーク']]) {
    if (!hasTable(db, table)) continue;
     const watts = wattsExpression(db, table);
     if (!watts) continue;
    const row = db.prepare(`SELECT ${watts} AS watts FROM ${table} d WHERE d.timestamp_id = ? LIMIT 1`).get(latest.id);
    if (!row || row.watts == null) continue;
    const value = Number(row.watts) * scale;
    if (!component || value > component.watts) component = { name: label, watts: value, estimated: true };
  }
  return { application, component };
}

function dataStatusPayload() {
  let firstRecorded = null;
  let latestAt = null;
  let samples = 0;
  try {
    withDb((db) => {
      if (!hasTable(db, 'timestamp')) return;
      const row = db.prepare('SELECT MIN(timestamp) AS startedAt, MAX(timestamp) AS latestAt, COUNT(*) AS samples FROM timestamp').get();
      firstRecorded = row?.startedAt ?? null;
      latestAt = row?.latestAt ?? null;
      samples = Number(row?.samples || 0);
    });
  } catch (_) {}
  const sizeOf = (filePath) => { try { return fs.statSync(filePath).size; } catch (_) { return 0; } };
  const databaseBytes = sizeOf(DB_PATH) + sizeOf(`${DB_PATH}-wal`) + sizeOf(`${DB_PATH}-shm`);
  const config = configStore.load();
  const recordedDays = firstRecorded ? Math.max(1, Math.ceil((Date.now() - firstRecorded) / DAY_MS)) : 0;
  const warnings = [];
  if (databaseBytes >= 1024 ** 3) warnings.push('電力履歴が1GBを超えています。CSV保存やバックアップのうえ、必要なら古い期間を削除できます。');
  if (config.retentionDays > 0 && recordedDays > config.retentionDays) {
    warnings.push(`保持期間の目安（${config.retentionDays}日）を超えた記録が${recordedDays}日分あります。自動削除は行いません。`);
  }
  return {
    version: APP_VERSION,
    databaseBytes,
    databasePath: DB_PATH,
    logDirectory: LOG_DIR,
    startedAt: firstRecorded,
    latestAt,
    samples,
    recordedDays,
    retentionDays: config.retentionDays,
    storageCacheBytes: sizeOf(STORAGE_RESULT_PATH),
    storageCacheUpdatedAt: (() => { try { return fs.statSync(STORAGE_RESULT_PATH).mtimeMs; } catch (_) { return null; } })(),
    warning: warnings[0] || null,
    warnings,
  };
}

async function storageStatusPayload() {
  const payload = {
    running: false,
    lanAccess: Boolean(configStore.load().lanAccess),
    lastScanAt: null,
    lastScanBytes: null,
    scanState: 'unknown',
  };
  try {
    const stat = fs.statSync(STORAGE_RESULT_PATH);
    payload.lastScanAt = stat.mtimeMs;
    payload.lastScanBytes = stat.size;
  } catch (_) {}
  try {
    const response = await fetch(`http://127.0.0.1:${STORAGE_PORT}/api/status`, { signal: AbortSignal.timeout(700) });
    if (response.ok) {
      const status = await response.json().catch(() => null);
      payload.running = true;
      payload.scanning = Boolean(status?.scanning);
      payload.scanState = status?.scanning ? 'scanning' : 'idle';
      payload.lastScanAt = status?.finishedAt || status?.lastScanAt || payload.lastScanAt;
      payload.rootPath = status?.rootPath || null;
    }
  } catch (_) {}
  return payload;
}

// ---------------------------------------------------------------- actions

// センサー取得（nvidia-smi / PowerShell）は数秒キャッシュして、
// 画面が2秒ごとに更新してもPCに負担をかけないようにする。
let systemCache = { at: 0, range: null, payload: null };

async function systemPayloadCached(config, range) {
  if (systemCache.payload && systemCache.range === range && Date.now() - systemCache.at < 4000) {
    return { ...systemCache.payload, cached: true, cacheAgeMs: Date.now() - systemCache.at };
  }
  const payload = await withDb((db) => systemPayload({ db, config, range }));
  systemCache = { at: Date.now(), range, payload };
  return { ...payload, cached: false, cacheAgeMs: 0 };
}

function breakdownPayload(params, config) {
  const report = periodReport(params, config);
  const cacheKey = `breakdown:${report.key}:${report.bounds.start}:${Math.round(report.bounds.end / 600000)}:${configSignature(config)}`;
  const result = heavyCache.get(cacheKey, () => withDb((db) => {
    const applications = applicationBreakdown(db, report.bounds, config, report.totals);
    const components = componentBreakdown(db, report.bounds, config, report.totals);
    return { applications, components };
  }));
  return {
    generatedAt: Date.now(),
    range: report.key,
    label: report.label,
    bounds: report.bounds,
    totals: { ...report.totals, adjustedKwh: report.totals.kwh },
    components: result.value.components.items,
    componentNote: result.value.components.note,
    applications: result.value.applications.apps,
    applicationNote: result.value.applications.note,
    applicationWindow: result.value.applications.window,
    applicationCoverage: result.value.applications.coverage,
    categories: result.value.applications.categories.map((item) => ({
      ...item,
      label: APP_CATEGORIES.find((category) => category.key === item.key)?.label || item.key,
    })),
    categoryDefinitions: APP_CATEGORIES,
    cached: result.cached,
    estimatedNotice: '部品別・アプリ別の値は推定です。アプリ別はPC全体の電力からの配分であり、アプリ単体の実測値ではありません。',
  };
}

function sessionsPayload(params, config) {
  const days = numberParam(params.get('days'), 30, 1, 400);
  const since = Date.now() - days * DAY_MS;
  const cacheKey = `sessions:${Math.round(since / 600000)}:${configSignature(config)}`;
  const result = heavyCache.get(cacheKey, () => withDb((db) => recentSessions(db, config, {
    maxSessions: numberParam(params.get('limit'), 20, 1, 100),
    detailSessions: 6,
    since,
  })));
  return {
    generatedAt: Date.now(),
    days,
    ...result.value,
    config: { electricityRate: config.electricityRate, sensorFactor: config.sensorFactor, baseWatts: config.baseWatts, monitorWatts: config.monitorWatts, wallCalibration: config.wallCalibration },
    categoryDefinitions: APP_CATEGORIES,
    cached: result.cached,
    estimatedNotice: 'セッションの電力量・料金は記録から求めた推定値です。アプリ名は各時点で最も電力を使用していたアプリ（推定）です。',
  };
}

async function execFileText(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024, ...options }, (error, stdout) => {
      resolve(error ? '' : String(stdout || '').trim());
    });
  });
}

async function stopOwnWattSeal() {
  if (process.platform !== 'win32') return;
  const targetPath = WATTSEAL_PATH.replace(/'/g, "''");
  const script = `$target='${targetPath}'; @(Get-CimInstance Win32_Process -Filter "Name='WattSeal.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -eq $target } | Select-Object -ExpandProperty ProcessId)`;
  const output = await execFileText('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script]);
  const processIds = output.split(/\r?\n/).map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
  for (const processId of processIds) await execFileText('taskkill.exe', ['/PID', String(processId), '/T', '/F']);
  if (processIds.length) logger.detail('wattseal.stop', { count: processIds.length });
}

function startBackgroundCollector() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const wscriptPath = path.join(systemRoot, 'System32', 'wscript.exe');
  if (process.platform === 'win32' && fs.existsSync(wscriptPath) && fs.existsSync(path.join(APP_DIR, 'background.vbs'))) {
    execFile(wscriptPath, [path.join(APP_DIR, 'background.vbs')], { windowsHide: true }, () => {});
  }
}

function assertStandardDatabaseTarget() {
  if (path.dirname(path.resolve(DB_PATH)) !== path.resolve(APP_DIR) || path.basename(DB_PATH) !== 'power_monitoring.db') {
    throw httpError('安全確認のため、標準の保存場所にある履歴だけ操作できます。');
  }
  if (process.platform !== 'win32') {
    throw httpError('この操作はWindows上のインストール版から実行してください。');
  }
}

async function clearPowerHistory(confirmation) {
  if (confirmation !== 'DELETE_POWER_HISTORY') throw httpError('確認文字列が一致しません。');
  assertStandardDatabaseTarget();
  await stopOwnWattSeal();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      database.invalidate();
      for (const target of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (fs.existsSync(target)) fs.unlinkSync(target);
      break;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  startBackgroundCollector();
  heavyCache.clear();
  logger.info('電力履歴を初期化しました（本人操作）。');
  return { cleared: true };
}

async function deleteRangeAction(body) {
  if (body?.confirmation !== 'DELETE_RANGE') throw httpError('確認文字列が一致しません。');
  const from = String(body.from || '');
  const to = String(body.to || '');
  const start = Date.parse(`${from}T00:00:00`);
  const endDay = Date.parse(`${to}T00:00:00`);
  if (!Number.isFinite(start) || !Number.isFinite(endDay)) throw httpError('削除する期間の指定が正しくありません。');
  const bounds = { start: Math.min(start, endDay), end: Math.max(start, endDay) + DAY_MS - 1 };
  if (bounds.end - bounds.start > 3660 * DAY_MS) throw httpError('指定できる期間が長すぎます。');
  assertStandardDatabaseTarget();
  await stopOwnWattSeal();
  let result = null;
  try {
    database.invalidate();
    result = deleteRange(DB_PATH, bounds.start, bounds.end);
  } finally {
    startBackgroundCollector();
    database.invalidate();
    heavyCache.clear();
  }
  logger.info(`指定期間の記録を削除しました: ${from}〜${to}（${result.deletedSamples}件）`);
  logger.detail('power.deleteRange', { from, to, deletedSamples: result.deletedSamples, deletedRows: result.deletedRows });
  return result;
}

async function clearStorageCache() {
  try {
    if (fs.existsSync(STORAGE_RESULT_PATH)) fs.unlinkSync(STORAGE_RESULT_PATH);
  } catch (_) {
    throw httpError('容量スキャン結果を削除できませんでした。', 500);
  }
  try { await fetch(`http://127.0.0.1:${STORAGE_PORT}/api/clear`, { method: 'POST', signal: AbortSignal.timeout(1200) }); } catch (_) {}
  logger.info('容量スキャン結果を削除しました（本人操作）。');
  return { cleared: true };
}

async function openStorageMap(req) {
  if (!fs.existsSync(STORAGE_SERVER_PATH)) throw httpError('容量マップが見つかりません。SETUP.cmdをもう一度実行してください。', 503);
  const browserHost = requestHostname(req);
  const storageUrl = `http://${browserHost}:${STORAGE_PORT}`;
  // 容量マップはフォルダ名・パスを扱うため、常にこのPC内（127.0.0.1）でだけ動かす。
  // スマホ（LAN側）からは容量タブを開けないようにしてある。
  try {
    const existing = await fetch(`http://127.0.0.1:${STORAGE_PORT}/api/status`, { signal: AbortSignal.timeout(500) });
    if (existing.ok) {
      let loopbackOnly = false;
      try {
        const access = await fetch(`http://127.0.0.1:${STORAGE_PORT}/api/access-info`, { signal: AbortSignal.timeout(500) });
        const payload = access.ok ? await access.json() : null;
        loopbackOnly = payload && payload.lanAccess === false;
      } catch (_) {}
      if (loopbackOnly) return { opened: true, alreadyRunning: true, url: storageUrl };
      try { await fetch(`http://127.0.0.1:${STORAGE_PORT}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(700) }); } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } catch (_) {}
  const child = spawn(process.execPath, [STORAGE_SERVER_PATH], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, PC_STORAGE_EMBEDDED: '1', PC_STORAGE_HOST: LOCAL_HOST },
  });
  child.unref();
  logger.detail('storage.start', { url: storageUrl, host: LOCAL_HOST });
  return { opened: true, url: storageUrl };
}

function restartDashboard() {
  if (process.platform !== 'win32') throw httpError('ダッシュボードの自動再起動はWindows版でのみ使用できます。');
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const wscriptPath = path.join(systemRoot, 'System32', 'wscript.exe');
  const dashboardPath = path.join(APP_DIR, 'dashboard.vbs');
  if (!fs.existsSync(wscriptPath) || !fs.existsSync(dashboardPath)) throw httpError('ダッシュボードの再起動ファイルが見つかりません。', 503);
  setTimeout(() => {
    server.close(() => {
      execFile(wscriptPath, [dashboardPath], { windowsHide: true }, () => process.exit(0));
    });
  }, 250);
  return { restarting: true };
}

// ---------------------------------------------------------------- http

function serveStatic(reqPath, res) {
  let relative = 'index.html';
  if (reqPath !== '/') {
    try { relative = decodeURIComponent(reqPath).replace(/^\/+/, ''); } catch (_) { relative = ''; }
  }
  const root = path.resolve(PUBLIC_DIR);
  const resolved = path.resolve(root, relative);
  if (resolved !== path.join(root, 'index.html') && !resolved.startsWith(root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Forbidden'); return;
  }
  let stat = null;
  try { stat = fs.statSync(resolved); } catch (_) {}
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return;
  }
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  }[path.extname(resolved)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  fs.createReadStream(resolved).pipe(res);
}

function streamFile(res, filePath, options) {
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': options.contentType,
    'Content-Disposition': `attachment; filename="${options.filename}"`,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  });
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('close', () => { if (options.disposable) fs.unlink(filePath, () => {}); });
}

const READ_ONLY_LAN_ALLOWED = new Set([
  '/api/ping', '/api/summary', '/api/history', '/api/realtime', '/api/system', '/api/data-status',
  '/api/breakdown', '/api/sessions',
  '/api/access-info', '/api/settings', '/api/export', '/api/export.json', '/api/logs', '/api/storage-status',
]);

const server = http.createServer(async (req, res) => {
  const requestStarted = Date.now();
  const context = evaluateRequest(req);
  const kind = context.kind;
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  res.on('finish', () => {
    logger.detail('http', {
      method: req.method,
      path: url.pathname,
      status: res.statusCode,
      ms: Date.now() - requestStarted,
      client: kind,
    });
  });

  try {
    if (!context.allowed) {
      logger.detail('access.denied', { address: context.address, path: url.pathname });
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('このPCと同じネットワークからのみ接続できます。');
      return;
    }
    lastActivity = Date.now();

    const config = context.config;
    const isLan = kind === 'lan';
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
    if (isLan && isWrite) {
      throw httpError('スマホ（同一LAN内）からは変更できません。PC側の画面で操作してください。', 403);
    }
    // LAN側は読み取り専用。画面のファイル（HTML/CSS/JS）は配信し、
    // 読み取り用のAPI以外（再起動・削除・設定など）は拒否する。
    if (isLan && url.pathname.startsWith('/api/') && !READ_ONLY_LAN_ALLOWED.has(url.pathname)) {
      throw httpError('この操作はPC内からのみ利用できます。', 403);
    }
    if (isWrite && !sameOriginRequest(req)) {
      throw httpError('許可されていない接続元です。', 403);
    }

    if (req.method === 'GET' && url.pathname === '/api/ping') {
      jsonResponse(res, 200, { ok: true, version: APP_VERSION });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/summary') {
      const payload = summaryPayload(url.searchParams, config);
      jsonResponse(res, 200, isLan ? redactForLan(payload) : payload);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/history') {
      jsonResponse(res, 200, historyPayload(url.searchParams, config));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/breakdown') {
      jsonResponse(res, 200, breakdownPayload(url.searchParams, config));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      jsonResponse(res, 200, sessionsPayload(url.searchParams, config));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/realtime') {
      jsonResponse(res, 200, realtimePayload(url.searchParams.get('minutes') || 15, config));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/system') {
      const payload = await systemPayloadCached(config, url.searchParams.get('range') || '15m');
      jsonResponse(res, 200, isLan ? redactForLan(payload) : payload);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/data-status') {
      const payload = dataStatusPayload();
      jsonResponse(res, 200, isLan ? redactForLan(payload) : payload);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/access-info') {
      jsonResponse(res, 200, networkInfoPayload(req));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/storage-status') {
      const payload = await storageStatusPayload();
      jsonResponse(res, 200, isLan ? redactForLan(payload) : payload);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const kindParam = url.searchParams.get('kind') === 'detail' ? 'detail' : 'normal';
      jsonResponse(res, 200, logger.read(kindParam, numberParam(url.searchParams.get('limit'), 200, 1, 1000)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      jsonResponse(res, 200, config);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/export') {
      const report = periodReport(url.searchParams, config);
      const csv = buildCsv({ buckets: report.buckets, granularity: report.granularity, label: report.label, config });
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="pc-power-${report.key}-${formatDateInput(Date.now())}.csv"`,
        'Content-Length': Buffer.byteLength(csv),
        'Cache-Control': 'no-store',
      });
      res.end(csv);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/export.json') {
      const report = historyPayload(url.searchParams, config);
      const body = buildJson({
        range: report.range,
        label: report.label,
        bounds: report.bounds,
        granularity: report.granularity,
        config,
        totals: report.totals,
        quality: report.quality,
        warnings: report.warnings,
        comparison: report.comparison,
        yearAgoComparison: report.yearAgoComparison,
        buckets: report.buckets.map((bucket) => ({
          start: new Date(bucket.timestamp).toISOString(),
          quality: bucket.quality,
          missing: bucket.missing,
          averageWatts: bucket.averageWatts,
          maxWatts: bucket.maxWatts,
          minWatts: bucket.minWatts,
          kwh: bucket.kwh,
          cost: bucket.cost,
          activeSeconds: bucket.activeSeconds,
          expectedSeconds: bucket.expectedSeconds,
          coveragePercent: bucket.coveragePercent,
          samples: bucket.samples,
        })),
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="pc-power-${report.range}-${formatDateInput(Date.now())}.json"`,
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/backup/db') {
      const target = temporaryBackupPath('.db');
      const backup = createDatabaseBackup(DB_PATH, target);
      logger.info(`DBバックアップを作成しました（${Math.round(backup.bytes / 1024 / 1024)}MB）。`);
      streamFile(res, target, {
        contentType: 'application/octet-stream',
        filename: `power_monitoring-backup-${formatDateInput(Date.now())}.db`,
        disposable: true,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const current = configStore.load();
      const next = configStore.save(parseJson(await readBody(req)));
      const restartRequired = current.lanAccess !== next.lanAccess;
      if (configSignature(current) !== configSignature(next)) heavyCache.clear();
      logger.info('設定を保存しました。');
      jsonResponse(res, 200, { ...next, restartRequired });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/reset-settings') {
      const next = configStore.save({});
      logger.info('計算・表示の設定を初期値へ戻しました。');
      jsonResponse(res, 200, next);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/clear-storage-cache') {
      jsonResponse(res, 200, await clearStorageCache());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/clear-power-history') {
      const body = parseJson(await readBody(req));
      jsonResponse(res, 200, await clearPowerHistory(body.confirmation));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/delete-range') {
      const body = parseJson(await readBody(req));
      jsonResponse(res, 200, await deleteRangeAction(body));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/open-storage') {
      jsonResponse(res, 200, await openStorageMap(req));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/restart') {
      jsonResponse(res, 200, restartDashboard());
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(url.pathname, res);
      return;
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Method not allowed');
  } catch (error) {
    const status = error.statusCode || (error.code === 'DB_NOT_READY' ? 503 : 500);
    if (status >= 500) {
      logger.error(`エラーが発生しました: ${error.message || String(error)}`);
      logger.detail('error', { path: url.pathname, method: req.method, status, error });
    } else {
      logger.detail('rejected', { path: url.pathname, method: req.method, status, message: error.message });
    }
    if (!res.headersSent) jsonResponse(res, status, { error: error.message || String(error) });
  }
});

function openBrowser() {
  if (process.env.PC_POWER_NO_BROWSER === '1' || browserOpened) return;
  browserOpened = true;
  if (process.platform === 'win32') execFile('explorer.exe', [`http://${LOCAL_HOST}:${PORT}`], () => {});
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.warn('表示サーバーはすでに起動しています。既存の画面を開きます。');
    openBrowser();
    setTimeout(() => process.exit(0), 400);
  } else {
    logger.error(`サーバーを起動できませんでした: ${error.message}`);
    process.exitCode = 1;
  }
});

server.listen(PORT, HOST, () => {
  try { fs.writeFileSync(PID_PATH, String(process.pid), 'utf8'); } catch (_) {}
  logger.info('ダッシュボードを起動しました。');
  logger.info(`接続先: http://${LOCAL_HOST}:${PORT}`);
  logger.info(HOST === '0.0.0.0'
    ? 'スマホ閲覧: 有効（同一LAN内のみ・読み取り専用）'
    : 'スマホ閲覧: 無効（このPC内のみ）');
  if (initialConfig.lanKeepAlive && initialConfig.lanAccess) {
    logger.info('スマホ閲覧中のサーバー維持: 有効（設定で有効にしたため常駐します）');
  }
  openBrowser();
});

function removeOwnPidFile() {
  try {
    if (fs.readFileSync(PID_PATH, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_PATH);
  } catch (_) {}
}

process.on('exit', removeOwnPidFile);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

// 既定ではブラウザーを閉じてから約10分で表示サーバーを終了する。
// 「LAN閲覧中はサーバーを維持する」を本人が有効にした場合だけ常駐する。
const idleTimer = setInterval(() => {
  const config = configStore.load();
  if (config.lanKeepAlive && config.lanAccess) return;
  if (Date.now() - lastActivity > IDLE_EXIT_MS) {
    clearInterval(idleTimer);
    logger.info('一定時間アクセスがなかったため表示サーバーを終了します。');
    server.close(() => process.exit(0));
  }
}, 30 * 1000);
idleTimer.unref();

module.exports = { APP_VERSION, server };
