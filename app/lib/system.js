'use strict';

// PC状態（CPU/GPU/メモリ/ストレージ/ネットワーク/稼働時間/温度/ファン/クロック/ドライブ）の取得。
// 取得できないものは 0 にせず、状態（未取得・利用不可・非対応・エラー）と取得元を返す。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { hasTable, tableColumns, firstExistingColumn, hasTimestampTable } = require('./db');

function execFileText(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 6000, maxBuffer: 1024 * 1024, ...options }, (error, stdout) => {
      resolve(error ? '' : String(stdout || '').trim());
    });
  });
}

function item(partial) {
  return {
    key: partial.key,
    label: partial.label,
    group: partial.group,
    value: partial.value ?? null,
    unit: partial.unit || null,
    text: partial.text ?? null,
    status: partial.status || 'ok',
    source: partial.source || null,
    updatedAt: partial.updatedAt ?? Date.now(),
    note: partial.note || null,
    historyKey: partial.historyKey || null,
  };
}

let previousCpuTimes = null;
function cpuUsagePercent() {
  const cpus = os.cpus();
  const totals = cpus.reduce((sum, cpu) => {
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

async function gpuStatus() {
  const output = await execFileText('nvidia-smi.exe', [
    '--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw,clocks.sm',
    '--format=csv,noheader,nounits',
  ]);
  if (!output) {
    return {
      available: false,
      status: process.platform === 'win32' ? 'unavailable' : 'unsupported',
      note: 'nvidia-smiを実行できないためGPU詳細は取得していません（NVIDIA以外のGPU、またはドライバ未導入の可能性があります）。',
      gpus: [],
    };
  }
  const rows = output.split(/\r?\n/).filter(Boolean).map((line) => line.split(',').map((value) => value.trim()));
  if (!rows.length) {
    return { available: false, status: 'error', note: 'nvidia-smiの出力を解釈できませんでした。', gpus: [] };
  }
  const numbers = (index) => rows.map((values) => Number(values[index])).filter(Number.isFinite);
  const sum = (values) => (values.length ? values.reduce((total, value) => total + value, 0) : null);
  const maximum = (values) => (values.length ? Math.max(...values) : null);
  const gpus = rows.map((values) => ({
    name: values[0] || 'GPU',
    usagePercent: Number.isFinite(Number(values[1])) ? Number(values[1]) : null,
    temperatureC: Number.isFinite(Number(values[2])) ? Number(values[2]) : null,
    memoryUsedMb: Number.isFinite(Number(values[3])) ? Number(values[3]) : null,
    memoryTotalMb: Number.isFinite(Number(values[4])) ? Number(values[4]) : null,
    powerWatts: Number.isFinite(Number(values[5])) ? Number(values[5]) : null,
    clockMhz: Number.isFinite(Number(values[6])) ? Number(values[6]) : null,
  }));
  return {
    available: true,
    status: 'ok',
    count: gpus.length,
    name: gpus.length > 1 ? `${gpus.length}基（${gpus.map((gpu) => gpu.name).join(' / ')}）` : gpus[0].name,
    usagePercent: maximum(numbers(1)),
    temperatureC: maximum(numbers(2)),
    memoryUsedMb: sum(numbers(3)),
    memoryTotalMb: sum(numbers(4)),
    powerWatts: sum(numbers(5)),
    clockMhz: maximum(numbers(6)),
    gpus,
    source: 'nvidia-smi',
  };
}

async function driveStatus() {
  if (process.platform !== 'win32') {
    try {
      const stat = fs.statfsSync(path.parse(process.cwd()).root);
      return {
        status: 'ok',
        drives: [{ path: '/', label: os.hostname(), total: Number(stat.blocks) * Number(stat.bsize), free: Number(stat.bavail) * Number(stat.bsize), health: null }],
      };
    } catch (error) {
      return { status: 'error', drives: [], note: 'ドライブ情報を取得できませんでした。' };
    }
  }
  const script = "$logical=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object @{N='path';E={$_.DeviceID+'\\'}},VolumeName,@{N='total';E={[double]$_.Size}},@{N='free';E={[double]$_.FreeSpace}});"
    + " $physical=@(Get-PhysicalDisk -ErrorAction SilentlyContinue | Select-Object FriendlyName,MediaType,HealthStatus,OperationalStatus,@{N='size';E={[double]$_.Size}});"
    + " [pscustomobject]@{logical=$logical; physical=$physical} | ConvertTo-Json -Compress";
  const output = await execFileText('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script]);
  if (!output) return { status: 'error', drives: [], note: 'Windowsからドライブ情報を取得できませんでした。' };
  try {
    const parsed = JSON.parse(output);
    const physical = Array.isArray(parsed.physical) ? parsed.physical : parsed.physical ? [parsed.physical] : [];
    const healthKnown = physical.filter((drive) => drive.HealthStatus);
    const health = healthKnown.length
      ? (healthKnown.every((drive) => String(drive.HealthStatus).toLowerCase() === 'healthy') ? '正常' : '要確認')
      : null;
    const logical = Array.isArray(parsed.logical) ? parsed.logical : parsed.logical ? [parsed.logical] : [];
    return {
      status: 'ok',
      physical,
      health,
      healthNote: healthKnown.length ? null : 'ドライブ健康状態はこの環境では取得できません（管理者権限が必要な場合があります）。',
      drives: logical.map((drive) => ({
        path: String(drive.path || ''),
        label: String(drive.VolumeName || 'ローカルディスク'),
        total: Number(drive.total || 0),
        free: Number(drive.free || 0),
        health,
      })),
    };
  } catch (error) {
    return { status: 'error', drives: [], note: 'ドライブ情報の解析に失敗しました。' };
  }
}

function wattSealState(db, taskOutput) {
  let latestAt = null;
  try {
    if (hasTimestampTable(db)) latestAt = db.prepare('SELECT MAX(timestamp) AS value FROM timestamp').get()?.value ?? null;
  } catch (_) {}
  const running = process.platform === 'win32'
    ? /WattSeal\.exe/i.test(String(taskOutput || ''))
    : Boolean(latestAt);
  const ageSeconds = latestAt ? Math.max(0, (Date.now() - Number(latestAt)) / 1000) : null;
  const status = !latestAt ? 'unavailable' : !running ? 'error' : ageSeconds > 60 ? 'stale' : 'ok';
  return {
    running,
    latestSample: latestAt ? Number(latestAt) : null,
    ageSeconds,
    status,
    note: running ? null : 'WattSeal.exeの動作を確認できません。自動記録が停止している可能性があります。',
  };
}

// 使用率履歴（DBに列がある場合のみ）
function usageHistory(db, range) {
  const start = range === 'today' ? new Date(new Date().setHours(0, 0, 0, 0)).getTime() : Date.now() - 15 * 60000;
  const bucketMs = range === 'today' ? 5 * 60000 : 15000;
  const definitions = [
    ['cpu_data', 'cpu', ['usage_percent', 'usage_percentage', 'cpu_usage_percent', 'cpu_usage_percentage', 'usage']],
    ['gpu_data', 'gpu', ['usage_percent', 'usage_percentage', 'gpu_usage_percent', 'gpu_usage_percentage', 'usage']],
    ['ram_data', 'ram', ['usage_percent', 'usage_percentage', 'ram_usage_percent', 'ram_usage_percentage', 'usage']],
  ];
  const merged = new Map();
  const availability = {};
  for (const [table, key, candidates] of definitions) {
    if (!hasTable(db, table)) { availability[key] = { available: false, reason: 'table-missing' }; continue; }
    const column = firstExistingColumn(tableColumns(db, table), candidates);
    if (!column) { availability[key] = { available: false, reason: 'column-missing' }; continue; }
    const rows = db.prepare(`SELECT CAST(t.timestamp / ? AS INTEGER) * ? AS stamp, AVG(d.${column}) AS value
                                FROM timestamp t JOIN ${table} d ON d.timestamp_id = t.id
                               WHERE t.timestamp >= ? GROUP BY stamp ORDER BY stamp`).all(bucketMs, bucketMs, start);
    availability[key] = { available: true, points: rows.length, column };
    for (const row of rows) {
      const point = merged.get(Number(row.stamp)) || { timestamp: Number(row.stamp), cpu: null, gpu: null, ram: null };
      point[key] = row.value == null ? null : Number(row.value);
      merged.set(Number(row.stamp), point);
    }
  }
  return { points: [...merged.values()].sort((a, b) => a.timestamp - b.timestamp), availability };
}

function networkStatus(db) {
  if (!hasTable(db, 'network_data') || !hasTimestampTable(db)) {
    return item({ key: 'network', label: 'ネットワーク', group: 'network', status: 'unavailable', text: '未取得', note: 'WattSeal DBにネットワーク情報のテーブルがありません。' });
  }
  const columns = tableColumns(db, 'network_data');
  const download = firstExistingColumn(columns, ['download_speed_mb_s']);
  const upload = firstExistingColumn(columns, ['upload_speed_mb_s']);
  if (!download && !upload) {
    return item({ key: 'network', label: 'ネットワーク', group: 'network', status: 'unavailable', text: '未取得', note: 'WattSeal DBに通信速度の列がありません。' });
  }
  const row = db.prepare(`SELECT t.timestamp AS timestamp, ${download ? `d.${download}` : 'NULL'} AS download, ${upload ? `d.${upload}` : 'NULL'} AS upload
                            FROM timestamp t JOIN network_data d ON d.timestamp_id = t.id
                           ORDER BY t.timestamp DESC LIMIT 1`).get();
  if (!row) {
    return item({ key: 'network', label: 'ネットワーク', group: 'network', status: 'unavailable', text: '未取得', note: '通信速度の記録がありません。' });
  }
  return item({
    key: 'network',
    label: 'ネットワーク',
    group: 'network',
    status: 'ok',
    value: row.download == null ? null : Number(row.download),
    text: `下り ${row.download == null ? '--' : Number(row.download).toFixed(2)} MB/s・上り ${row.upload == null ? '--' : Number(row.upload).toFixed(2)} MB/s`,
    source: 'WattSeal記録の直近値',
    updatedAt: Number(row.timestamp),
    note: '電力ではありません。直近の記録時点の通信速度です。',
  });
}

async function systemPayload({ db, config, range = '15m' }) {
  const [gpu, drives, wattsealTask] = await Promise.all([
    gpuStatus(),
    driveStatus(),
    process.platform === 'win32' ? execFileText('tasklist.exe', ['/FI', 'IMAGENAME eq WattSeal.exe', '/NH']) : Promise.resolve(''),
  ]);

  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const cpuName = os.cpus()[0]?.model || 'CPU';
  const cpuSpeedMhz = os.cpus()[0]?.speed || null;
  const usage = usageHistory(db, range === 'today' ? 'today' : '15m');
  const wattseal = wattSealState(db, wattsealTask);

  let hardware = null;
  try {
    if (hasTable(db, 'hardware_info')) {
      const row = db.prepare('SELECT hardware_data FROM hardware_info ORDER BY id DESC LIMIT 1').get();
      if (row?.hardware_data) hardware = JSON.parse(row.hardware_data);
    }
  } catch (_) {}

  const cpuPercent = cpuUsagePercent();
  const items = [
    item({
      key: 'cpu', label: 'CPU使用率', group: 'cpu', status: cpuPercent == null ? 'pending' : 'ok',
      value: cpuPercent, unit: '%', text: cpuName, source: 'WindowsのCPU時間', historyKey: usage.availability.cpu?.available ? 'cpu' : null,
      note: cpuPercent == null ? '次回の取得で数値が出ます。' : null,
    }),
    item({
      key: 'cpu_clock', label: 'CPUクロック', group: 'clock', status: cpuSpeedMhz ? 'ok' : 'unavailable',
      value: cpuSpeedMhz, unit: 'MHz', text: cpuSpeedMhz ? `${Math.round(cpuSpeedMhz)} MHz` : '未取得', source: 'WindowsのCPU情報',
      note: hardware?.cpu?.base_frequency_mhz ? `基本クロック ${hardware.cpu.base_frequency_mhz} MHz` : null,
    }),
    item({
      key: 'gpu', label: 'GPU使用率', group: 'gpu', status: gpu.available ? 'ok' : gpu.status,
      value: gpu.usagePercent ?? null, unit: '%', text: gpu.available ? gpu.name : '未取得', source: 'nvidia-smi', note: gpu.available ? null : gpu.note,
      historyKey: usage.availability.gpu?.available ? 'gpu' : null,
    }),
    item({
      key: 'gpu_clock', label: 'GPUクロック', group: 'clock', status: gpu.available && gpu.clockMhz != null ? 'ok' : gpu.status,
      value: gpu.clockMhz ?? null, unit: 'MHz', text: gpu.clockMhz != null ? `${Math.round(gpu.clockMhz)} MHz` : '未取得', source: 'nvidia-smi',
      note: gpu.available && gpu.clockMhz == null ? 'このGPUでは取得できません。' : null,
    }),
    item({
      key: 'ram', label: 'メモリ使用率', group: 'memory', status: 'ok',
      value: totalMemory ? (totalMemory - freeMemory) / totalMemory * 100 : null, unit: '%',
      text: `${(totalMemory / 1024 ** 3).toFixed(1)} GB中 ${((totalMemory - freeMemory) / 1024 ** 3).toFixed(1)} GB使用`,
      source: 'Windowsのメモリ情報', historyKey: usage.availability.ram?.available ? 'ram' : null,
    }),
    item({
      key: 'cpu_temperature', label: 'CPU温度', group: 'temperature', status: 'unsupported',
      text: '未対応', note: 'CPU温度はWindows標準の機能では取得できません（対応ツールが未導入です）。',
    }),
    item({
      key: 'gpu_temperature', label: 'GPU温度', group: 'temperature', status: gpu.available && gpu.temperatureC != null ? 'ok' : gpu.status,
      value: gpu.temperatureC ?? null, unit: '℃', text: gpu.temperatureC != null ? `${gpu.temperatureC} ℃` : '未取得', source: 'nvidia-smi',
    }),
    item({
      key: 'fan', label: 'ファン回転数', group: 'fan', status: 'unsupported',
      text: '未対応', note: 'ファン回転数は対応ツールが未導入のため取得していません。',
    }),
    item({
      key: 'uptime', label: 'PC稼働時間', group: 'uptime', status: 'ok', value: os.uptime(), unit: '秒',
      text: null, source: 'Windowsの起動情報',
    }),
    item({
      key: 'storage', label: 'ドライブ', group: 'storage', status: drives.status,
      text: drives.drives.length ? `${drives.drives.length}台` : '未取得', source: 'Windowsのドライブ情報', note: drives.note || null,
    }),
    networkStatus(db),
    item({
      key: 'drive_health', label: 'ドライブ健康状態', group: 'storage',
      status: drives.health ? 'ok' : (drives.status === 'ok' ? 'unavailable' : drives.status),
      text: drives.health || '未取得', source: 'Get-PhysicalDisk', note: drives.healthNote || null,
    }),
    item({
      key: 'wattseal', label: 'WattSeal記録', group: 'collector', status: wattseal.status,
      value: wattseal.ageSeconds, unit: '秒', text: wattseal.running ? '記録中' : '停止中', source: 'プロセス確認とDBの最終記録',
      updatedAt: wattseal.latestSample ?? null, note: wattseal.note,
    }),
  ];

  return {
    generatedAt: Date.now(),
    items,
    cpu: { name: cpuName, usagePercent: cpuPercent, clockMhz: cpuSpeedMhz, cores: os.cpus().length, hardware: hardware?.cpu || null },
    ram: { totalBytes: totalMemory, usedBytes: totalMemory - freeMemory, usagePercent: totalMemory ? (totalMemory - freeMemory) / totalMemory * 100 : null },
    gpu: gpu.available ? gpu : { available: false, status: gpu.status, note: gpu.note },
    drives: drives.drives,
    driveStatus: { status: drives.status, health: drives.health || null, note: drives.note || drives.healthNote || null, physical: drives.physical || [] },
    uptimeSeconds: os.uptime(),
    wattseal,
    usageHistory: usage.points,
    usageAvailability: usage.availability,
    hardware,
    notes: [
      'CPU・GPU・メモリはWindowsとnvidia-smiから取得した現在値です。',
      '温度・ファン・クロックは、対応ツールが無い項目は「未対応」として0では表示しません。',
    ],
  };
}

module.exports = { cpuUsagePercent, driveStatus, execFileText, gpuStatus, systemPayload, usageHistory };
