// 画面全体の起動と、タブ・期間・更新タイマーの管理。

import { getJson, download } from './api.js';
import { dateTime, escapeHtml, granularityLabel, money, percent, watts } from './format.js';
import { createHomeView } from './views/home.js';
import { createHistoryView } from './views/history.js';
import { createSessionsView } from './views/sessions.js';
import { createSystemView } from './views/system.js';
import { createStorageView } from './views/storage.js';
import { createSettingsView } from './views/settings.js';

const byId = (id) => document.getElementById(id);

const state = {
  view: 'home',
  range: 'today',
  metric: 'watts',
  compare: 'previous',
  liveMinutes: 15,
  systemRange: '15m',
  sessionDays: 30,
  customFrom: '',
  customTo: '',
  granularityOverride: '',
  storageStarted: false,
  summary: null,
  realtime: null,
  history: null,
  sessions: null,
  system: null,
  access: null,
  config: null,
  timers: { summary: null, realtime: null, system: null, storage: null },
  loadToken: 0,
  firstSummaryLoaded: false,
};

const helpers = {
  setStatus(text, type = '') {
    const host = byId('statusText');
    host.textContent = text;
    host.className = `status ${type}`;
  },
  renderWarnings(warnings) {
    const host = byId('warningList');
    const items = (warnings || []).slice(0, 6);
    host.innerHTML = items.map((warning) => `<p class="${warning.level === 'info' ? 'info' : ''}">${escapeHtml(warning.text)}</p>`).join('');
    host.hidden = items.length === 0;
  },
  setStateChips(data) {
    const current = data.current || {};
    const quality = data.quality || {};
    const comparison = data.comparison || {};
    const stateChip = byId('stateChip');
    const fresh = current.watts != null && current.reason === 'fresh';
    stateChip.textContent = fresh ? '記録中' : current.watts == null ? 'WattSeal未接続の可能性' : 'データが古い';
    stateChip.className = `chip ${fresh ? '' : 'warn'}`;
    byId('sampleChip').textContent = current.timestamp
      ? `最終取得: ${current.ageSeconds < 90 ? `${Math.round(current.ageSeconds)}秒前` : dateTime(current.timestamp, { short: true })}`
      : '最終取得: --';
    byId('qualityChip').textContent = `データ品質: 記録率 ${percent(quality.coveragePercent)}${quality.rollupBuckets > 0 ? '（1時間平均を含む）' : ''}`;
    byId('qualityChip').className = `chip ${quality.coveragePercent >= 95 ? 'muted' : 'warn'}`;
    byId('compareChip').textContent = comparison.comparable
      ? `比較: ${comparison.label}と比較可能`
      : `比較: ${comparison.status === 'no-previous-data' ? '比較データなし' : comparison.status === 'insufficient-data' ? '記録不足で比較しない' : '比較しません'}`;
    byId('compareChip').className = `chip ${comparison.comparable ? 'muted' : 'muted'}`;
    byId('lanChip').classList.toggle('hidden', !state.access?.lanAccess);
    byId('estimateChip').textContent = '推定値（コンセント実測ではありません）';

    const threshold = Number(state.config?.thresholdWatts || 0);
    if (threshold > 0 && current.watts != null && current.watts >= threshold) {
      stateChip.textContent = `しきい値超過: ${watts(current.watts)}W`;
      stateChip.className = 'chip error';
    }
    setOverallStatus(data);
  },
  async refreshAll() {
    await Promise.all([loadSummary(), loadHistory(), state.view === 'sessions' ? loadSessions() : Promise.resolve(), state.view === 'system' ? loadSystem() : Promise.resolve()]);
  },
  refreshStorage() {
    return storageView.loadStatus();
  },
};

function setOverallStatus(data) {
  if (!data) return;
  const current = data.current || {};
  if (current.watts == null) {
    helpers.setStatus('現在の電力を取得できていません。WattSealの動作を確認してください。', 'stale');
  } else if (current.reason === 'fresh') {
    helpers.setStatus('WattSealが記録中・データはこのPC内だけに保存しています。', 'ok');
  } else {
    helpers.setStatus('古い記録をもとに表示しています（現在値ではありません）。', 'stale');
  }
}

const homeView = createHomeView(state, helpers);
const historyView = createHistoryView(state);
const sessionsView = createSessionsView(state);
const systemView = createSystemView(state);
const storageView = createStorageView(state);
const settingsView = createSettingsView(state, helpers);

// ---------------------------------------------------------------- loaders

