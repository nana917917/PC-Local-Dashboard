'use strict';

const state = {
  view: 'power', range: 'today', chartMode: 'live', liveMinutes: 15,
  systemRange: '15m', summary: null, realtime: null, system: null,
  storageStarted: false, powerTimer: null, realtimeTimer: null, systemTimer: null,
  powerChartModel: null,
};

const byId = (id) => document.getElementById(id);
const integer = new Intl.NumberFormat('ja-JP');
const one = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const money = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds || 0)));
  if (value >= 86400) return `${Math.floor(value / 86400)}日 ${Math.floor(value % 86400 / 3600)}時間`;
  if (value >= 3600) return `${Math.floor(value / 3600)}時間${Math.floor(value % 3600 / 60)}分`;
  if (value >= 60) return `${Math.floor(value / 60)}分${value % 60}秒`;
  return `${value}秒`;
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.max(0, Number(bytes || 0));
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index >= 3 ? 2 : index >= 2 ? 1 : 0)} ${units[index]}`;
}

function dateTime(stamp, includeDate = true) {
  if (!stamp) return '--';
  return new Date(Number(stamp)).toLocaleString('ja-JP', includeDate
    ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function json(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function setStatus(text, type = '') {
  byId('statusText').textContent = text;
  byId('statusText').className = `status ${type}`;
}

function setOverviewStatus(text, type = '') {
  const host = byId('overviewStatus');
  if (!host) return;
  host.textContent = text;
  host.className = `state-chip ${type}`;
}

function canvasContext(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(320, rect.width);
  const height = Number(canvas.getAttribute('height') || 280);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width, height };
}

function drawAxes(ctx, width, height, maxValue, unit) {
  const pad = { left: 52, right: 18, top: 24, bottom: 36 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  ctx.clearRect(0, 0, width, height);
  ctx.font = '11px Segoe UI';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let step = 0; step <= 4; step += 1) {
    const y = pad.top + plotHeight * step / 4;
    const value = maxValue * (1 - step / 4);
    ctx.strokeStyle = 'rgba(143,160,184,.16)'; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#8fa0b8'; ctx.fillText(`${one.format(value)}${step === 0 ? unit : ''}`, pad.left - 8, y);
  }
  return { ...pad, plotWidth, plotHeight };
}

function axisTimeLabel(timestamp, range = state.range, granularity = 'hour') {
  const date = new Date(Number(timestamp));
  if (granularity === 'hour') return `${String(date.getHours()).padStart(2, '0')}時`;
  if (range === 'year' || range === 'all') return `${date.getFullYear()}/${date.getMonth() + 1}`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function drawXAxisLabels(ctx, area, height, positions, labels) {
  if (!positions.length) return;
  const maxLabels = Math.max(2, Math.floor(area.plotWidth / 72));
  const step = Math.max(1, Math.ceil((positions.length - 1) / Math.max(1, maxLabels - 1)));
  const indexes = [];
  for (let index = 0; index < positions.length; index += step) indexes.push(index);
  if (indexes.at(-1) !== positions.length - 1) indexes.push(positions.length - 1);
  ctx.font = '10px Segoe UI'; ctx.fillStyle = '#8fa0b8'; ctx.textBaseline = 'bottom';
  indexes.forEach((index) => {
    const x = positions[index];
    ctx.textAlign = index === 0 ? 'left' : index === positions.length - 1 ? 'right' : 'center';
    ctx.fillText(labels[index], x, height - 5);
  });
}

function setPowerChartModel(model) {
  state.powerChartModel = model;
}

function drawLineChart(canvas, points, series, options = {}) {
  const { ctx, width, height } = canvasContext(canvas);
  const valueOf = (point, key) => {
    if (point[key] == null || point[key] === '') return null;
    const value = Number(point[key]);
    return Number.isFinite(value) ? value : null;
  };
  const values = points.flatMap((point) => series.map((item) => valueOf(point, item.key)).filter((value) => value !== null));
  const maxValue = Math.max(options.minimumMax ?? 10, ...values, .01) * 1.12;
  const area = drawAxes(ctx, width, height, maxValue, options.unit || '');
  if (!points.length) return false;
  const first = Number(points[0].timestamp);
  const last = Math.max(first + 1, Number(points.at(-1).timestamp));
  const xPositions = points.map((point) => area.left + (Number(point.timestamp) - first) / (last - first) * area.plotWidth);
  if (options.fill && series.length >= 1) {
    const item = series[0];
    const gradient = ctx.createLinearGradient(0, area.top, 0, area.top + area.plotHeight);
    gradient.addColorStop(0, options.fill);
    gradient.addColorStop(1, 'rgba(74,168,255,0)');
    ctx.fillStyle = gradient; ctx.beginPath();
    let previousY = null;
    points.forEach((point, index) => {
      const value = valueOf(point, item.key);
      if (value === null) { previousY = null; return; }
      const y = area.top + (1 - value / maxValue) * area.plotHeight;
      if (index === 0) ctx.moveTo(xPositions[index], area.top + area.plotHeight);
      if (previousY === null) ctx.moveTo(xPositions[index], area.top + area.plotHeight);
      if (options.step && previousY !== null) ctx.lineTo(xPositions[index], previousY);
      ctx.lineTo(xPositions[index], y);
      previousY = y;
    });
    ctx.lineTo(xPositions.at(-1), area.top + area.plotHeight); ctx.closePath(); ctx.fill();
  }
  for (const item of series) {
    ctx.strokeStyle = item.color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); let drawing = false; let previousStamp = null; let previousY = null;
    for (const point of points) {
      const value = valueOf(point, item.key);
      if (value === null) { drawing = false; previousStamp = null; previousY = null; continue; }
      const stamp = Number(point.timestamp);
      const x = area.left + (stamp - first) / (last - first) * area.plotWidth;
      const y = area.top + (1 - value / maxValue) * area.plotHeight;
      const expectedGap = options.gapMs || Infinity;
      if (!drawing || previousStamp === null || stamp - previousStamp > expectedGap) {
        ctx.moveTo(x, y); drawing = true;
      } else {
        if (options.step && previousY !== null) ctx.lineTo(x, previousY);
        ctx.lineTo(x, y);
      }
      previousStamp = stamp;
      previousY = y;
    }
    ctx.stroke();
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  let legendX = area.left;
  for (const item of series) {
    ctx.fillStyle = item.color; ctx.fillRect(legendX, 4, 10, 3);
    ctx.fillStyle = '#8fa0b8'; ctx.fillText(item.label, legendX + 15, 0);
    legendX += ctx.measureText(item.label).width + 42;
  }
  const xLabels = points.map((point) => options.xLabel ? options.xLabel(point) : dateTime(point.timestamp, false));
  drawXAxisLabels(ctx, area, height, xPositions, xLabels);
  if (options.modelTarget === 'power') setPowerChartModel({ points, xPositions, area, tooltip: options.tooltip });
  return true;
}

function drawBarChart(canvas, points, options = {}) {
  const { ctx, width, height } = canvasContext(canvas);
  const maxValue = Math.max(.05, ...points.map((point) => Number(point.cost || 0))) * 1.12;
  const area = drawAxes(ctx, width, height, maxValue, '円');
  if (!points.length) return false;
  const slot = area.plotWidth / points.length;
  const barWidth = Math.max(3, Math.min(34, slot * .68));
  const gradient = ctx.createLinearGradient(0, area.top, 0, area.top + area.plotHeight);
  gradient.addColorStop(0, '#56e0a0'); gradient.addColorStop(1, '#2388e6');
  const xPositions = [];
  points.forEach((point, index) => {
    const value = Number(point.cost || 0);
    const h = value / maxValue * area.plotHeight;
    const x = area.left + slot * index + (slot - barWidth) / 2;
    xPositions.push(x + barWidth / 2);
    ctx.fillStyle = gradient; ctx.fillRect(x, area.top + area.plotHeight - h, barWidth, h);
  });
  const labels = points.map((point) => options.xLabel ? options.xLabel(point) : String(point.bucket));
  drawXAxisLabels(ctx, area, height, xPositions, labels);
  if (options.modelTarget === 'power') setPowerChartModel({ points, xPositions, area, tooltip: options.tooltip });
  return true;
}

function cumulativeHistory(history, bounds, granularity) {
  let cumulativeCost = 0;
  let cumulativeKwh = 0;
  const periodMs = granularity === 'hour' ? 3600000 : 86400000;
  const accumulated = history.map((point) => {
    cumulativeCost += Number(point.cost || 0);
    cumulativeKwh += Number(point.adjustedKwh || 0);
    return {
      ...point,
      sourceTimestamp: point.timestamp,
      timestamp: Math.min(Number(bounds?.end || Infinity), Number(point.timestamp) + periodMs),
      cumulativeCost,
      cumulativeKwh,
    };
  });
  if (!history.length || !bounds?.start) return accumulated;
  return [{ timestamp: bounds.start, sourceTimestamp: bounds.start, cumulativeCost: 0, cumulativeKwh: 0, cost: 0, adjustedKwh: 0, isStart: true }, ...accumulated];
}

function normalizedHistory(
  history = state.summary?.history || [],
  bounds = state.summary?.bounds,
  granularity = state.summary?.historyGranularity,
  range = state.range,
) {
  if (!history.length || !bounds) return history;
  const emptyPoint = (timestamp) => ({
      timestamp,
      bucket: '',
      rawKwh: 0,
      adjustedKwh: 0,
      cost: 0,
      activeSeconds: 0,
      averageWatts: 0,
      missing: true,
  });
  const result = [];
  if (granularity === 'hour') {
    const periodMs = 3600000;
    const start = range === 'all' ? Number(history[0].timestamp) : Math.floor(Number(bounds.start) / periodMs) * periodMs;
    const end = Number(bounds.end);
    if (Math.ceil((end - start) / periodMs) + 1 > 5000) return history;
    const existing = new Map(history.map((point) => [Math.floor(Number(point.timestamp) / periodMs) * periodMs, point]));
    for (let stamp = start; stamp <= end; stamp += periodMs) result.push(existing.get(stamp) || emptyPoint(stamp));
    return result;
  }
  const dayKey = (timestamp) => {
    const date = new Date(Number(timestamp));
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  };
  const startDate = new Date(range === 'all' ? Number(history[0].timestamp) : Number(bounds.start));
  startDate.setHours(0, 0, 0, 0);
  if (Math.ceil((Number(bounds.end) - startDate.getTime()) / 86400000) + 1 > 5000) return history;
  const existing = new Map(history.map((point) => [dayKey(point.timestamp), point]));
  for (const cursor = new Date(startDate); cursor.getTime() <= Number(bounds.end); cursor.setDate(cursor.getDate() + 1)) {
    const stamp = cursor.getTime();
    result.push(existing.get(dayKey(stamp)) || emptyPoint(stamp));
  }
  return result;
}

function fullBucketLabel(point, granularity = state.summary?.historyGranularity) {
  const date = new Date(Number(point.sourceTimestamp ?? point.timestamp));
  return granularity === 'hour'
    ? date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });
}

function signed(value, digits = 1, suffix = '') {
  const number = Number(value || 0);
  return `${number > 0 ? '+' : ''}${number.toFixed(digits)}${suffix}`;
}

function renderChartInsights(data) {
  const insights = data.insights || {};
  byId('chartTotal').textContent = `${money.format(data.totals.cost || 0)}円`;
  byId('chartTotalDetail').textContent = `${Number(data.totals.adjustedKwh || 0).toFixed(3)} kWh・${formatDuration(data.totals.activeSeconds)}`;

  let previous = insights.previous;
  let comparisonLabel = insights.previousLabel;
  if (!previous && data.range === 'session' && data.quickStats?.previousSession) {
    previous = data.quickStats.previousSession;
    comparisonLabel = '前回のPC使用比';
  }
  const comparisonHost = byId('comparisonValue');
  comparisonHost.classList.remove('trend-up', 'trend-down');
  byId('comparisonLabel').textContent = comparisonLabel || '直前の同期間比';
  if (previous?.cost > 0) {
    const difference = data.totals.cost - previous.cost;
    const percent = difference / previous.cost * 100;
    comparisonHost.textContent = signed(percent, 1, '%');
    if (percent > 0) comparisonHost.classList.add('trend-up');
    if (percent < 0) comparisonHost.classList.add('trend-down');
    byId('comparisonDetail').textContent = `${money.format(previous.cost)}円 → ${money.format(data.totals.cost)}円（${signed(difference, 1, '円')}）`;
  } else {
    comparisonHost.textContent = '比較なし';
    byId('comparisonDetail').textContent = data.range === 'all' ? '全期間表示では比較しません'
      : insights.previousPartial ? '直前期間の先頭まで記録がないため比較しません'
        : '前期間の記録がありません';
  }

  const peak = insights.peak;
  byId('peakBucketLabel').textContent = data.historyGranularity === 'hour' ? '最も高かった時間' : '最も高かった日';
  byId('peakBucketValue').textContent = peak ? `${money.format(peak.cost)}円` : '--円';
  byId('peakBucketDetail').textContent = peak ? `${fullBucketLabel(peak, data.historyGranularity)}・平均${one.format(peak.averageWatts)}W` : '集計中';
}

function renderHistoryLog(data) {
  const history = data.history || [];
  const granularity = data.historyGranularity === 'hour' ? '時間別' : '日別';
  byId('historyLogSummary').textContent = `${granularity}・${integer.format(history.length)}区間`;
  const visible = [...history].reverse().slice(0, 120);
  byId('historyLogRows').innerHTML = visible.length ? visible.map((item) => `<tr><td>${fullBucketLabel(item, data.historyGranularity)}</td><td>${money.format(item.cost || 0)}円</td><td>${Number(item.adjustedKwh || 0).toFixed(4)} kWh</td><td>${one.format(item.averageWatts || 0)} W</td><td>${formatDuration(item.activeSeconds || 0)}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">この期間の記録はまだありません。</td></tr>';
  byId('historyLogNote').textContent = history.length > visible.length
    ? `新しい${integer.format(visible.length)}区間を表示しています。全${integer.format(history.length)}区間はCSV出力で保存できます。`
    : 'グラフの区間を新しい順に表示しています。停止・スリープ中の区間は記録されません。';
}

