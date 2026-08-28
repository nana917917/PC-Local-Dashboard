'use strict';

if (new URLSearchParams(location.search).get('embedded') === '1') document.body.classList.add('embedded');

const state = {
  result: null,
  nodeMap: new Map(),
  currentNode: null,
  visibleItems: [],
  largestFilter: '',
  polling: null,
};

const byId = (id) => document.getElementById(id);
const integer = new Intl.NumberFormat('ja-JP');
const oneDecimal = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const digits = index >= 3 ? 2 : index >= 2 ? 1 : 0;
  return `${size.toFixed(digits)} ${units[index]}`;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  if (seconds >= 60) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${seconds}秒`;
}

async function json(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function setStatus(text, type = '') {
  byId('statusText').textContent = text;
  byId('statusText').className = `status ${type}`;
}

async function loadDrives() {
  try {
    const { drives } = await json('/api/drives');
    const host = byId('driveList');
    if (!drives.length) {
      host.innerHTML = '<p class="muted">ドライブを取得できませんでした。下へ直接入力してください。</p>';
      return;
    }
    host.innerHTML = drives.map((drive, index) => {
      const used = drive.total > 0 ? drive.total - drive.free : 0;
      const percent = drive.total > 0 ? used / drive.total * 100 : 0;
      return `<button class="drive" data-drive-index="${index}">
        <strong>${escapeHtml(drive.path)} ${escapeHtml(drive.label)}</strong>
        <small>${drive.total ? `${formatBytes(used)} / ${formatBytes(drive.total)} 使用` : '容量情報なし'}</small>
        <div class="drive-meter"><span style="width:${Math.min(100, percent)}%"></span></div>
      </button>`;
    }).join('');
    host.querySelectorAll('[data-drive-index]').forEach((button) => {
      button.addEventListener('click', () => {
        host.querySelectorAll('.drive').forEach((item) => item.classList.toggle('active', item === button));
        byId('pathInput').value = drives[Number(button.dataset.driveIndex)].path;
      });
    });
    if (!byId('pathInput').value && drives[0]) {
      byId('pathInput').value = drives[0].path;
      host.querySelector('.drive')?.classList.add('active');
    }
  } catch (error) {
    byId('driveList').innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
  }
}

function buildNodeMap(root) {
  const map = new Map();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    map.set(node.path.toLowerCase(), node);
    stack.push(...(node.children || []));
  }
  return map;
}

function compactItems(node) {
  const all = [
    ...(node.children || []).filter((item) => item.size > 0).map((item) => ({ ...item, kind: 'folder' })),
    ...(node.fileGroups || []).filter((item) => item.size > 0),
  ].sort((a, b) => b.size - a.size);
  if (all.length <= 32) return all;
  const shown = all.slice(0, 31);
  const remainder = all.slice(31);
  shown.push({
    name: `その他 ${remainder.length}項目`,
    size: remainder.reduce((sum, item) => sum + item.size, 0),
    count: remainder.reduce((sum, item) => sum + Number(item.count || item.totalFileCount || 0), 0),
    kind: 'other',
  });
  return shown;
}

function binaryTreemap(items, x, y, width, height) {
  if (!items.length || width <= 0 || height <= 0) return [];
  if (items.length === 1) return [{ item: items[0], x, y, width, height }];
  const total = items.reduce((sum, item) => sum + item.size, 0);
  let split = 1;
  let accumulated = items[0].size;
  while (split < items.length - 1 && accumulated + items[split].size <= total / 2) {
    accumulated += items[split].size;
    split += 1;
  }
  const first = items.slice(0, split);
  const second = items.slice(split);
  const firstTotal = first.reduce((sum, item) => sum + item.size, 0);
  const ratio = total > 0 ? firstTotal / total : .5;
  if (width >= height) {
    const firstWidth = width * ratio;
    return [...binaryTreemap(first, x, y, firstWidth, height), ...binaryTreemap(second, x + firstWidth, y, width - firstWidth, height)];
  }
  const firstHeight = height * ratio;
  return [...binaryTreemap(first, x, y, width, firstHeight), ...binaryTreemap(second, x, y + firstHeight, width, height - firstHeight)];
}

function renderTreemap(node) {
  const host = byId('treemap');
  const items = compactItems(node);
  state.visibleItems = items;
  if (!items.length) {
    host.innerHTML = '<p class="muted" style="padding:20px">この階層には表示できるファイルがありません。</p>';
    return;
  }
  const rects = binaryTreemap(items, 0, 0, 100, 100);
  host.innerHTML = rects.map(({ item, x, y, width, height }) => {
    const index = items.indexOf(item);
    const tileClass = item.kind === 'folder' ? 'tile-folder' : item.kind === 'group' ? 'tile-group' : 'tile-other';
    const showDetail = width >= 12 && height >= 12;
    return `<button class="tile ${tileClass}" data-tile-index="${index}" style="left:${x}%;top:${y}%;width:${width}%;height:${height}%" title="${escapeHtml(item.name)} ${formatBytes(item.size)}">
      <strong>${escapeHtml(item.name)}</strong>
      ${showDetail ? `<small>${formatBytes(item.size)}</small>` : ''}
    </button>`;
  }).join('');
  host.querySelectorAll('[data-tile-index]').forEach((tile) => {
    tile.addEventListener('click', () => {
      const item = items[Number(tile.dataset.tileIndex)];
      if (item.kind === 'folder') setCurrentNode(item);
    });
  });
}

function lineage(node) {
  const result = [];
  let current = node;
  while (current) {
    result.unshift(current);
    current = current.parentPath ? state.nodeMap.get(current.parentPath.toLowerCase()) : null;
  }
  return result;
}

function renderBreadcrumbs(node) {
  const nodes = lineage(node);
  const host = byId('breadcrumbs');
  host.innerHTML = nodes.map((item, index) => `<button data-breadcrumb-index="${index}" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</button>`).join('<span class="muted">›</span>');
  host.querySelectorAll('[data-breadcrumb-index]').forEach((button) => {
    button.addEventListener('click', () => setCurrentNode(nodes[Number(button.dataset.breadcrumbIndex)]));
  });
}

function renderContents(node) {
  const items = [
    ...(node.children || []).filter((item) => item.size > 0).map((item) => ({ ...item, kind: 'folder' })),
    ...(node.fileGroups || []).filter((item) => item.size > 0),
  ].sort((a, b) => b.size - a.size);
  byId('contentsTitle').textContent = `${node.name} の中身`;
  const body = byId('contentRows');
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="4" class="muted">表示できる中身はありません。</td></tr>';
    return;
  }
  body.innerHTML = items.map((item, index) => {
    const percent = node.size > 0 ? item.size / node.size * 100 : 0;
    return `<tr data-content-index="${index}" class="${item.kind === 'folder' ? 'clickable' : ''}">
      <td class="content-name" title="${escapeHtml(item.path || item.name)}">${item.kind === 'folder' ? '📁 ' : ''}${escapeHtml(item.name)}</td>
      <td>${item.kind === 'folder' ? 'フォルダ' : `${integer.format(item.count || 0)}ファイル`}</td>
      <td>${formatBytes(item.size)}</td>
      <td>${oneDecimal.format(percent)}%</td>
    </tr>`;
  }).join('');
  body.querySelectorAll('[data-content-index]').forEach((row) => {
    row.addEventListener('dblclick', () => {
      const item = items[Number(row.dataset.contentIndex)];
      if (item.kind === 'folder') setCurrentNode(item);
    });
  });
}

function setCurrentNode(node) {
  const actual = state.nodeMap.get(node.path.toLowerCase()) || node;
  state.currentNode = actual;
  renderBreadcrumbs(actual);
  renderTreemap(actual);
  renderContents(actual);
}

function renderCategories(categories) {
  const host = byId('categoryList');
  host.innerHTML = categories.map((item) => `<div class="bar-item">
    <span>${escapeHtml(item.name)}</span><small>${formatBytes(item.size)}・${oneDecimal.format(item.percent)}%</small>
    <div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, item.percent)}%"></div></div>
  </div>`).join('');
}

function renderLargest() {
  const query = state.largestFilter.trim().toLowerCase();
  const items = (state.result?.largest || []).filter((item) => !query || `${item.name} ${item.path}`.toLowerCase().includes(query)).slice(0, 100);
  const body = byId('largestRows');
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">該当する項目はありません。</td></tr>';
    return;
  }
  body.innerHTML = items.map((item, index) => `<tr>
    <td class="content-name" title="${escapeHtml(item.name)}">${item.kind === 'folder' ? '📁 ' : ''}${escapeHtml(item.name)}</td>
    <td>${item.kind === 'folder' ? 'フォルダ' : (escapeHtml(item.extension) || 'ファイル')}</td>
    <td>${formatBytes(item.size)}</td>
    <td title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</td>
    <td><button class="link-button" data-open-index="${index}">開く</button></td>
  </tr>`).join('');
  body.querySelectorAll('[data-open-index]').forEach((button) => {
    button.addEventListener('click', () => openPath(items[Number(button.dataset.openIndex)].path));
  });
}

function renderComparison(comparison) {
  const panel = byId('comparisonPanel');
  if (!comparison) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const total = Number(comparison.totalDelta || 0);
  const totalHost = byId('totalDelta');
  totalHost.textContent = `${total >= 0 ? '+' : '-'}${formatBytes(Math.abs(total))}`;
  totalHost.classList.toggle('delta-negative', total < 0);
  const rows = comparison.changes || [];
  byId('comparisonRows').innerHTML = rows.length ? rows.map((item) => `<tr>
    <td class="content-name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</td>
    <td>${formatBytes(item.before)}</td><td>${formatBytes(item.after)}</td>
    <td class="${item.delta < 0 ? 'delta-negative' : 'delta-value'}">${item.delta >= 0 ? '+' : '-'}${formatBytes(Math.abs(item.delta))}</td>
  </tr>`).join('') : '<tr><td colspan="4" class="muted">1MB以上変化した上位フォルダはありません。</td></tr>';
}

function renderResult(result) {
  state.result = result;
  state.nodeMap = buildNodeMap(result.tree);
  byId('resultArea').classList.remove('hidden');
  byId('scannedSize').textContent = formatBytes(result.summary.scannedBytes);
  if (result.summary.driveTotal) {
    const used = result.summary.driveTotal - result.summary.driveFree;
    byId('driveUsage').textContent = `ドライブ全体 ${formatBytes(used)} / ${formatBytes(result.summary.driveTotal)}`;
  } else {
    byId('driveUsage').textContent = '選択範囲内の合計';
  }
  byId('fileCount').textContent = integer.format(result.summary.fileCount);
  byId('folderCount').textContent = integer.format(result.summary.folderCount);
  byId('skipCount').textContent = `読めなかった項目 ${integer.format(result.summary.skipped)}`;
  byId('scanDate').textContent = new Date(result.finishedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  byId('scanDuration').textContent = `所要 ${formatDuration(result.finishedAt - result.startedAt)}`;
  renderCategories(result.categories);
  renderComparison(result.comparison);
  setCurrentNode(result.tree);
  renderLargest();
  setStatus(`表示中：${result.rootPath}`, 'ok');
}

async function loadLastResult() {
  try {
    renderResult(await json('/api/result'));
  } catch (_) {
    setStatus('調べるドライブまたはフォルダを選んでください');
  }
}

async function pickFolder() {
  byId('pickButton').disabled = true;
  try {
    const selected = await json('/api/pick-folder', { method: 'POST' });
    if (selected.path) byId('pathInput').value = selected.path;
  } finally {
    byId('pickButton').disabled = false;
  }
}

async function startScan() {
  const targetPath = byId('pathInput').value.trim();
  if (!targetPath) throw new Error('調べる場所を指定してください。');
  await json('/api/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: targetPath }),
  });
  byId('scanButton').disabled = true;
  byId('progressArea').classList.remove('hidden');
  setStatus('スキャン中です');
  if (state.polling) clearInterval(state.polling);
  await pollStatus();
  state.polling = setInterval(pollStatus, 1000);
}

async function pollStatus() {
  try {
    const status = await json('/api/status');
    byId('progressText').textContent = `${integer.format(status.scannedFolders)}フォルダ・${integer.format(status.scannedFiles)}ファイル・${formatBytes(status.scannedBytes)}`;
    byId('currentPath').textContent = status.currentPath || '';
    if (status.status === 'ready') {
      clearInterval(state.polling);
      state.polling = null;
      byId('scanButton').disabled = false;
      byId('progressArea').classList.add('hidden');
      renderResult(await json('/api/result'));
    } else if (status.status === 'error') {
      clearInterval(state.polling);
      state.polling = null;
      byId('scanButton').disabled = false;
      byId('progressArea').classList.add('hidden');
      setStatus(status.error || 'スキャンに失敗しました', 'error');
    }
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

async function openPath(targetPath) {
  await json('/api/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: targetPath }),
  });
}

async function openPowerDashboard() {
  const button = byId('powerButton');
  button.disabled = true;
  button.textContent = '起動中…';
  try {
    await json('/api/open-power', { method: 'POST' });
  } finally {
    button.disabled = false;
    button.textContent = '電気代へ戻る';
  }
}

byId('powerButton').addEventListener('click', () => openPowerDashboard().catch((error) => alert(error.message)));
byId('pickButton').addEventListener('click', () => pickFolder().catch((error) => alert(error.message)));
byId('scanButton').addEventListener('click', () => startScan().catch((error) => {
  byId('scanButton').disabled = false;
  setStatus(error.message, 'error');
}));
byId('openFolderButton').addEventListener('click', () => state.currentNode && openPath(state.currentNode.path).catch((error) => alert(error.message)));
byId('largestFilter').addEventListener('input', (event) => {
  state.largestFilter = event.target.value;
  renderLargest();
});

Promise.all([loadDrives(), loadLastResult()]);
setInterval(() => { if (!document.hidden) json('/api/status').catch(() => {}); }, 60000);
