'use strict';

// 画面が使うAPIの検証。空DB・1日・7日・30日・400日・旧形式・欠損・0W・
// 古い値・境界などを、実際にサーバーを起動して確認する。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { after, before, describe, it } = require('node:test');

const { createFixture } = require('./fixtures');

const root = path.resolve(__dirname, '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-dashboard-tests-'));
let portCursor = 19500 + Math.floor(Math.random() * 300);

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      hostname: options.hostname || '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = http.request(requestOptions, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await request(port, '/api/ping');
      if (response.statusCode === 200) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`サーバーが起動しませんでした (port ${port})`);
}

async function withServer(scenario, run, options = {}) {
  const dir = path.join(workDir, scenario);
  const fixture = createFixture(dir, scenario, options);
  const port = portCursor++;
  const child = spawn(process.execPath, ['app/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PC_POWER_DB: fixture.dbPath,
      PC_POWER_CONFIG: fixture.configPath,
      PC_POWER_LOG_DIR: path.join(dir, 'logs'),
      PC_POWER_PORT: String(port),
      PC_POWER_HOST: options.host || '127.0.0.1',
      PC_POWER_NO_BROWSER: '1',
    },
    stdio: 'ignore',
  });
  try {
    await waitForServer(port);
    await run(port, fixture);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

async function summary(port, query = 'range=today') {
  const response = await request(port, `/api/summary?${query}`);
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body);
}

async function history(port, query = 'range=today') {
  const response = await request(port, `/api/history?${query}`);
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body);
}

after(() => {
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
});

describe('空のDB', () => {
  it('0件でもエラーにならず、記録なしとして返す', async () => {
    await withServer('empty', async (port) => {
      const data = await summary(port);
      assert.equal(data.totals.samples, 0);
      assert.equal(data.totals.cost, 0);
      assert.equal(data.current.watts, null);
      assert.equal(data.current.stale, true);
      assert.ok(data.warnings.some((warning) => warning.key === 'no-current'));
      const table = await history(port, 'range=7d');
      assert.ok(table.buckets.length >= 7);
      assert.ok(table.buckets.every((bucket) => bucket.missing));
      assert.equal(table.buckets[0].cost, null);
    });
  });
});

describe('1件だけの記録', () => {
  it('現在値は25W＋計測値で計算し、比較はしない', async () => {
    await withServer('single', async (port) => {
      const data = await summary(port);
      assert.equal(Math.round(data.current.watts), Math.round(77.5 * 1.1 + 25));
      assert.equal(data.current.stale, false);
      assert.equal(data.comparison.comparable, false);
      assert.match(data.comparison.reason, /記録がありません|比較/);
      const table = await history(port);
      assert.equal(table.buckets.filter((bucket) => !bucket.missing).length, 1);
    });
  });
});

describe('今日（欠損あり・前日あり）', () => {
  it('欠損区間は0ではなく missing として返し、前日比較を出す', async () => {
    await withServer('today', async (port) => {
      const data = await summary(port);
      assert.ok(data.totals.cost > 0);
      assert.ok(data.totals.coveragePercent < 100);
      const table = await history(port, 'range=today&granularity=hour');
      const missing = table.buckets.filter((bucket) => bucket.missing);
      const incomplete = table.buckets.filter((bucket) => bucket.missing || bucket.coveragePercent < 100);
      assert.ok(incomplete.length >= 1, '欠損または一部欠損のバケットがある');
      for (const bucket of missing) {
        assert.equal(bucket.cost, null);
        assert.equal(bucket.kwh, null);
        assert.equal(bucket.averageWatts, null);
      }
      assert.ok(table.totals.missingSeconds > 0, '欠損時間を合計に含める');
      // 5分以上の空白はギャップとして返す（日付直後の短い検証では別シナリオで確認する）
      assert.equal(table.comparison.status, 'ok');
      assert.ok(typeof table.comparison.percentCost === 'number');
      const granularity = await history(port, 'range=7d');
      assert.equal(granularity.granularity, 'hour', '7日は時間単位');
      const daily = await history(port, 'range=30d');
      assert.equal(daily.granularity, 'day', '30日は日単位');
    });
  });

  it('期間タブを切り替えると粒度と比較対象が変わる', async () => {
    await withServer('week', async (port) => {
      const week = await history(port, 'range=7d');
      assert.equal(week.granularity, 'hour');
      assert.ok(week.totals.rollupBuckets > 0, '1時間ロールアップを含む');
      assert.ok(week.buckets.some((bucket) => bucket.rollup));
      const month = await history(port, 'range=month');
      assert.equal(month.granularity, 'day');
      assert.ok(month.comparison.label.includes('前月'));
      assert.equal(month.buckets[0].granularity, 'day');
    });
  });
});