function hidePowerTooltip() {
  byId('powerCrosshair').classList.add('hidden');
  byId('powerTooltip').classList.add('hidden');
}

function setChartMode(mode) {
  hidePowerTooltip();
  state.chartMode = mode;
  document.querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item.dataset.mode === mode));
  renderPowerChart();
  if (mode === 'live') loadRealtime();
}

function handlePowerChartPointer(event) {
  const model = state.powerChartModel;
  if (!model?.points?.length) return;
  const canvas = byId('powerChart');
  const rect = canvas.getBoundingClientRect();
  const clientX = event.clientX ?? event.touches?.[0]?.clientX;
  if (!Number.isFinite(clientX)) return;
  const x = Math.max(model.area.left, Math.min(rect.width - model.area.right, clientX - rect.left));
  let nearestIndex = 0;
  let nearestDistance = Infinity;
  model.xPositions.forEach((position, index) => {
    const distance = Math.abs(position - x);
    if (distance < nearestDistance) { nearestDistance = distance; nearestIndex = index; }
  });
  const position = model.xPositions[nearestIndex];
  const crosshair = byId('powerCrosshair');
  const tooltip = byId('powerTooltip');
  crosshair.style.left = `${position}px`;
  crosshair.classList.remove('hidden');
  tooltip.innerHTML = model.tooltip ? model.tooltip(model.points[nearestIndex]) : '';
  tooltip.classList.remove('hidden');
  const tooltipWidth = tooltip.offsetWidth || 190;
  tooltip.style.left = `${Math.max(6, Math.min(rect.width - tooltipWidth - 6, position + (position > rect.width * .62 ? -tooltipWidth - 12 : 12)))}px`;
  tooltip.style.top = '30px';
}

