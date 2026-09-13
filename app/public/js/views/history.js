// 履歴・料金画面: 期間に連動したグラフ・比較・数値表・気づきをまとめる。

import { bindInteractive, drawBarChart, drawHeatmap, drawLineChart, drawProfileChart } from '../chart.js';
import { getJson } from '../api.js';
import {
  bucketLabel, dateTime, duration, energy, escapeHtml, granularityLabel, integer, money, percent, qualityClass, qualityLabel, signed, watts, yen,
} from '../format.js';

const byId = (id) => document.getElementById(id);
const TABLE_LIMIT = 200;

export function createHistoryView(state) {
  bindInteractive(byId('historyChart'), {
    crosshair: byId('historyCrosshair'),
    tooltip: byId('historyTooltip'),
    getModel: () => state.historyModel,
    format: (bucket) => {
      if (!bucket) return '';
      const lines = [`<strong>${bucketLabel(bucket.timestamp, bucket.granularity)}</strong>`];
      if (bucket.missing) {
        lines.push('<small>この区間は記録がありません（0Wではありません）</small>');
        return lines.join('');
      }
      lines.push(`<small>平均 ${watts(bucket.averageWatts)} W・最大 ${watts(bucket.maxWatts)} W・最小 ${watts(bucket.minWatts)} W</small>`);
      lines.push(`<small>${energy(bucket.kwh)}・約${yen(bucket.cost)}・使用 ${duration(bucket.activeSeconds)}</small>`);
      if (bucket.previousCost != null) {
        lines.push(`<small>直前の同期間: 約${yen(bucket.previousCost)}（${signed(bucket.cost - bucket.previousCost, 1, '円')}）</small>`);
      }
      lines.push(`<small>品質: ${qualityLabel(bucket)}</small>`);
      return lines.join('');
    },
  });

  async function load() {
    if (!state.history) {
      byId('historyRows').innerHTML = '<tr><td colspan="8" class="muted">読み込み中…</td></tr>';
      byId('comparisonBody').innerHTML = '<p class="muted">読み込み中…</p>';
      byId('historyChartEmpty').classList.remove('hidden');
      byId('historyChartEmpty').textContent = '読み込み中…';
    }
    const params = { range: state.range, granularity: state.granularityOverride || 'auto' };
    if (state.range === 'custom') {
      params.from = state.customFrom;
      params.to = state.customTo;
    }
    const [history, breakdown] = await Promise.all([
      getJson('/api/history', params),
      getJson('/api/breakdown', params).catch(() => null),
    ]);
    state.history = history;
    render(state.history);
    if (breakdown) renderBreakdown(breakdown);
  }

  function renderBreakdown(data) {
    const components = data.components || [];
    byId('componentList').innerHTML = components.length ? components.map((item) => `
      <div class="bar-item">
        <span class="bar-label">${escapeHtml(item.label)}</span>
        <span class="bar-value">${percent(item.percent)}・約${yen(item.cost)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, Math.min(100, item.percent))}%"></div></div>
      </div>`).join('') : '<p class="muted">この期間の部品データがありません。</p>';
    byId('componentNote').textContent = data.componentNote || '';

    const categories = data.categories || [];
    byId('categoryList').innerHTML = categories.length ? categories.map((item) => `
      <div class="bar-item">
        <span class="bar-label">${escapeHtml(item.label || item.key)}</span>
        <span class="bar-value">${percent(item.share)}・約${yen(item.cost)}（${integer(item.apps)}アプリ）</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, Math.min(100, item.share))}%"></div></div>
      </div>`).join('') : '<p class="muted">分類できるアプリ記録がありません。</p>';

    const apps = (data.applications || []).slice(0, 40);
    const categoryLabels = new Map((data.categoryDefinitions || []).map((item) => [item.key, item.label]));
    byId('applicationRows').innerHTML = apps.length ? apps.map((app) => `
      <tr>
        <td class="app-name" title="${escapeHtml(app.name)}">${escapeHtml(app.name)}</td>
        <td>${percent(app.share)}</td>
        <td>${Number(app.kwh || 0).toFixed(4)}</td>
        <td>${yen(app.cost)}</td>
        <td>${escapeHtml(categoryLabels.get(app.category) || app.category)}</td>
      </tr>`).join('') : '<tr><td colspan="5" class="muted">アプリ記録がありません。</td></tr>';

    const coverage = data.applicationCoverage;
    const windowNote = data.applicationWindow?.rows
      ? `アプリ別記録: ${coverage?.first ? dateTime(coverage.first, { short: true }) : '--'}〜${coverage?.last ? dateTime(coverage.last, { short: true }) : '--'}の${integer(coverage?.rows)}件${coverage?.step > 1 ? `（${coverage.step}件に1件を使用）` : ''}`
      : 'アプリ別の記録がありません';
    byId('applicationNote').textContent = `${data.applicationNote || ''} ${windowNote}`;
    byId('breakdownSummary').textContent = apps.length ? `部品 ${components.length}件・アプリ ${integer(data.applications.length)}件` : 'データ不足';
  }

  function render(data) {
    state.history = data;
    const totals = data.totals || {};
    const quality = data.quality || {};
    const unit = data.config?.displayUnit || 'kwh';

    byId('granularityNote').textContent = `${data.label}・${granularityLabel(data.granularity)}${data.truncated ? '（区間が多いため一部のみ表示）' : ''}`;
    byId('historyChartNote').textContent = data.estimatedNotice || '';
    byId('kpiCost').textContent = `約${money(totals.cost)}円`;
    byId('kpiKwh').textContent = energy(totals.kwh, unit);
    byId('kpiWatts').textContent = `${watts(totals.averageWatts)} W`;
    byId('kpiWattsDetail').textContent = `最大 ${watts(totals.maxWatts)} W・最小 ${watts(totals.minWatts)} W`;
    byId('kpiActive').textContent = duration(totals.activeSeconds);
    byId('kpiActiveDetail').textContent = totals.activeSecondsEstimated ? '1時間平均を含む概算' : '記録があった時間の合計';
    byId('kpiSamples').textContent = integer(quality.samples);
    byId('kpiSamplesDetail').textContent = `区間 ${integer(totals.bucketCount)}・記録のある区間 ${integer(totals.bucketCount - totals.missingBuckets)}`;
    byId('kpiMissing').textContent = duration(quality.missingSeconds);
    byId('kpiMissingDetail').textContent = `予定 ${duration(quality.expectedSeconds)} のうち`;
    byId('kpiQuality').textContent = percent(quality.coveragePercent);
    byId('kpiQualityDetail').textContent = quality.rollupBuckets > 0
      ? `1時間平均の区間 ${integer(quality.rollupBuckets)}件を含む`
      : `欠損区間 ${integer(quality.missingBuckets)}件`;

    renderComparison(data);
    renderChart(data);
    renderTable(data);
    renderInsights(data);
  }

  function renderChart(data) {
    const metric = state.metric;
    const buckets = data.buckets || [];
    const compare = state.compare;
    const points = metric === 'cumulative' ? toCumulative(buckets, compare) : buckets;
    const overlayKey = compare === 'yearAgo' ? 'yearAgoAverageWatts' : 'previousAverageWatts';
    const overlayCostKey = compare === 'yearAgo' ? 'yearAgoCost' : 'previousCost';
    const overlayKwhKey = compare === 'yearAgo' ? 'yearAgoKwh' : 'previousKwh';
    const overlayLabel = compare === 'yearAgo' ? (data.yearAgo?.label || '前年同期間') : (data.previous?.label || '直前の同期間');
    const canCompare = Boolean(compare) && (data.comparison?.comparable || data.yearAgoComparison?.comparable);
    let model = null;

    const title = metric === 'watts' ? `${data.label}の平均電力`
      : metric === 'kwh' ? `${data.label}の電力量`
        : metric === 'cost' ? `${data.label}の推定料金`
          : `${data.label}の累積推定料金`;
    byId('historyChartTitle').textContent = title;
    byId('comparePrevious').disabled = !data.comparison?.comparable;
    byId('compareYearAgo').disabled = !data.yearAgoComparison?.comparable;

    if (metric === 'watts') {
      const series = [{ key: 'averageWatts', label: '平均W（推定）', color: '#4aa8ff' }, { key: 'maxWatts', label: '最大W', color: '#ffb65b', dashed: true }];
      if (compare && canCompare) series.push({ key: overlayKey, label: overlayLabel, color: '#8f7dff', dashed: true });
      model = drawLineChart(byId('historyChart'), {
        points,
        series,
        height: 320,
        minimumMax: 50,
        fill: 'rgba(74,168,255,.18)',
        gapMs: bucketGapMs(data),
        formatValue: (value) => `${Math.round(value)}W`,
        xLabel: (bucket) => axisLabel(bucket, data.granularity),
      });
    } else if (metric === 'kwh') {
      model = drawBarChart(byId('historyChart'), {
        points,
        height: 320,
        valueOf: (bucket) => bucket.kwh,
        formatValue: (value) => `${value < 1 ? value.toFixed(2) : Math.round(value)}`,
        xLabel: (bucket) => axisLabel(bucket, data.granularity),
      });
    } else if (metric === 'cost') {
      model = drawBarChart(byId('historyChart'), {
        points,
        height: 320,
        valueOf: (bucket) => bucket.cost,
        formatValue: (value) => `${Math.round(value)}円`,
        xLabel: (bucket) => axisLabel(bucket, data.granularity),
      });
    } else {
      const series = [{ key: 'cumulativeCost', label: '累積（推定）', color: '#56e0a0' }];
      if (compare && canCompare) series.push({ key: 'cumulativePreviousCost', label: overlayLabel, color: '#8f7dff', dashed: true });
      model = drawLineChart(byId('historyChart'), {
        points,
        series,
        height: 320,
        minimumMax: 1,
        step: true,
        fill: 'rgba(86,224,160,.18)',
        gapMs: bucketGapMs(data),
        formatValue: (value) => `${Math.round(value)}円`,
        xLabel: (bucket) => axisLabel(bucket, data.granularity),
      });
    }

    state.historyModel = model;
    byId('historyChartEmpty').classList.toggle('hidden', Boolean(model));
    if (!model) byId('historyChartEmpty').textContent = 'この期間の記録はありません。';
    const clippedNote = model?.clipped ? ` 突出した最大値（${watts(model.highest)} W）はグラフの上限を超えるため切り取って表示しています。値は表とツールチップで確認できます。` : '';
    byId('historyChartNote').textContent = (metric === 'cumulative'
      ? '選択期間の先頭を0円として積み上げています。記録がない時間は横ばいになります。'
      : `${data.estimatedNotice || ''}${canCompare ? ` ${overlayLabel}を破線で重ねています。` : ''}`) + clippedNote;
    // 使わないキーへの参照を避けるため、比較用の値を保持しておく
    state.historyExtra = { overlayCostKey, overlayKwhKey };
  }

  function bucketGapMs(data) {
    const base = { minute: 60000, hour: 3600000, day: 86400000, month: 32 * 86400000 }[data.granularity] || 3600000;
    return base * 2.5;
  }

  function axisLabel(bucket, granularity) {
    const date = new Date(Number(bucket.timestamp));
    if (granularity === 'month') return `${date.getFullYear()}/${date.getMonth() + 1}`;
    if (granularity === 'day') return `${date.getMonth() + 1}/${date.getDate()}`;
    if (granularity === 'minute') return date.toTimeString().slice(0, 5);
    return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}時`;
  }

  function toCumulative(buckets, compare) {
    let cost = 0;
    let previous = 0;
    const previousKey = compare === 'yearAgo' ? 'yearAgoCost' : 'previousCost';
    return buckets.map((bucket) => {
      if (!bucket.missing) cost += Number(bucket.cost || 0);
      if (bucket[previousKey] != null) previous += Number(bucket[previousKey]);
      return { ...bucket, cumulativeCost: cost, cumulativePreviousCost: compare ? previous : null };
    });
  }

  function renderComparison(data) {
    const body = byId('comparisonBody');
    const status = byId('comparisonStatus');
    const comparison = data.comparison || {};
    const yearAgo = data.yearAgoComparison || {};
    const rows = [];
    for (const [item, label] of [[comparison, '直前の同期間'], [yearAgo, '前年同期間']]) {
      if (!item || item.status === 'no-previous-period') continue;
      if (!item.comparable) {
        rows.push(`<div class="compare-reason"><strong>${escapeHtml(item.label || label)}</strong>: ${escapeHtml(item.reason || '比較できません')}</div>`);
        continue;
      }
      const cls = item.percentCost > 0 ? 'trend-up' : item.percentCost < 0 ? 'trend-down' : '';
      rows.push(`<div class="compare-row"><span>${escapeHtml(item.label || label)}との比較${item.simple ? '（単純比較）' : ''}</span><strong class="${cls}">${signed(item.percentCost, 1, '%')}</strong></div>`)
      rows.push(`<div class="compare-row"><span>${money(item.previousCost)}円 → ${money(item.currentCost)}円</span><span>${signed(item.diffCost, 1, '円')}・${signed(item.percentKwh, 1, '%')}（電力量）</span></div>`);
    }
    body.innerHTML = rows.length ? rows.join('') : '<p class="muted">比較できる期間がありません。</p>';
    status.textContent = comparison.comparable || yearAgo.comparable ? '比較できます'
      : comparison.status === 'no-previous-data' ? '比較データなし'
        : comparison.status === 'insufficient-data' ? '記録不足' : '比較なし';
    status.className = `chip ${(comparison.comparable || yearAgo.comparable) ? '' : 'muted'}`;
  }

  function renderTable(data) {
    const buckets = data.buckets || [];
    const visible = [...buckets].reverse().slice(0, TABLE_LIMIT);
    byId('historyTableSummary').textContent = `${granularityLabel(data.granularity)}・${integer(buckets.length)}区間`;
    byId('historyRows').innerHTML = visible.length ? visible.map((bucket) => {
      const diff = bucket.previousCost != null && !bucket.missing ? Number(bucket.cost) - Number(bucket.previousCost) : null;
      return '<tr>'
        + `<td>${bucketLabel(bucket.timestamp, data.granularity)}</td>`
        + `<td>${bucket.missing ? '--' : watts(bucket.averageWatts)}</td>`
        + `<td>${bucket.missing ? '--' : watts(bucket.maxWatts, 0)}</td>`
        + `<td>${bucket.missing ? '--' : Number(bucket.kwh).toFixed(4)}</td>`
        + `<td>${bucket.missing ? '--' : yen(bucket.cost)}</td>`
        + `<td>${bucket.missing ? '--' : duration(bucket.activeSeconds)}</td>`
        + `<td class="${qualityClass(bucket)}">${qualityLabel(bucket)}</td>`
        + `<td>${diff == null ? '--' : signed(diff, 1, '円')}</td>`
        + '</tr>';
    }).join('') : `<tr><td colspan="8" class="muted">この期間の記録はありません。</td></tr>`;
    byId('historyTableNote').textContent = buckets.length > visible.length
      ? `新しい${integer(visible.length)}区間を表示しています（全${integer(buckets.length)}区間）。CSV出力で全件保存できます。`
      : '「記録なし」は0Wではなく、PC停止・スリープ・計測停止です。CSV出力で全件保存できます。';
  }

  function renderInsights(data) {
    const events = data.events || [];
    byId('eventList').innerHTML = events.length ? events.map((event) => {
      const time = data.granularity === 'day' || data.granularity === 'month'
        ? bucketLabel(event.timestamp, data.granularity)
        : dateTime(event.timestamp, { short: true });
      return `<div class="list-item"><strong>${time}</strong><span>最大 ${watts(event.maxWatts)}W・平均 ${watts(event.averageWatts)}W</span></div>`;
    }).join('') : '<p class="muted">この期間に目立った急上昇はありません。</p>';

    const idle = data.idle || [];
    byId('idleList').innerHTML = idle.length ? idle.map((run) => `<div class="list-item"><strong>${dateTime(run.start, { short: true })}〜${dateTime(run.end, { timeOnly: true })}</strong><span>${duration(run.seconds)}・平均 ${watts(run.averageWatts)}W</span></div>`).join('')
      : '<p class="muted">2時間以上続いた低負荷はありません。</p>';

    const gaps = data.gaps || [];
    byId('gapList').innerHTML = gaps.length ? gaps.map((gap) => `<div class="list-item"><strong>${dateTime(gap.start, { short: true })}〜${dateTime(gap.end, { short: true })}</strong><span>${duration(gap.seconds)}の記録なし</span></div>`).join('')
      : '<p class="muted">5分以上の記録の空白はありません。</p>';

    byId('insightSummary').textContent = `急上昇 ${events.length}件・長時間アイドル ${idle.length}件・記録なし ${gaps.length}件`;

    const profile = data.hourlyProfile || [];
    drawProfileChart(byId('profileChart'), {
      values: profile.map((item) => (item.missing ? null : item.watts)),
      formatValue: (value) => `${Math.round(value)}W`,
      height: 180,
    });
    const ranked = profile.filter((item) => !item.missing).sort((a, b) => b.watts - a.watts).slice(0, 4);
    byId('profileList').innerHTML = ranked.length
      ? ranked.map((item) => `<div class="list-item"><strong>${item.hour}時台</strong><span>平均 ${watts(item.watts)}W</span></div>`).join('')
      : '<p class="muted">記録がありません。</p>';

    const heatmap = data.heatmap || { cells: [], maxWatts: 0 };
    drawHeatmap(byId('heatmapChart'), { cells: heatmap.cells, maxWatts: heatmap.maxWatts, height: 260 });
    byId('heatmapSummary').textContent = heatmap.cells?.length ? `記録のある組み合わせ ${integer(heatmap.cells.length)}件` : 'データ不足';
  }

  return { load, render };
}
