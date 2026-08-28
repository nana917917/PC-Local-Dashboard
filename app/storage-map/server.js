'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DATA_DIR = process.env.PC_STORAGE_DATA || path.join(APP_DIR, 'data');
const RESULT_PATH = path.join(DATA_DIR, 'last-scan.json');
const PID_PATH = path.join(APP_DIR, 'storage-map.pid');
const POWER_DASHBOARD_PATH = path.resolve(APP_DIR, '..', 'dashboard.vbs');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PC_STORAGE_PORT || 17892);
const LARGE_FILE_BYTES = 64 * 1024 * 1024;
const FILE_STAT_BATCH = 96;
const DIRECTORY_BATCH = 12;

let lastActivity = Date.now();
let lastResult = loadLastResult();
let job = {
  status: lastResult ? 'ready' : 'idle',
  startedAt: null,
  finishedAt: lastResult?.finishedAt || null,
  rootPath: lastResult?.rootPath || null,
  scannedFiles: lastResult?.summary?.fileCount || 0,
  scannedFolders: lastResult?.summary?.folderCount || 0,
  scannedBytes: lastResult?.summary?.scannedBytes || 0,
  skipped: lastResult?.summary?.skipped || 0,
  currentPath: '',
  error: null,
};

const EXTENSION_GROUPS = [
  ['動画', new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.m2ts', '.ts'])],
  ['音楽・音声', new Set(['.wav', '.flac', '.mp3', '.aac', '.m4a', '.ogg', '.opus'])],
  ['画像', new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.raw'])],
  ['圧縮・バックアップ', new Set(['.zip', '.7z', '.rar', '.tar', '.gz', '.bak', '.backup'])],
  ['ディスク・インストーラー', new Set(['.iso', '.img', '.vhd', '.vhdx', '.msi', '.exe', '.cab'])],
  ['文書', new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md'])],
  ['制作・開発', new Set(['.psd', '.aep', '.blend', '.flp', '.als', '.rpp', '.py', '.js', '.ts', '.c', '.cpp', '.cs', '.java'])],
];

function loadLastResult() {
  try {
    return JSON.parse(fs.readFileSync(RESULT_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    return null;
  }
}

function saveLastResult(result) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${RESULT_PATH}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(result), 'utf8');
  fs.renameSync(temporary, RESULT_PATH);
}

function buildComparison(previous, current) {
  if (!previous || normalizeForCompare(previous.rootPath) !== normalizeForCompare(current.rootPath)) return null;
  const previousItems = new Map((previous.largest || []).filter((item) => item.kind === 'folder').map((item) => [normalizeForCompare(item.path), item]));
  const changes = (current.largest || [])
    .filter((item) => item.kind === 'folder')
    .map((item) => ({ name: item.name, path: item.path, before: Number(previousItems.get(normalizeForCompare(item.path))?.size || 0), after: Number(item.size || 0) }))
    .map((item) => ({ ...item, delta: item.after - item.before }))
    .filter((item) => Math.abs(item.delta) >= 1024 * 1024)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 20);
  const previousCategories = new Map((previous.categories || []).map((item) => [item.name, Number(item.size || 0)]));
  const categories = (current.categories || []).map((item) => ({
    name: item.name,
    before: previousCategories.get(item.name) || 0,
    after: Number(item.size || 0),
    delta: Number(item.size || 0) - (previousCategories.get(item.name) || 0),
  })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return {
    previousFinishedAt: previous.finishedAt,
    totalDelta: Number(current.summary.scannedBytes || 0) - Number(previous.summary?.scannedBytes || 0),
    changes,
    categories,
  };
}

function normalizeForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(root, candidate) {
  const normalizedRoot = normalizeForCompare(root);
  const normalizedCandidate = normalizeForCompare(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function categoryFor(filePath, extension) {
  const normalized = String(filePath).toLowerCase().replaceAll('/', '\\');
  const gameMarkers = [
    '\\steamapps\\common\\', '\\epic games\\', '\\riot games\\', '\\xboxgames\\',
    '\\games\\', '\\terraria\\', '\\darkanddarker\\', '\\metal gear', '\\earth defense force',
  ];
  if (gameMarkers.some((marker) => normalized.includes(marker))) return 'ゲーム';
  for (const [label, extensions] of EXTENSION_GROUPS) {
    if (extensions.has(extension)) return label;
  }
  if (normalized.includes('\\windows\\') || normalized.includes('\\program files\\') || normalized.includes('\\appdata\\')) {
    return 'Windows・アプリ';
  }
  return 'その他';
}

async function statFileBatch(directory, entries, node, totals, largeFiles) {
  for (let start = 0; start < entries.length; start += FILE_STAT_BATCH) {
    const batch = entries.slice(start, start + FILE_STAT_BATCH);
    const settled = await Promise.allSettled(batch.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      const stat = await fsp.stat(fullPath);
      return { entry, fullPath, stat };
    }));
    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled') {
        totals.skipped += 1;
        continue;
      }
      const { entry, fullPath, stat } = outcome.value;
      if (!stat.isFile()) continue;
      const size = Number(stat.size || 0);
      const extension = path.extname(entry.name).toLowerCase() || '拡張子なし';
      const category = categoryFor(fullPath, extension);
      node.directSize += size;
      node.fileCount += 1;
      totals.files += 1;
      totals.bytes += size;
      totals.categories.set(category, (totals.categories.get(category) || 0) + size);
      const group = node.fileGroupMap.get(category) || { name: category, size: 0, count: 0, kind: 'group' };
      group.size += size;
      group.count += 1;
      node.fileGroupMap.set(category, group);
      if (size >= LARGE_FILE_BYTES) {
        largeFiles.push({ name: entry.name, path: fullPath, parentPath: directory, size, extension, modifiedAt: stat.mtimeMs, kind: 'file' });
      }
    }
  }
}

async function scanOneDirectory(node, queue, nodes, totals, largeFiles) {
  job.currentPath = node.path;
  let entries;
  try {
    entries = await fsp.readdir(node.path, { withFileTypes: true });
  } catch (_) {
    totals.skipped += 1;
    node.inaccessible = true;
    return;
  }
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      totals.skipped += 1;
      continue;
    }
    if (entry.isDirectory()) {
      const childPath = path.join(node.path, entry.name);
      const child = {
        name: entry.name,
        path: childPath,
        parentPath: node.path,
        size: 0,
        directSize: 0,
        fileCount: 0,
        totalFileCount: 0,
        totalFolderCount: 0,
        children: [],
        fileGroups: [],
        fileGroupMap: new Map(),
        inaccessible: false,
      };
      node.children.push(child);
      nodes.push(child);
      queue.push(child);
    } else if (entry.isFile()) {
      files.push(entry);
    }
  }
  await statFileBatch(node.path, files, node, totals, largeFiles);
  totals.folders += 1;
  job.scannedFiles = totals.files;
  job.scannedFolders = totals.folders;
  job.scannedBytes = totals.bytes;
  job.skipped = totals.skipped;
}