function renderSummary(data) {
  state.summary = data;
  const age = data.current.ageSeconds;
  const isFresh = age != null && age < 15;
  byId('currentWatts').innerHTML = isFresh ? `${one.format(data.current.watts || 0)}<small>W</small>` : `--<small>W</small>`;
  const hourlyCost = data.insights?.runningCostPerHour;
  byId('currentAge').textContent = age == null ? '計測待ち'
    : isFresh ? `${age < 8 ? '記録中' : `${Math.round(age)}秒前`}・このまま1時間 ${money.format(hourlyCost || 0)}円`
      : `現在値なし・最終 ${dateTime(data.current.timestamp)}`;
  byId('periodLabel').textContent = `${data.label}の推定料金`;
  byId('periodCost').innerHTML = `${money.format(data.totals.cost || 0)}<small>円</small>`;
  byId('periodRate').textContent = `${data.config.electricityRate}円/kWh`;
  byId('periodEnergy').innerHTML = `${Number(data.totals.adjustedKwh || 0).toFixed(3)}<small>kWh</small>`;
  byId('averageWatts').textContent = `平均 ${one.format(data.totals.averageWatts || 0)} W`;
  byId('activeTime').textContent = formatDuration(data.totals.activeSeconds);
  const quick = data.quickStats || {};
  byId('quickCurrentCost').textContent = `${money.format(quick.currentSession?.cost || 0)}円`;
  byId('quickCurrentDetail').textContent = `${formatDuration(quick.currentSession?.activeSeconds || 0)}・${Number(quick.currentSession?.adjustedKwh || 0).toFixed(3)} kWh`;
  byId('quickPreviousCost').textContent = quick.previousSession ? `${money.format(quick.previousSession.cost)}円` : '--円';
  byId('quickPreviousDetail').textContent = quick.previousSession ? `${formatDuration(quick.previousSession.activeSeconds)}・平均${one.format(quick.previousSession.averageWatts)}W` : '前回履歴待ち';
  byId('quickMonthCost').textContent = `${money.format(quick.monthProjection?.cost || 0)}円`;
  if (data.config.monthlyBudget > 0) {
    const remaining = data.config.monthlyBudget - Number(quick.monthProjection?.cost || 0);
    byId('quickMonthDetail').textContent = `${remaining >= 0 ? `目安まで${money.format(remaining)}円` : `目安を${money.format(-remaining)}円超過見込み`}・${Number(quick.monthProjection?.adjustedKwh || 0).toFixed(2)} kWh`;
  } else {
    byId('quickMonthDetail').textContent = `${Number(quick.monthProjection?.adjustedKwh || 0).toFixed(2)} kWh見込み`;
  }
  const topCategory = data.applicationCategories?.[0];
  byId('topCategory').textContent = topCategory?.label || '--';
  byId('topCategoryDetail').textContent = topCategory ? `${one.format(topCategory.share)}%・${money.format(topCategory.cost)}円` : 'アプリ記録待ち';
  renderComponents(data.components || []);
  renderCategories(data.applicationCategories || []);
  renderApplications(data.applications || []);
  renderSessions(data.sessions || []);
  renderHistoryLog(data);
  renderChartInsights(data);
  if (state.chartMode !== 'live') renderPowerChart();
  setStatus(isFresh ? 'WattSealが記録中・データはこのPC内だけに保存' : '計測値の更新を待っています', isFresh ? 'ok' : 'stale');
  setOverviewStatus(isFresh ? '記録中' : data.current.timestamp ? '最終値のみ' : '計測待ち', isFresh ? '' : 'stale');
}