describe('古い値・0W・欠損の区別', () => {
  it('古い記録は現在値として扱わない', async () => {
    await withServer('stale', async (port) => {
      const data = await summary(port);
      assert.equal(data.current.stale, true);
      assert.ok(data.current.ageSeconds > 1000);
      assert.ok(data.warnings.some((warning) => warning.key === 'stale-current'));
      assert.equal(data.insights.runningCostPerHour > 0, true);
    });
  });

  it('0W記録は欠損と区別する', async () => {
    await withServer('zero', async (port) => {
      const table = await history(port, 'range=yesterday&granularity=hour');
      assert.ok(table.totals.zeroSamples > 0);
      const zeroBucket = table.buckets.find((bucket) => bucket.quality === 'zero');
      assert.ok(zeroBucket, '0Wとして記録された区間がある');
      assert.equal(zeroBucket.missing, false);
      assert.equal(zeroBucket.rawKwh, 0, '生の記録は0kWh');
      assert.ok(zeroBucket.zeroSamples > 0);
      assert.ok(table.buckets.some((bucket) => !bucket.missing && bucket.cost > 0), '0W以外の区間は通常どおり集計する');
    });
  });

  it('大きな欠損はギャップとして返す', async () => {
    await withServer('gaps', async (port) => {
      const table = await history(port, 'range=yesterday&granularity=hour');
      assert.ok(table.gaps.length >= 1);
      assert.ok(table.gaps[0].seconds >= 4 * 3600, `欠損が4時間以上: ${table.gaps[0].seconds}`);
      assert.ok(table.warnings.some((warning) => warning.key === 'partial'));
      const missing = table.buckets.filter((bucket) => bucket.missing);
      assert.ok(missing.length >= 4);
      assert.ok(missing.every((bucket) => bucket.cost === null));
      assert.ok(table.totals.missingSeconds > 4 * 3600);
    });
  });
});

describe('長期データ', () => {
  it('400日分でも日単位で集計でき、重くならない', async () => {
    await withServer('days400', async (port) => {
      const started = Date.now();
      const table = await history(port, 'range=all');
      const elapsed = Date.now() - started;
      assert.equal(table.granularity, 'day');
      assert.ok(table.buckets.length > 300);
      assert.ok(elapsed < 8000, `集計が遅すぎる: ${elapsed}ms`);
      assert.ok(table.heatmap.cells.length > 0);
      const profile = table.hourlyProfile;
      assert.equal(profile.length, 24);
      const year = await history(port, 'range=year');
      assert.ok(year.buckets.length >= 300);
    });
  });

  it('30日分のデータで日別の表が作れる', async () => {
    await withServer('days30', async (port) => {
      const table = await history(port, 'range=30d');
      assert.equal(table.granularity, 'day');
      assert.equal(table.buckets.length, 30);
      assert.ok(table.buckets.every((bucket) => bucket.expectedSeconds > 0));
      assert.ok(table.buckets.some((bucket) => bucket.maxWatts != null));
    });
  });
});

describe('旧形式DBと境界', () => {
  it('旧WattSeal形式（エネルギー列）でも集計できる', async () => {
    await withServer('legacy', async (port) => {
      const data = await summary(port);
      assert.ok(data.totals.kwh > 0);
      assert.ok(data.current.watts > 0);
      const table = await history(port);
      assert.ok(table.buckets.some((bucket) => !bucket.missing));
      assert.equal(data.database.path !== '', true);
    });
  });

  it('月末・月初・年始をまたいでも期間を混ぜない', async () => {
    await withServer('boundary', async (port) => {
      const month = await history(port, 'range=month');
      const previous = await history(port, 'range=lastMonth');
      const thisYear = await history(port, 'range=thisYear');
      assert.ok(month.bounds.start <= month.bounds.end);
      assert.ok(previous.bounds.start < previous.bounds.end);
      assert.ok(thisYear.bounds.start <= month.bounds.start);
      assert.equal(new Date(thisYear.bounds.start).getMonth(), 0);
      assert.equal(new Date(thisYear.bounds.start).getDate(), 1);
    });
  });
});

