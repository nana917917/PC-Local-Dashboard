'use strict';

// 集計・期間・安全判定の単体検証。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const security = require('../app/lib/security');
const time = require('../app/lib/time');
const configLib = require('../app/lib/config');
const aggregate = require('../app/lib/aggregate');
const { createDatabase } = require('../app/lib/db');
const { buildCsv, deleteRange } = require('../app/lib/export');
const { createFixture } = require('./fixtures');

describe('接続元の判定', () => {
  // このPCが 192.168.1.5/24 と 100.64.1.16/24 に接続している場合を模擬する
  const localNetworks = [
    security.ipv4Network('192.168.1.5', '255.255.255.0'),
    security.ipv4Network('100.64.1.16', '255.255.255.0'),
  ];

  it('PC内（ループバック）は常に許可する', () => {
    for (const address of ['127.0.0.1', '127.0.0.5', '::1', '::ffff:127.0.0.1']) {
      const result = security.evaluateAccess(address, localNetworks, []);
      assert.equal(result.allowed, true, address);
      assert.equal(result.kind, 'local', address);
    }
  });

  it('同じサブネットの端末だけを lan として許可する', () => {
    for (const address of ['192.168.1.20', '192.168.1.254', '100.64.1.30']) {
      const result = security.evaluateAccess(address, localNetworks, []);
      assert.equal(result.allowed, true, address);
      assert.equal(result.kind, 'lan', address);
      assert.ok(result.matched.includes('/24'), `${address} は/24で一致する`);
    }
  });

  it('同じ/10でも別サブネットの端末は許可しない', () => {
    // 100.64.0.0/10 全体を許可しないことが要点（ISP共有アドレス・VPNとの混同を避ける）
    for (const address of ['100.64.5.30', '100.64.1.200.5', '192.168.2.20', '10.0.0.5', '8.8.8.8', '172.16.3.4', '2001:4860:4860::8888']) {
      const result = security.evaluateAccess(address, localNetworks, []);
      assert.equal(result.allowed, false, address);
      assert.equal(result.kind, 'remote', address);
    }
  });

  it('設定で追加したネットワークだけを個別に許可する', () => {
    const extra = security.normalizeNetworkList(['192.168.10.0/24']);
    assert.equal(security.evaluateAccess('192.168.10.5', localNetworks, []).allowed, false);
    const allowed = security.evaluateAccess('192.168.10.5', localNetworks, extra);
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.kind, 'lan');
    assert.equal(allowed.matched, '192.168.10.0/24');
    assert.equal(security.evaluateAccess('192.168.11.5', localNetworks, extra).allowed, false);
  });

  it('仮想アダプターは既定では許可対象にしない', () => {
    const interfaces = {
      'Wi-Fi': [{ address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
      'vEthernet (WSL)': [{ address: '172.27.96.1', netmask: '255.255.240.0', family: 'IPv4', internal: false }],
      'Loopback': [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
    };
    const allowed = security.collectLocalNetworks(interfaces);
    assert.equal(allowed.length, 1);
    assert.equal(allowed[0].cidr, '192.168.1.0/24');
    const virtual = security.collectLocalNetworks(interfaces, { includeVirtual: true }).filter((network) => network.virtual);
    assert.equal(virtual.length, 1);
    assert.equal(virtual[0].cidr, '172.27.96.0/20');
    assert.equal(security.evaluateAccess('172.27.96.2', allowed, []).allowed, false);
  });

  it('CIDRの入力は妥当なものだけ受け付ける', () => {
    assert.equal(security.parseNetwork('192.168.1.0/24').cidr, '192.168.1.0/24');
    assert.equal(security.parseNetwork('192.168.1.5/24').cidr, '192.168.1.0/24');
    assert.equal(security.parseNetwork('192.168.1.5').cidr, '192.168.1.5/32');
    assert.equal(security.parseNetwork('100.64.1.0/10').cidr, '100.64.0.0/10');
    assert.equal(security.parseNetwork('192.168.1.0/33'), null);
    assert.equal(security.parseNetwork('192.168.1.0/7'), null);
    assert.equal(security.parseNetwork('abc'), null);
    assert.equal(security.parseNetwork(''), null);
    // 改行区切りの入力から、妥当なものだけを重複なく取り出す
    const list = security.normalizeNetworkList('192.168.1.0/24\n999.1.1.1/24\n192.168.1.0/24\n10.0.0.0/8');
    assert.deepEqual(list.map((network) => network.cidr), ['192.168.1.0/24', '10.0.0.0/8']);
    assert.equal(security.normalizeNetworkList(Array(20).fill('192.168.1.0/24')).length, 1);
  });

  it('IPv6は同じネットワークだけを許可する', () => {
    const network = security.ipv6Network('fe80::4509:b5fd:a04f:4d12', 'ffff:ffff:ffff:ffff::');
    assert.equal(network.cidr, 'fe80::4509:b5fd:a04f:4d12/64');
    assert.equal(security.ipv6InNetwork('fe80::1', network), true);
    assert.equal(security.ipv6InNetwork('fe80:0:1::1', network), false);
  });

  it('別サイトからのPOSTは拒否し、同じ接続元は許可する', () => {
    assert.equal(security.sameOriginRequest({ headers: { host: '127.0.0.1:17891' } }), true, 'Originなし（同一アプリのfetch）');
    assert.equal(security.sameOriginRequest({ headers: { host: '127.0.0.1:17891', origin: 'http://127.0.0.1:17891' } }), true);
    assert.equal(security.sameOriginRequest({ headers: { host: '127.0.0.1:17891', origin: 'http://192.168.0.5:17891' } }), false);
    assert.equal(security.sameOriginRequest({ headers: { host: '127.0.0.1:17891', origin: 'https://evil.example' } }), false);
    assert.equal(security.sameOriginRequest({ headers: { host: '127.0.0.1:17891', origin: 'not a url' } }), false);
  });
});

describe('期間と粒度', () => {
  it('期間の長さに応じて粒度を切り替える', () => {
    assert.deepEqual(time.granularityForSpan(4 * 3600000), { granularity: 'minute', bucketSeconds: 60 });
    assert.deepEqual(time.granularityForSpan(6 * 3600000), { granularity: 'minute', bucketSeconds: 300 });
    assert.deepEqual(time.granularityForSpan(2 * 86400000), { granularity: 'hour', bucketSeconds: 3600 });
    assert.deepEqual(time.granularityForSpan(7 * 86400000), { granularity: 'hour', bucketSeconds: 3600 });
    assert.deepEqual(time.granularityForSpan(30 * 86400000), { granularity: 'day', bucketSeconds: 86400 });
    assert.deepEqual(time.granularityForSpan(400 * 86400000), { granularity: 'day', bucketSeconds: 86400 });
    assert.deepEqual(time.granularityForSpan(2000 * 86400000), { granularity: 'month', bucketSeconds: 0 });
  });

  it('日付・月・年の境界をローカル時刻で求める', () => {
    const now = new Date(2026, 2, 15, 13, 30, 0);
    const today = time.safeRange('today', { now });
    assert.equal(new Date(today.start).getHours(), 0);
    assert.equal(new Date(today.start).getDate(), 15);
    const yesterday = time.safeRange('yesterday', { now });
    assert.equal(new Date(yesterday.start).getDate(), 14);
    assert.equal(yesterday.end, today.start);
    const month = time.safeRange('month', { now });
    assert.equal(new Date(month.start).getMonth(), 2);
    assert.equal(new Date(month.start).getDate(), 1);
    const lastMonth = time.safeRange('lastMonth', { now });
    assert.equal(new Date(lastMonth.start).getMonth(), 1);
    assert.equal(lastMonth.end, month.start);
    const thisYear = time.safeRange('thisYear', { now });
    assert.equal(new Date(thisYear.start).getMonth(), 0);
    assert.equal(new Date(thisYear.start).getDate(), 1);
    const lastYear = time.safeRange('lastYear', { now });
    assert.equal(new Date(lastYear.start).getFullYear(), 2025);
    assert.equal(lastYear.end, thisYear.start);
  });

  it('年またぎ・月末でも期間の長さが保たれる', () => {
    const newYear = new Date(2026, 0, 1, 0, 30, 0);
    const today = time.safeRange('today', { now: newYear });
    const yesterday = time.safeRange('yesterday', { now: newYear });
    assert.equal(new Date(yesterday.start).getFullYear(), 2025);
    assert.equal(new Date(yesterday.start).getMonth(), 11);
    assert.equal(new Date(yesterday.start).getDate(), 31);
    const previous = time.comparisonBounds('today', today, { now: newYear }).previous;
    assert.equal(previous.start, yesterday.start);
    const monthEnd = new Date(2026, 4, 31, 23, 59, 0);
    const month = time.safeRange('month', { now: monthEnd });
    const comparison = time.comparisonBounds('month', month, { now: monthEnd });
    assert.equal(new Date(comparison.previous.start).getMonth(), 3);
    assert.ok(comparison.previous.end <= month.start);
  });

  it('カスタム期間は不正な入力を拒否する', () => {
    assert.equal(time.safeRange('custom', { customStart: '2026-02-30', customEnd: '2026-03-01' }), null);
    assert.equal(time.safeRange('custom', { customStart: 'abc', customEnd: '2026-03-01' }), null);
    const ok = time.safeRange('custom', { customStart: '2026-03-01', customEnd: '2026-03-05', now: new Date(2026, 2, 10) });
    assert.equal(new Date(ok.start).getDate(), 1);
    assert.equal(new Date(ok.end).getDate(), 6);
  });

  it('バケット数を抑えつつ欠損区間も含めて列挙する', () => {
    const start = new Date(2026, 0, 1, 0, 0, 0).getTime();
    const end = new Date(2026, 0, 3, 0, 0, 0).getTime();
    const buckets = time.enumerateBuckets(start, end, 'day', 86400);
    assert.equal(buckets.length, 2);
    assert.equal(buckets[0].clippedStart, start);
    const hourly = time.enumerateBuckets(start, start + 5 * 3600000, 'hour', 3600);
    assert.equal(hourly.length, 5);
  });
});

describe('設定の互換性', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-dashboard-config-'));

  it('既存キーのみのconfig.jsonを読み、追加キーは既定値にする', () => {
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      electricityRate: 27,
      sensorFactor: 1.05,
      baseWatts: 30,
      monitorWatts: 10,
      monthlyBudget: 2000,
      lanAccess: true,
      gameKeywords: ['steam'],
    }), 'utf8');
    const store = configLib.createConfigStore(configPath);
    const config = store.load();
    assert.equal(config.electricityRate, 27);
    assert.equal(config.monitorWatts, 10);
    assert.equal(config.lanAccess, true);
    assert.deepEqual(config.gameKeywords, ['steam']);
    assert.equal(config.defaultRange, 'today');
    assert.equal(config.wallCalibration, 1);
    assert.equal(config.lanKeepAlive, false);
    assert.deepEqual(config.appCategoryMap, {});
  });

  it('壊れたconfig.jsonでも既定値で起動し、未知のキーを消さない', () => {
    const configPath = path.join(dir, 'broken.json');
    fs.writeFileSync(configPath, '{ not json', 'utf8');
    const store = configLib.createConfigStore(configPath);
    assert.equal(store.load().electricityRate, configLib.DEFAULT_CONFIG.electricityRate);
    const next = store.save({ electricityRate: 25, futureKey: 'keep-me' });
    assert.equal(next.electricityRate, 25);
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(onDisk.futureKey, 'keep-me');
    assert.equal(onDisk.sensorFactor, configLib.DEFAULT_CONFIG.sensorFactor);
  });

  it('分類の手動設定は有効なカテゴリだけ受け付ける', () => {
    const mapped = configLib.categoryMap('chrome.exe = browser\nunknown.exe = not-a-category\ncode.exe: dev');
    assert.deepEqual(mapped, { 'chrome.exe': 'browser', 'code.exe': 'dev' });
  });

  it('数値の範囲外は既定値へ戻す', () => {
    const config = configLib.normalizeConfig({ electricityRate: 9999, sensorFactor: 0, baseWatts: -5, lanAccess: 'yes' });
    assert.equal(config.electricityRate, configLib.DEFAULT_CONFIG.electricityRate);
    assert.equal(config.sensorFactor, configLib.DEFAULT_CONFIG.sensorFactor);
    assert.equal(config.baseWatts, configLib.DEFAULT_CONFIG.baseWatts);
    assert.equal(config.lanAccess, false);
  });
});