function renderComponents(items) {
  byId('componentList').innerHTML = items.length ? items.map((item) => `<div class="bar-item"><span class="bar-label">${escapeHtml(item.label)}</span><span class="bar-value">${one.format(item.percent)}%・${money.format(item.cost)}円</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, item.percent)}%"></div></div></div>`).join('') : '<p class="muted">部品データを待っています。</p>';
}

function renderCategories(items) {
  byId('categoryList').innerHTML = items.length ? items.slice(0, 6).map((item) => `<article class="category-item ${item.key === 'game' ? 'category-game' : ''}"><span>${escapeHtml(item.label)}</span><strong>${money.format(item.cost)}円</strong><small>${one.format(item.share)}%・${item.apps}アプリ</small></article>`).join('') : '<p class="muted">分類できるアプリ記録はまだありません。</p>';
}

function renderApplications(items) {
  byId('applicationRows').innerHTML = items.length ? items.map((item) => `<tr><td class="app-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</td><td>${one.format(item.share)}%</td><td>${Number(item.kwh || 0).toFixed(4)} kWh</td><td>${money.format(item.cost)}円</td></tr>`).join('') : '<tr><td colspan="4" class="muted">アプリ記録を待っています。</td></tr>';
}

function renderSessions(items) {
  byId('sessionRows').innerHTML = items.length ? items.map((item) => `<tr><td>${dateTime(item.start)}</td><td>${dateTime(item.end)}</td><td>${formatDuration(item.activeSeconds)}</td><td>${one.format(item.averageWatts)} W</td><td>${Number(item.adjustedKwh || 0).toFixed(3)} kWh</td><td>${money.format(item.cost)}円</td></tr>`).join('') : '<tr><td colspan="6" class="muted">起動セッションを集計中です。</td></tr>';
}