function finalizeTree(nodes) {
  const sorted = [...nodes].sort((a, b) => b.path.length - a.path.length);
  const byPath = new Map(nodes.map((node) => [normalizeForCompare(node.path), node]));
  for (const node of sorted) {
    node.size += node.directSize;
    node.totalFileCount += node.fileCount;
    node.fileGroups = [...node.fileGroupMap.values()].sort((a, b) => b.size - a.size);
    delete node.fileGroupMap;
    if (node.parentPath) {
      const parent = byPath.get(normalizeForCompare(node.parentPath));
      if (parent) {
        parent.size += node.size;
        parent.totalFileCount += node.totalFileCount;
        parent.totalFolderCount += node.totalFolderCount + 1;
      }
    }
    node.children.sort((a, b) => b.size - a.size);
  }
}

async function driveSpace(rootPath) {
  try {
    const stat = await fsp.statfs(rootPath);
    return {
      total: Number(stat.blocks) * Number(stat.bsize),
      free: Number(stat.bavail) * Number(stat.bsize),
    };
  } catch (_) {
    return { total: null, free: null };
  }
}

async function scanPath(rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  const stat = await fsp.stat(resolvedRoot);
  if (!stat.isDirectory()) throw new Error('フォルダではありません。');

  const root = {
    name: path.basename(resolvedRoot) || resolvedRoot,
    path: resolvedRoot,
    parentPath: null,
    size: 0,
    directSize: 0,
    fileCount: 0,
    totalFileCount: 0,
    totalFolderCount: 0,
    children: [],
    fileGroups: [],
    fileGroupMap: new Map(),
    inaccessible: false,
  };
  const nodes = [root];
  const queue = [root];
  const totals = { files: 0, folders: 0, bytes: 0, skipped: 0, categories: new Map() };
  const largeFiles = [];

  while (queue.length > 0) {
    const batch = queue.splice(0, DIRECTORY_BATCH);
    await Promise.all(batch.map((node) => scanOneDirectory(node, queue, nodes, totals, largeFiles)));
  }

  finalizeTree(nodes);
  const space = await driveSpace(resolvedRoot);
  const categories = [...totals.categories.entries()]
    .map(([name, size]) => ({ name, size, percent: totals.bytes > 0 ? size / totals.bytes * 100 : 0 }))
    .sort((a, b) => b.size - a.size);
  const largestFolders = nodes
    .filter((node) => node !== root && node.size > 0)
    .sort((a, b) => b.size - a.size)
    .slice(0, 120)
    .map((node) => ({ name: node.name, path: node.path, parentPath: node.parentPath, size: node.size, fileCount: node.totalFileCount, folderCount: node.totalFolderCount, kind: 'folder' }));
  largeFiles.sort((a, b) => b.size - a.size);
  const finishedAt = Date.now();
  return {
    version: 1,
    rootPath: resolvedRoot,
    startedAt: job.startedAt,
    finishedAt,
    summary: {
      scannedBytes: totals.bytes,
      fileCount: totals.files,
      folderCount: totals.folders,
      skipped: totals.skipped,
      driveTotal: space.total,
      driveFree: space.free,
    },
    categories,
    tree: root,
    largest: [...largestFolders, ...largeFiles.slice(0, 180)].sort((a, b) => b.size - a.size).slice(0, 200),
  };
}