describe('料金と補正の計算', () => {
  const config = { electricityRate: 30, sensorFactor: 1.1, baseWatts: 25, monitorWatts: 5, wallCalibration: 1 };

  it('推定kWhと料金を設定値から計算する', () => {
    // 100Wを1時間 = 0.1kWh。倍率1.1で0.11kWh、固定30W×1時間=0.03kWh、合計0.14kWh
    const totals = aggregate.applyAdjustments(0.1, 3600, config);
    assert.ok(Math.abs(totals.adjustedKwh - 0.14) < 1e-9);
    assert.ok(Math.abs(totals.cost - 4.2) < 1e-9);
    assert.ok(Math.abs(totals.averageWatts - 140) < 1e-6);
  });

  it('校正係数はセンサー値だけに掛かる', () => {
    const calibrated = aggregate.applyAdjustments(0.1, 3600, { ...config, wallCalibration: 0.9 });
    assert.ok(Math.abs(calibrated.adjustedKwh - (0.1 * 1.1 * 0.9 + 0.03)) < 1e-9);
  });

  it('比較できないときは増減率を出さない', () => {
    const current = { start: 0, end: 86400000, cost: 100, kwh: 3, activeSeconds: 3600, coveragePercent: 100 };
    assert.equal(aggregate.compareTotals(current, null).comparable, false);
    assert.equal(aggregate.compareTotals(current, null).status, 'no-previous-period');
    const empty = aggregate.compareTotals(current, { label: '昨日', bounds: { start: -86400000, end: 0 }, totals: { cost: 0, kwh: 0, activeSeconds: 0, coveragePercent: 0, readableSamples: 0 } });
    assert.equal(empty.comparable, false);
    const partial = aggregate.compareTotals(current, { label: '昨日', bounds: { start: -86400000, end: 0 }, totals: { cost: 50, kwh: 1.5, activeSeconds: 1800, coveragePercent: 40, readableSamples: 100 } });
    assert.equal(partial.comparable, false);
    assert.equal(partial.status, 'insufficient-data');
    assert.match(partial.reason, /40%/);
    const zero = aggregate.compareTotals(current, { label: '昨日', bounds: { start: -86400000, end: 0 }, totals: { cost: 0, kwh: 0, activeSeconds: 3600, coveragePercent: 100, readableSamples: 100 } });
    assert.equal(zero.comparable, false);
    assert.equal(zero.status, 'previous-zero');
    const ok = aggregate.compareTotals(current, { label: '昨日', bounds: { start: -86400000, end: 0 }, totals: { cost: 50, kwh: 1.5, activeSeconds: 3600, coveragePercent: 100, readableSamples: 100 } });
    assert.equal(ok.comparable, true);
    assert.equal(ok.diffCost, 50);
    assert.equal(ok.percentCost, 100);
  });

  it('負荷状態は期間内の分布で分類する', () => {
    const buckets = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((watts) => ({ missing: false, averageWatts: watts }));
    assert.equal(aggregate.classifyState(15, buckets).key, 'idle');
    assert.equal(aggregate.classifyState(95, buckets).key, 'high');
    assert.equal(aggregate.classifyState(45, buckets).key, 'normal');
    assert.equal(aggregate.classifyState(null, buckets).key, 'unknown');
    assert.equal(aggregate.classifyState(45, []).key, 'unknown');
  });
});