function renderRealtime(data) {
  state.realtime = data;
  const app = data.leaders?.application;
  const component = data.leaders?.component;
  byId('liveApplication').textContent = app?.name || '--';
  byId('liveApplicationDetail').textContent = app ? `約 ${one.format(app.watts)} W` : 'アプリ記録待ち';
  byId('liveComponent').textContent = component?.name || '--';
  byId('liveComponentDetail').textContent = component ? `約 ${one.format(component.watts)} W` : '部品記録待ち';
  byId('recentPeak').textContent = data.peak ? `${one.format(data.peak.watts)} W` : '-- W';
  byId('recentPeakTime').textContent = data.peak ? `${dateTime(data.peak.timestamp, false)}・直近${data.minutes}分` : '記録待ち';
  if (state.chartMode === 'live') renderPowerChart();
}

function renderPowerChart() {
  const live = state.chartMode === 'live';
  const cumulative = state.chartMode === 'cumulative';
  const granularity = state.summary?.historyGranularity || 'hour';
  const intervalName = granularity === 'hour' ? '時間別' : '日別';
  byId('powerChartTitle').textContent = live ? 'リアルタイム電力'
    : cumulative ? `${state.summary?.label || ''}の累積料金`
      : `${state.summary?.label || ''}の${intervalName}料金`;
  byId('liveControls').classList.toggle('hidden', !live);
  let shown = false;
  if (live) {
    shown = drawLineChart(byId('powerChart'), state.realtime?.points || [], [{ key: 'watts', label: 'PC全体', color: '#56e0a0' }], {
      unit: 'W', minimumMax: 50, gapMs: state.liveMinutes <= 5 ? 5000 : state.liveMinutes <= 15 ? 8000 : 30000,
      modelTarget: 'power', xLabel: (point) => dateTime(point.timestamp, false).slice(0, 5),
      tooltip: (point) => `<strong>${dateTime(point.timestamp, false)}　${one.format(point.watts)} W</strong><small>このまま1時間 約${money.format(point.watts / 1000 * (state.summary?.config.electricityRate || 0))}円</small>`,
    });
    byId('chartNote').textContent = '線が途切れている時間は、PC停止・スリープ・計測停止の可能性があります。スリープ中の料金は加算しません。';
  } else if (cumulative) {
    const points = cumulativeHistory(normalizedHistory(), state.summary?.bounds, granularity);
    const previousPoints = state.summary?.comparisonHistory?.length
      ? cumulativeHistory(
        normalizedHistory(state.summary.comparisonHistory, state.summary.bounds, granularity, state.range),
        state.summary.bounds,
        granularity,
      )
      : [];
    const previousByTimestamp = new Map(previousPoints.map((point) => [point.timestamp, point.cumulativeCost]));
    const combined = points.map((point) => ({ ...point, previousCumulativeCost: previousByTimestamp.get(point.timestamp) ?? null }));
    const series = [{ key: 'cumulativeCost', label: '選択期間', color: '#4aa8ff' }];
    if (previousPoints.length) series.push({ key: 'previousCumulativeCost', label: '直前期間', color: '#ffb65b' });
    shown = drawLineChart(byId('powerChart'), combined, series, {
      unit: '円', minimumMax: .1, fill: 'rgba(74,168,255,.24)', step: true, modelTarget: 'power',
      xLabel: (point) => axisTimeLabel(point.timestamp, state.range, granularity),
      tooltip: (point) => point.isStart
        ? `<strong>${fullBucketLabel(point, granularity)}　0円から開始</strong><small>選択期間の累積基準点</small>`
        : `<strong>${fullBucketLabel(point, granularity)}　累積 ${money.format(point.cumulativeCost)}円</strong><small>この区間 ${money.format(point.cost)}円・累積 ${Number(point.cumulativeKwh).toFixed(3)} kWh${Number.isFinite(point.previousCumulativeCost) ? `・直前期間 ${money.format(point.previousCumulativeCost)}円` : ''}</small>`,
    });
    byId('chartNote').textContent = previousPoints.length
      ? '選択期間の先頭を0円として積み上げ、直前の同期間を重ねています。停止・スリープ中は横ばいになります。'
      : '選択期間の先頭を0円として積み上げます。停止・スリープ中は横ばいになります。';
  } else {
    shown = drawBarChart(byId('powerChart'), normalizedHistory(), {
      modelTarget: 'power', xLabel: (point) => axisTimeLabel(point.timestamp, state.range, granularity),
      tooltip: (point) => `<strong>${fullBucketLabel(point, granularity)}　${money.format(point.cost)}円</strong><small>${Number(point.adjustedKwh).toFixed(4)} kWh・平均${one.format(point.averageWatts)}W・${formatDuration(point.activeSeconds)}</small>`,
    });
    byId('chartNote').textContent = `${intervalName}の料金です。横軸ラベルは重ならない数だけ水平表示し、細かい値はグラフ上で確認できます。`;
  }
  if (!shown) state.powerChartModel = null;
  byId('powerChartEmpty').classList.toggle('hidden', shown);
}