function startScan(rootPath) {
  if (job.status === 'scanning') throw Object.assign(new Error('現在スキャン中です。'), { statusCode: 409 });
  job = {
    status: 'scanning', startedAt: Date.now(), finishedAt: null, rootPath,
    scannedFiles: 0, scannedFolders: 0, scannedBytes: 0, skipped: 0, currentPath: rootPath, error: null,
  };
  const previousResult = lastResult;
  scanPath(rootPath).then((result) => {
    result.comparison = buildComparison(previousResult, result);
    lastResult = result;
    saveLastResult(result);
    job.status = 'ready';
    job.finishedAt = result.finishedAt;
    job.rootPath = result.rootPath;
    job.currentPath = '';
  }).catch((error) => {
    job.status = 'error';
    job.error = error.message || String(error);
    job.currentPath = '';
  });
}

function powershell(command) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-Command', command], { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout.trim());
    });
  });
}

async function listDrives() {
  if (process.platform !== 'win32') {
    return [{ path: path.parse(process.cwd()).root, label: os.hostname(), total: null, free: null }];
  }
  const output = await powershell("Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object @{N='path';E={$_.DeviceID+'\\'}},VolumeName,@{N='total';E={[double]$_.Size}},@{N='free';E={[double]$_.FreeSpace}} | ConvertTo-Json -Compress");
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((drive) => ({
    path: drive.path,
    label: drive.VolumeName || 'ローカルディスク',
    total: Number(drive.total || 0),
    free: Number(drive.free || 0),
  }));
}