async function loadSummary() {
  const token = state.loadToken;
  try {
    const params = { range: state.range, light: 1 };
    if (state.range === 'custom') {
      params.from = state.customFrom;
      params.to = state.customTo;
    }
    const data = await getJson('/api/summary', params);
    if (token !== state.loadToken) return;
    state.summary = data;
    homeView.renderSummary(data);
    state.firstSummaryLoaded = true;
  } catch (error) {
    helpers.setStatus(`集計を取得できませんでした: ${error.message}`, 'error');
  }
}

async function loadRealtime() {
  if (state.view !== 'home' || document.hidden) return;
  try {
    const data = await getJson('/api/realtime', { minutes: state.liveMinutes });
    state.realtime = data;
    homeView.renderRealtime(data);
  } catch (_) {}
}

async function loadHistory() {
  const token = state.loadToken;
  try {
    await historyView.load();
    if (token !== state.loadToken) return;
  } catch (error) {
    helpers.setStatus(`履歴を取得できませんでした: ${error.message}`, 'error');
  }
}

async function loadSessions() {
  try {
    await sessionsView.load();
  } catch (error) {
    byId('sessionNote').textContent = `セッションを取得できませんでした: ${error.message}`;
  }
}

async function loadSystem() {
  try {
    await systemView.load();
  } catch (error) {
    byId('systemUpdated').textContent = `PC状態を取得できませんでした: ${error.message}`;
  }
}

// ---------------------------------------------------------------- views

function selectView(view) {
  state.view = view;
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  }
  for (const section of document.querySelectorAll('.view')) {
    section.classList.toggle('active', section.id === `${view}View`);
  }
  clearInterval(state.timers.system);
  state.timers.system = null;
  clearInterval(state.timers.storage);
  state.timers.storage = null;
  homeView.hideLiveTooltip();

  if (view === 'home') { loadSummary(); loadRealtime(); }
  if (view === 'history') { loadSummary(); loadHistory(); }
  if (view === 'sessions') loadSessions();
  if (view === 'system') { loadSystem(); state.timers.system = setInterval(loadSystem, 5000); }
  if (view === 'storage') {
    storageView.open();
    storageView.loadStatus();
    state.timers.storage = setInterval(storageView.loadStatus, 15000);
  }
}

function selectRange(range) {
  state.range = range;
  state.loadToken += 1;
  for (const button of document.querySelectorAll('[data-range]')) {
    button.classList.toggle('active', button.dataset.range === range);
  }
  byId('customRange').classList.toggle('hidden', range !== 'custom');
  if (range === 'custom' && !state.customFrom) {
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 6 * 86400000);
    state.customFrom = toDateInput(weekAgo);
    state.customTo = toDateInput(today);
    byId('customFrom').value = state.customFrom;
    byId('customTo').value = state.customTo;
  }
  if (state.view === 'home') loadSummary();
  else (state.view === 'history' ? loadHistory() : loadSummary());
  byId('customRangeNote').textContent = range === 'custom' ? '選んだ期間で集計します（終了日を含む）' : '';
}

function toDateInput(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---------------------------------------------------------------- events

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => selectView(button.dataset.view));
}
for (const button of document.querySelectorAll('[data-range]')) {
  button.addEventListener('click', () => selectRange(button.dataset.range));
}
for (const button of document.querySelectorAll('[data-metric]')) {
  button.addEventListener('click', () => {
    state.metric = button.dataset.metric;
    for (const item of document.querySelectorAll('[data-metric]')) item.classList.toggle('active', item === button);
    if (state.history) historyView.render(state.history);
  });
}
for (const button of document.querySelectorAll('[data-compare]')) {
  button.addEventListener('click', () => {
    const value = button.dataset.compare;
    state.compare = state.compare === value ? '' : value;
    for (const item of document.querySelectorAll('[data-compare]')) item.classList.toggle('active', item.dataset.compare === state.compare);
    if (state.history) historyView.render(state.history);
  });
}
for (const button of document.querySelectorAll('[data-minutes]')) {
  button.addEventListener('click', () => {
    state.liveMinutes = Number(button.dataset.minutes);
    for (const item of document.querySelectorAll('[data-minutes]')) item.classList.toggle('active', item === button);
    loadRealtime();
  });
}
for (const button of document.querySelectorAll('[data-system-range]')) {
  button.addEventListener('click', () => {
    state.systemRange = button.dataset.systemRange;
    for (const item of document.querySelectorAll('[data-system-range]')) item.classList.toggle('active', item === button);
    loadSystem();
  });
}
for (const button of document.querySelectorAll('[data-days]')) {
  button.addEventListener('click', () => {
    state.sessionDays = Number(button.dataset.days);
    for (const item of document.querySelectorAll('[data-days]')) item.classList.toggle('active', item === button);
    loadSessions();
  });
}
for (const button of document.querySelectorAll('[data-settings-view]')) {
  button.addEventListener('click', () => {
    for (const item of document.querySelectorAll('[data-settings-view]')) item.classList.toggle('active', item === button);
    for (const section of document.querySelectorAll('.settings-view')) {
      section.classList.toggle('active', section.id === `${button.dataset.settingsView}Settings`);
    }
  });
}
for (const button of document.querySelectorAll('[data-log-kind]')) {
  button.addEventListener('click', () => settingsView.setLogKind(button.dataset.logKind));
}

