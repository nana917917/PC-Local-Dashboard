'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-local-dashboard-smoke-'));
const dbPath = path.join(temporaryDir, 'power_monitoring.db');
const configPath = path.join(temporaryDir, 'config.json');
const port = 19000 + Math.floor(Math.random() * 500);

function createFixture() {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE timestamp (id INTEGER PRIMARY KEY, timestamp INTEGER, period_type INTEGER);
    CREATE TABLE total_data (timestamp_id INTEGER, total_power_watts REAL);
    CREATE TABLE cpu_data (timestamp_id INTEGER, total_power_watts REAL, usage_percent REAL);
    CREATE TABLE gpu_data (timestamp_id INTEGER, total_power_watts REAL, usage_percent REAL);
    CREATE TABLE ram_data (timestamp_id INTEGER, total_power_watts REAL, usage_percent REAL);
    CREATE TABLE process_data (timestamp_id INTEGER, process_power_watts REAL, app_name TEXT);
  `);
  const timestamp = Date.now() - 1000;
  db.prepare('INSERT INTO timestamp VALUES (?, ?, ?)').run(1, timestamp, 1);
  db.prepare('INSERT INTO total_data VALUES (?, ?)').run(1, 100);
  db.prepare('INSERT INTO cpu_data VALUES (?, ?, ?)').run(1, 40, null);
  db.prepare('INSERT INTO gpu_data VALUES (?, ?, ?)').run(1, 50, 65);
  db.prepare('INSERT INTO ram_data VALUES (?, ?, ?)').run(1, 10, 30);
  db.prepare('INSERT INTO process_data VALUES (?, ?, ?)').run(1, 20, 'test.exe');
  db.close();
  fs.writeFileSync(configPath, JSON.stringify({
    electricityRate: 31,
    sensorFactor: 1.1,
    baseWatts: 25,
    monitorWatts: 0,
    monthlyBudget: 0,
    lanAccess: false,
    gameKeywords: ['steam'],
  }));
}

function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const requestOptions = { hostname: '127.0.0.1', port, path: pathname, ...options };
    const request = http.request(requestOptions, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await request('/api/ping');
      if (response.statusCode === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw lastError || new Error('サーバーが起動しませんでした。');
}

async function main() {
  createFixture();
  const child = spawn(process.execPath, ['app/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PC_POWER_DB: dbPath,
      PC_POWER_CONFIG: configPath,
      PC_POWER_PORT: String(port),
      PC_POWER_HOST: '127.0.0.1',
    },
    stdio: 'ignore',
  });
  try {
    await waitForServer();

    const summaryResponse = await request('/api/summary?range=today');
    assert.equal(summaryResponse.statusCode, 200);
    const summary = JSON.parse(summaryResponse.body);
    assert.equal(Math.round(summary.current.watts), 135);
    assert.equal(summary.config.lanAccess, false);

    const accessResponse = await request('/api/access-info');
    assert.equal(accessResponse.statusCode, 200);
    assert.equal(JSON.parse(accessResponse.body).lanAccess, false);

    const blockedResponse = await request('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ lanAccess: true }),
    });
    assert.equal(blockedResponse.statusCode, 403);

    const settingsResponse = await request('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ lanAccess: true }),
    });
    assert.equal(settingsResponse.statusCode, 200);
    assert.equal(JSON.parse(settingsResponse.body).restartRequired, true);

    const htmlResponse = await request('/');
    assert.equal(htmlResponse.statusCode, 200);
    assert.match(htmlResponse.body, /このPCの電力のようす/);

    console.log('Smoke test passed.');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  fs.rmSync(temporaryDir, { recursive: true, force: true });
  process.exitCode = 1;
});