async function pickFolder() {
  if (process.platform !== 'win32') return process.cwd();
  const command = "$shell=New-Object -ComObject Shell.Application; $folder=$shell.BrowseForFolder(0,'調べるドライブまたはフォルダを選択してください',0,0); if($folder){$folder.Self.Path}";
  return powershell(command);
}

function openPowerDashboard() {
  if (process.platform !== 'win32' || !fs.existsSync(POWER_DASHBOARD_PATH)) {
    const error = new Error('PC電気代画面が見つかりません。統合版のSETUP.cmdをもう一度実行してください。');
    error.statusCode = 503;
    throw error;
  }
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const wscriptPath = path.join(systemRoot, 'System32', 'wscript.exe');
  execFile(wscriptPath, [POWER_DASHBOARD_PATH], { windowsHide: true }, () => {});
  return { opened: true, url: 'http://127.0.0.1:17891' };
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

function serveStatic(requestPath, res) {
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(`${path.resolve(PUBLIC_DIR)}${path.sep}`) && resolved !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }[path.extname(resolved)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
  fs.createReadStream(resolved).pipe(res);
}

function readBody(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('送信内容が大きすぎます。'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  lastActivity = Date.now();
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/drives') {
      jsonResponse(res, 200, { drives: await listDrives() }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      jsonResponse(res, 200, job); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/result') {
      if (!lastResult) {
        jsonResponse(res, 404, { error: '保存されたスキャン結果はまだありません。' });
      } else {
        jsonResponse(res, 200, lastResult);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/pick-folder') {
      const selectedPath = await pickFolder();
      jsonResponse(res, 200, { path: selectedPath || null }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/open-power') {
      jsonResponse(res, 200, openPowerDashboard()); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/scan') {
      const input = JSON.parse(await readBody(req));
      if (!input.path || typeof input.path !== 'string') throw Object.assign(new Error('調べる場所を指定してください。'), { statusCode: 400 });
      startScan(input.path);
      jsonResponse(res, 202, { status: 'scanning' }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/open') {
      const input = JSON.parse(await readBody(req));
      if (!lastResult || !input.path || !isInside(lastResult.rootPath, input.path) || !fs.existsSync(input.path)) {
        throw Object.assign(new Error('開けるのは現在のスキャン範囲内だけです。'), { statusCode: 400 });
      }
      if (process.platform === 'win32') execFile('explorer.exe', [input.path], { windowsHide: true }, () => {});
      jsonResponse(res, 200, { opened: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/clear') {
      if (job.status === 'scanning') throw Object.assign(new Error('スキャン中は削除できません。'), { statusCode: 409 });
      lastResult = null;
      try { if (fs.existsSync(RESULT_PATH)) fs.unlinkSync(RESULT_PATH); } catch (_) {}
      job = { status: 'idle', startedAt: null, finishedAt: null, rootPath: null, scannedFiles: 0, scannedFolders: 0, scannedBytes: 0, skipped: 0, currentPath: '', error: null };
      jsonResponse(res, 200, { cleared: true }); return;
    }
    if (req.method === 'GET') {
      serveStatic(url.pathname, res); return;
    }
    res.writeHead(405); res.end('Method not allowed');
  } catch (error) {
    jsonResponse(res, error.statusCode || 500, { error: error.message || String(error) });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    if (process.platform === 'win32') execFile('explorer.exe', [`http://${HOST}:${PORT}`], () => process.exit(0));
    else process.exit(0);
  } else {
    process.exitCode = 1;
  }
});

server.listen(PORT, HOST, () => {
  try { fs.writeFileSync(PID_PATH, String(process.pid), 'utf8'); } catch (_) {}
  if (process.platform === 'win32' && process.env.PC_STORAGE_EMBEDDED !== '1') execFile('explorer.exe', [`http://${HOST}:${PORT}`], () => {});
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
  if (job.status !== 'scanning' && Date.now() - lastActivity > 10 * 60 * 1000) {
    clearInterval(idleTimer);
    server.close(() => process.exit(0));
  }
}, 30 * 1000);
idleTimer.unref();