async function loadSummary() {
  try { renderSummary(await json(`/api/summary?range=${state.range}`)); }
  catch (error) { setStatus(error.message, 'stale'); }
}

async function loadRealtime() {
  if (state.view !== 'power' || state.chartMode !== 'live' || document.hidden) return;
  try { renderRealtime(await json(`/api/realtime?minutes=${state.liveMinutes}`)); }
  catch (_) {}
}

function renderSystem(data) {
  state.system = data;
  byId('cpuUsage').innerHTML = `${data.cpu.usagePercent == null ? '--' : one.format(data.cpu.usagePercent)}<small>%</small>`;
  byId('cpuName').textContent = data.cpu.name || '--';
  byId('gpuUsage').innerHTML = `${data.gpu?.usagePercent == null ? '--' : one.format(data.gpu.usagePercent)}<small>%</small>`;
  byId('gpuDetail').textContent = data.gpu ? `${data.gpu.name}・VRAM ${integer.format(data.gpu.memoryUsedMb)}/${integer.format(data.gpu.memoryTotalMb)} MB` : '対応GPU情報なし';
  byId('ramUsage').innerHTML = `${data.ram.usagePercent == null ? '--' : one.format(data.ram.usagePercent)}<small>%</small>`;
  byId('ramDetail').textContent = `${formatBytes(data.ram.usedBytes)} / ${formatBytes(data.ram.totalBytes)}`;
  byId('collectorState').textContent = data.wattseal.running ? '記録中' : '停止中';
  byId('collectorDetail').textContent = data.wattseal.ageSeconds == null ? 'DB待ち' : `最終 ${Math.round(data.wattseal.ageSeconds)}秒前`;
  byId('uptime').textContent = formatDuration(data.uptimeSeconds);
  byId('gpuTemperature').textContent = data.gpu?.temperatureC != null ? `${one.format(data.gpu.temperatureC)} ℃` : '取得対象外';
  byId('gpuPower').textContent = data.gpu?.powerWatts != null ? `${one.format(data.gpu.powerWatts)} W` : '取得対象外';
  byId('lastSample').textContent = data.wattseal.latestSample ? dateTime(data.wattseal.latestSample) : '--';
  byId('driveStatusList').innerHTML = data.drives.length ? data.drives.map((drive) => {
    const used = Math.max(0, drive.total - drive.free); const percent = drive.total ? used / drive.total * 100 : 0;
    const health = drive.health ? `・健康 ${escapeHtml(drive.health)}` : '';
    return `<div class="bar-item"><span class="bar-label">${escapeHtml(drive.path)} ${escapeHtml(drive.label)}</span><span class="bar-value">空き ${formatBytes(drive.free)} / ${formatBytes(drive.total)}${health}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, percent)}%"></div></div></div>`;
  }).join('') : '<p class="muted">ドライブ情報を取得できませんでした。</p>';
  const shown = drawLineChart(byId('systemChart'), data.history || [], [
    { key: 'cpu', label: 'CPU', color: '#4aa8ff' }, { key: 'gpu', label: 'GPU', color: '#56e0a0' }, { key: 'ram', label: 'RAM', color: '#ffb65b' },
  ], { unit: '%', minimumMax: 100, gapMs: state.systemRange === 'today' ? 20 * 60000 : 60000 });
  byId('systemChartEmpty').classList.toggle('hidden', shown);
}