describe('入力の検証と安全性', () => {
  it('不正な期間・不正な数値は既定値かエラーで返す', async () => {
    await withServer('today', async (port) => {
      const fallback = await summary(port, 'range=does-not-exist');
      assert.equal(fallback.range, 'today');
      const badCustom = await request(port, '/api/summary?range=custom&from=2026-13-99&to=abc');
      assert.equal(badCustom.statusCode, 400);
      const realtime = await request(port, '/api/realtime?minutes=9999');
      assert.equal(realtime.statusCode, 200);
      assert.equal(JSON.parse(realtime.body).minutes, 15);
      const logs = await request(port, '/api/logs?limit=999999');
      assert.equal(logs.statusCode, 200);
    });
  });

  it('パストラバーサル・不明ファイル・不正JSON・過大入力を拒否する', async () => {
    await withServer('today', async (port) => {
      const traversal = await request(port, '/../server.js');
      assert.ok([403, 404].includes(traversal.statusCode));
      assert.ok(!traversal.body.includes('createServer'));
      const missing = await request(port, '/does-not-exist.js');
      assert.equal(missing.statusCode, 404);
      const badJson = await request(port, '/api/settings', { method: 'POST', body: '{oops' });
      assert.equal(badJson.statusCode, 400);
      const tooBig = await request(port, '/api/settings', { method: 'POST', body: JSON.stringify({ gameKeywords: 'x'.repeat(40000) }) });
      assert.equal(tooBig.statusCode, 413);
      const foreignOrigin = await request(port, '/api/settings', {
        method: 'POST',
        headers: { Origin: 'http://evil.example' },
        body: JSON.stringify({ electricityRate: 1 }),
      });
      assert.equal(foreignOrigin.statusCode, 403);
    });
  });

  it('設定は既存キーを保ったまま保存できる', async () => {
    await withServer('today', async (port) => {
      const before = JSON.parse((await request(port, '/api/settings')).body);
      const response = await request(port, '/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ electricityRate: 27.5, appCategoryMap: { 'chrome.exe': 'browser', 'unknown.exe': 'not-a-category' } }),
      });
      assert.equal(response.statusCode, 200);
      const saved = JSON.parse(response.body);
      assert.equal(saved.electricityRate, 27.5);
      assert.equal(saved.sensorFactor, before.sensorFactor);
      assert.deepEqual(saved.appCategoryMap, { 'chrome.exe': 'browser' });
    });
  });

  it('エクスポート（CSV/JSON/DBバックアップ）が壊れていない', async () => {
    await withServer('today', async (port) => {
      const csv = await request(port, '/api/export?range=today');
      assert.equal(csv.statusCode, 200);
      assert.ok(csv.body.startsWith('\uFEFF'));
      assert.match(csv.body, /平均電力\(W\)/);
      assert.match(csv.body, /データ品質/);
      const json = await request(port, '/api/export.json?range=today');
      assert.equal(json.statusCode, 200);
      const parsed = JSON.parse(json.body);
      assert.ok(Array.isArray(parsed.buckets));
      assert.match(parsed.note, /推定値/);
      const backup = await request(port, '/api/backup/db');
      assert.equal(backup.statusCode, 200);
      assert.ok(Number(backup.headers['content-length']) > 1000);
    });
  });
});