byId('applyCustomRange').addEventListener('click', () => {
  state.customFrom = byId('customFrom').value;
  state.customTo = byId('customTo').value;
  if (state.view === 'history') loadHistory(); else loadSummary();
});
byId('exportCsv').addEventListener('click', () => download('/api/export', exportParams()));
byId('exportJson').addEventListener('click', () => download('/api/export.json', exportParams()));
byId('reloadStorage').addEventListener('click', () => storageView.reload().catch(() => {}));
byId('settingsButton').addEventListener('click', () => settingsView.open());
byId('closeSettings').addEventListener('click', () => byId('settingsDialog').close());
byId('settingsForm').addEventListener('submit', (event) => settingsView.save(event).catch((error) => alert(error.message)));
byId('resetSettings').addEventListener('click', () => settingsView.resetSettings().catch((error) => alert(error.message)));
byId('resetAllSettings').addEventListener('click', () => settingsView.resetSettings().catch((error) => alert(error.message)));
byId('clearStorageData').addEventListener('click', () => settingsView.clearStorageData().catch((error) => alert(error.message)));
byId('clearPowerData').addEventListener('click', () => settingsView.clearPowerData().catch((error) => alert(error.message)));
byId('deleteRange').addEventListener('click', () => settingsView.deleteRange().catch((error) => alert(error.message)));
byId('restartDashboard').addEventListener('click', () => settingsView.restartDashboard().catch((error) => alert(error.message)));
byId('reloadLogs').addEventListener('click', () => settingsView.loadLogs());
byId('lanAccess').addEventListener('change', () => { byId('lanKeepAlive').disabled = !byId('lanAccess').checked; });
byId('helpButton').addEventListener('click', () => byId('helpDialog').showModal());
byId('closeHelp').addEventListener('click', () => byId('helpDialog').close());

window.addEventListener('resize', () => {
  if (state.summary) homeView.renderSummary(state.summary);
  if (state.realtime && state.view === 'home') homeView.renderRealtime(state.realtime);
  if (state.history) historyView.render(state.history);
  if (state.system && state.view === 'system') systemView.render(state.system);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (state.view === 'home') { loadSummary(); loadRealtime(); }
  if (state.view === 'history') loadHistory();
  if (state.view === 'system') loadSystem();
});

function exportParams() {
  const params = { range: state.range };
  if (state.range === 'custom') {
    params.from = state.customFrom;
    params.to = state.customTo;
  }
  return params;
}

// ---------------------------------------------------------------- start

async function start() {
  try {
    const [access, config] = await Promise.all([getJson('/api/access-info'), getJson('/api/settings')]);
    state.access = access;
    state.config = config;
    if (config.defaultRange) selectRange(config.defaultRange);
    byId('lanChip').classList.toggle('hidden', !access.lanAccess);
    if (access.lanAccess) byId('lanChip').textContent = 'LAN公開中（スマホは読み取り専用）';
    if (!access.canWrite) {
      byId('settingsButton').title = 'スマホからは表示のみ利用できます';
    }
    settingsView.applyReadOnly(!access.canWrite);
  } catch (error) {
    helpers.setStatus(`サーバーに接続できませんでした: ${error.message}`, 'error');
  }

  selectView('home');
  selectRange(state.range);
  homeView.renderLoading();
  await loadSummary();
  loadRealtime();
  // 履歴タブの重い集計は、概要の表示を待たせずに裏で読み込む
  loadHistory().catch(() => {});

  const interval = Math.max(2, Number(state.config?.updateIntervalSeconds || 2)) * 1000;
  state.timers.realtime = setInterval(loadRealtime, interval);
  state.timers.summary = setInterval(() => {
    if (document.hidden) return;
    if (state.view === 'home' || state.view === 'history') loadSummary();
  }, 15000);
  setInterval(() => { if (!document.hidden) fetch('/api/ping', { cache: 'no-store' }).catch(() => {}); }, 30000);

  // スマホではブラウザーの「ホーム画面に追加」を使う（Service Workerは登録しない）。
  // オフライン動作は提供せず、常に最新の記録を表示する。
}

start();