async function loadSystem() {
  if (state.view !== 'system' || document.hidden) return;
  try { renderSystem(await json(`/api/system?range=${state.systemRange}`)); }
  catch (error) { setStatus(error.message, 'stale'); }
}

async function startStorage(force = false) {
  if (state.storageStarted && !force) return;
  state.storageStarted = true;
  const frame = byId('storageFrame'); const loading = byId('storageLoading');
  frame.classList.add('hidden'); loading.classList.remove('hidden'); loading.textContent = '容量画面を起動しています…';
  try {
    const result = await json('/api/open-storage', { method: 'POST' });
    frame.onload = () => { loading.classList.add('hidden'); frame.classList.remove('hidden'); };
    frame.src = `${result.url}/?embedded=1&t=${Date.now()}`;
    setTimeout(() => { if (frame.classList.contains('hidden')) frame.src = `${result.url}/?embedded=1&t=${Date.now()}`; }, 1200);
  } catch (error) { loading.textContent = error.message; }
}

function selectView(view) {
  state.view = view;
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === `${view}View`));
  clearInterval(state.systemTimer); state.systemTimer = null;
  if (view === 'storage') startStorage();
  if (view === 'system') { loadSystem(); state.systemTimer = setInterval(loadSystem, 2000); }
  if (view === 'power') { loadSummary(); loadRealtime(); }
}

async function openSettings() {
  try {
    const [config, status, access] = await Promise.all([json('/api/settings'), json('/api/data-status'), json('/api/access-info')]);
    for (const key of ['electricityRate', 'sensorFactor', 'baseWatts', 'monitorWatts', 'monthlyBudget']) byId(key).value = config[key];
    byId('gameKeywords').value = (config.gameKeywords || []).join(', ');
    byId('lanAccess').checked = Boolean(config.lanAccess);
    byId('dataSummary').innerHTML = `バージョン <strong>${escapeHtml(status.version)}</strong><br>電力履歴 <strong>${formatBytes(status.databaseBytes)}</strong>・${integer.format(status.recordedDays)}日分<br>記録開始 ${status.startedAt ? dateTime(status.startedAt) : 'まだありません'}<br>容量スキャン結果 <strong>${formatBytes(status.storageCacheBytes)}</strong>`;
    byId('dataWarning').textContent = status.warning || '';
    byId('dataWarning').classList.toggle('hidden', !status.warning);
    byId('backupCsv').href = '/api/export?range=all';
    byId('accessInfo').innerHTML = access.lanAccess
      ? `<strong>スマホ用URL</strong><br>${access.urls.map((url) => `<code>${escapeHtml(url)}</code>`).join('<br>') || 'LAN側のアドレスを取得できませんでした。'}<br><span>PCとスマホを同じWi-Fiへ接続して開いてください。</span>`
      : '<strong>現在はPC内だけで開く設定です。</strong><br>上のスイッチを有効にすると、再起動後に同一Wi-Fiのスマホから開けます。';
    byId('settingsDialog').showModal();
  } catch (error) { alert(error.message); }
}