describe('LANからのアクセス制御', () => {
  function lanAddress() {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if ((address.family === 'IPv4' || address.family === 4) && !address.internal) return address.address;
      }
    }
    return null;
  }

  it('LAN側は読み取り専用で、設定変更は拒否される', async (t) => {
    const address = lanAddress();
    if (!address) {
      t.skip('LANアドレスが無いため未確認');
      return;
    }
    await withServer('today', async (port) => {
      let readResponse;
      try {
        readResponse = await request(port, '/api/summary?range=today', { hostname: address });
      } catch (error) {
        t.skip(`LAN経由の接続を確認できないため未確認: ${error.message}`);
        return;
      }
      if (readResponse.statusCode === 403) {
        t.skip(`LAN経由の接続が拒否されたため未確認: ${readResponse.body}`);
        return;
      }
      assert.equal(readResponse.statusCode, 200);
      // LAN側へ絶対パス・PC名・ボリューム名を返さない
      const lanSummary = JSON.parse(readResponse.body);
      assert.equal(lanSummary.database.path, null, 'DBの絶対パスをLANへ返さない');
      assert.equal(lanSummary.database.hardware?.system?.hostname, undefined, 'PC名をLANへ返さない');
      const lanStatus = JSON.parse((await request(port, '/api/data-status', { hostname: address })).body);
      assert.equal(lanStatus.databasePath, null);
      assert.equal(lanStatus.logDirectory, null);
      assert.equal(lanStatus.redactedForLan, true);
      const lanSystem = JSON.parse((await request(port, '/api/system?range=15m', { hostname: address })).body);
      assert.ok((lanSystem.drives || []).every((drive) => drive.label === null), 'ボリューム名をLANへ返さない');
      // 画面のファイル自体はLAN側にも配信する（読み取り専用のため）
      const pageResponse = await request(port, '/', { hostname: address });
      assert.equal(pageResponse.statusCode, 200);
      assert.match(pageResponse.body, /PC電力ダッシュボード/);
      const scriptResponse = await request(port, '/js/app.js', { hostname: address });
      assert.equal(scriptResponse.statusCode, 200);
      const blockedApi = await request(port, '/api/backup/db', { hostname: address });
      assert.equal(blockedApi.statusCode, 403);
      const blockedStorage = await request(port, '/api/open-storage', {
        hostname: address,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(blockedStorage.statusCode, 403, '容量マップはLANから開けない');
      const writeResponse = await request(port, '/api/settings', {
        hostname: address,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ electricityRate: 1 }),
      });
      assert.equal(writeResponse.statusCode, 403);
      assert.match(writeResponse.body, /変更できません/);
      const deleteResponse = await request(port, '/api/clear-power-history', {
        hostname: address,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'DELETE_POWER_HISTORY' }),
      });
      assert.equal(deleteResponse.statusCode, 403);
      const accessInfo = await request(port, '/api/access-info', { hostname: address });
      const info = JSON.parse(accessInfo.body);
      assert.equal(info.readOnlyForLan, true);
      assert.ok(info.matchedNetwork, 'どのネットワークで許可されたかを返す');
      assert.ok(info.allowedNetworks.length > 0);
      assert.equal(typeof info.serverState.uptimeSeconds, 'number');
      assert.equal(info.idleExitMinutes, 10);
    }, { host: '0.0.0.0' });
  });
});

describe('ログ', () => {
  it('通常ログと詳細ログを分けて保存する', async () => {
    await withServer('today', async (port) => {
      await summary(port);
      const normal = JSON.parse((await request(port, '/api/logs?kind=normal')).body);
      assert.ok(normal.lines.some((line) => line.includes('ダッシュボードを起動しました')));
      assert.ok(normal.lines.every((line) => !line.includes(workDir)), '通常ログにローカルパスを出さない');
      assert.ok(normal.lines.every((line) => !/at Object\.|node_modules/.test(line)), '通常ログにスタックトレースを出さない');
      const detail = JSON.parse((await request(port, '/api/logs?kind=detail')).body);
      assert.ok(detail.entries.some((entry) => entry.event === 'http' && entry.path === '/api/summary'));
      const detailText = JSON.stringify(detail);
      assert.ok(!detailText.includes(os.hostname()), '詳細ログでもPC名は置き換える');
    });
  });
});

describe('価格と単位の整合', () => {
  it('料金は単価×kWhで、単価変更が再計算に反映される', async () => {
    await withServer('today', async (port) => {
      const before = await summary(port, 'range=today');
      const expected = before.totals.kwh * before.config.electricityRate * before.config.wallCalibration;
      assert.ok(Math.abs(before.totals.cost - expected) < 0.01);
      await request(port, '/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ electricityRate: 62 }),
      });
      const after = await summary(port, 'range=today');
      assert.ok(Math.abs(after.totals.cost - before.totals.cost * 2) < Math.max(1, before.totals.cost * 0.02));
    });
  });
});