describe('DB集計とエクスポート', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-dashboard-unit-'));

  it('記録なしと0Wを区別して集計する', () => {
    const fixture = createFixture(path.join(dir, 'zero'), 'zero');
    const database = createDatabase({ path: fixture.dbPath });
    const config = configLib.normalizeConfig({});
    const start = time.localStartOfDay(new Date(Date.now() - 86400000));
    const result = database.withDatabase((db) => aggregate.periodTotals(db, { start, end: start + 8 * 3600000 }, 'hour', 3600, config));
    assert.equal(result.buckets.length, 8);
    const zeroBucket = result.buckets.find((bucket) => bucket.quality === 'zero');
    assert.ok(zeroBucket, '0Wの時間帯を検出する');
    assert.equal(zeroBucket.rawKwh, 0);
    assert.equal(zeroBucket.missing, false);
    const emptyBucket = result.buckets.at(-1);
    assert.ok(emptyBucket.missing);
    assert.equal(emptyBucket.kwh, null, '記録なしは0ではなくnullで返す');
    assert.equal(emptyBucket.cost, null);
  });

  it('CSVに品質列と推定の注記を含める', () => {
    const csv = buildCsv({
      buckets: [
        { timestamp: Date.now(), granularity: 'hour', missing: false, quality: 'complete', averageWatts: 80, maxWatts: 120, minWatts: 40, kwh: 0.08, cost: 2.5, activeSeconds: 3600, expectedSeconds: 3600, samples: 60, previousCost: 1.5 },
        { timestamp: Date.now(), granularity: 'hour', missing: true, quality: 'missing', averageWatts: null, maxWatts: null, minWatts: null, kwh: null, cost: null, activeSeconds: 0, expectedSeconds: 3600, samples: 0, previousCost: null },
      ],
      granularity: 'hour',
      label: '今日',
      config: { electricityRate: 31, sensorFactor: 1.1, wallCalibration: 1, baseWatts: 25, monitorWatts: 0 },
    });
    assert.ok(csv.startsWith('\uFEFF'));
    const lines = csv.split('\r\n');
    assert.match(lines[0], /データ品質/);
    assert.match(lines[1], /通常（1秒記録）/);
    assert.match(lines[2], /記録なし/);
    assert.ok(csv.includes('# 推定値'));
  });

  it('指定期間だけを削除し、他の期間は残す', () => {
    const fixture = createFixture(path.join(dir, 'delete'), 'gaps');
    const database = createDatabase({ path: fixture.dbPath });
    const before = database.bounds();
    const dayStart = time.localStartOfDay(new Date(Date.now() - 86400000));
    const result = deleteRange(fixture.dbPath, dayStart + 10 * 3600000, dayStart + 11 * 3600000 - 1);
    assert.ok(result.deletedSamples > 0);
    const after = database.bounds();
    assert.equal(after.samples, before.samples - result.deletedSamples);
    assert.ok(after.samples > 0);
  });
});