async function saveSettings(event) {
  event.preventDefault();
  const result = await json('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    electricityRate: byId('electricityRate').value, sensorFactor: byId('sensorFactor').value,
    baseWatts: byId('baseWatts').value, monitorWatts: byId('monitorWatts').value,
    monthlyBudget: byId('monthlyBudget').value, gameKeywords: byId('gameKeywords').value,
    lanAccess: byId('lanAccess').checked,
  }) });
  byId('settingsDialog').close(); await loadSummary(); await loadRealtime();
  if (result.restartRequired) {
    setStatus('接続設定を反映するため再起動しています…', 'stale');
    try { await json('/api/restart', { method: 'POST' }); } catch (_) {}
    setTimeout(() => location.reload(), 1600);
  }
}

async function resetSettings() {
  if (!confirm('計算設定を初期値へ戻しますか？')) return;
  const config = await json('/api/reset-settings', { method: 'POST' });
  for (const key of ['electricityRate', 'sensorFactor', 'baseWatts', 'monitorWatts', 'monthlyBudget']) byId(key).value = config[key];
  byId('gameKeywords').value = (config.gameKeywords || []).join(', ');
}

async function clearStorageData() {
  if (!confirm('保存された容量スキャン結果を削除しますか？ ファイル本体は削除しません。')) return;
  await json('/api/clear-storage-cache', { method: 'POST' });
  state.storageStarted = false; byId('storageFrame').src = 'about:blank';
  alert('容量スキャン結果を削除しました。'); byId('settingsDialog').close();
}

async function clearPowerData() {
  if (!confirm('電力履歴をすべて削除します。CSV保存は済んでいますか？')) return;
  if (!confirm('この操作は元に戻せません。本当に電力履歴を初期化しますか？')) return;
  const typed = prompt('確認のため「削除」と入力してください。');
  if (typed !== '削除') return;
  await json('/api/clear-power-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: 'DELETE_POWER_HISTORY' }) });
  byId('settingsDialog').close(); setStatus('履歴を初期化しました。WattSealの再開を待っています', 'stale');
  setTimeout(loadSummary, 4000);
}

document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => selectView(button.dataset.view)));
document.querySelectorAll('[data-range]').forEach((button) => button.addEventListener('click', async () => {
  hidePowerTooltip();
  state.range = button.dataset.range;
  document.querySelectorAll('[data-range]').forEach((item) => item.classList.toggle('active', item === button));
  if (!['session', 'today'].includes(state.range) && state.chartMode === 'live') setChartMode('cumulative');
  await loadSummary();
}));
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
  setChartMode(button.dataset.mode);
}));
document.querySelectorAll('[data-minutes]').forEach((button) => button.addEventListener('click', () => {
  state.liveMinutes = Number(button.dataset.minutes); document.querySelectorAll('[data-minutes]').forEach((item) => item.classList.toggle('active', item === button)); loadRealtime();
}));
document.querySelectorAll('[data-system-range]').forEach((button) => button.addEventListener('click', () => {
  state.systemRange = button.dataset.systemRange; document.querySelectorAll('[data-system-range]').forEach((item) => item.classList.toggle('active', item === button)); loadSystem();
}));
document.querySelectorAll('[data-settings-view]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('[data-settings-view]').forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('.settings-view').forEach((item) => item.classList.toggle('active', item.id === `${button.dataset.settingsView}Settings`));
}));
byId('exportButton').addEventListener('click', () => { location.href = `/api/export?range=${state.range}`; });
byId('settingsButton').addEventListener('click', openSettings);
byId('closeSettings').addEventListener('click', () => byId('settingsDialog').close());
byId('settingsForm').addEventListener('submit', (event) => saveSettings(event).catch((error) => alert(error.message)));
byId('resetSettings').addEventListener('click', () => resetSettings().catch((error) => alert(error.message)));
byId('clearStorageData').addEventListener('click', () => clearStorageData().catch((error) => alert(error.message)));
byId('clearPowerData').addEventListener('click', () => clearPowerData().catch((error) => alert(error.message)));
byId('reloadStorage').addEventListener('click', () => startStorage(true));
byId('powerChart').addEventListener('pointermove', handlePowerChartPointer);
byId('powerChart').addEventListener('pointerdown', handlePowerChartPointer);
byId('powerChart').addEventListener('pointerleave', hidePowerTooltip);
byId('powerChart').addEventListener('pointercancel', hidePowerTooltip);
window.addEventListener('resize', () => { if (state.view === 'power') renderPowerChart(); if (state.view === 'system' && state.system) renderSystem(state.system); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { if (state.view === 'power') { loadSummary(); loadRealtime(); } if (state.view === 'system') loadSystem(); } });

loadSummary(); loadRealtime();
state.powerTimer = setInterval(() => {
  if (state.view === 'power' && !document.hidden && ['session', 'today'].includes(state.range)) loadSummary();
}, 10000);
state.realtimeTimer = setInterval(loadRealtime, 2000);
setInterval(() => { if (!document.hidden) fetch('/api/ping', { cache: 'no-store' }).catch(() => {}); }, 30000);
