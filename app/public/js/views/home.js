// 概要画面: 初めて見る人が「いまどうなっているか」を最短で分かるようにする。

import { drawLineChart, bindInteractive } from '../chart.js';
import {
  bucketLabel, duration, energy, escapeHtml, granularityLabel, integer, money, percent, signed, watts, dateTime, deltaClass, yen,
} from '../format.js';

const byId = (id) => document.getElementById(id);

export function createHomeView(state, helpers) {
  const liveChart = byId('liveChart');
  bindInteractive(liveChart, {
    crosshair: byId('liveCrosshair'),
    tooltip: byId('liveTooltip'),
    getModel: () => state.liveModel,
    format: (point) => {
      const rate = state.summary?.config?.electricityRate ?? 0;
      return `<strong>${dateTime(point.timestamp)}　${watts(point.watts)} W</strong>`
        + `<small>最大 ${watts(point.maxWatts)} W・データ ${integer(point.samples)}点</small>`
        + `<small>このまま1時間 約${yen(point.watts / 1000 * rate)}</small>`;
    },
  });

  function renderSummary(data) {
    const current = data.current || {};
    const totals = data.totals || {};
    const quality = data.quality || {};
    const config = data.config || {};
    const unit = config.displayUnit || 'kwh';

    byId('homeRangeLabel').textContent = `${data.label}（${granularityLabel(data.granularity)}）`;
    byId('homeSubheading').textContent = `${data.label}の集計です。期間を変えると、料金・グラフ・比較がすべて切り替わります。`;

    const isFresh = current.watts != null && current.reason === 'fresh';
    byId('currentWatts').innerHTML = current.watts == null ? '--<small>W</small>' : `${watts(current.watts)}<small>W</small>`;
    if (current.watts == null) {
      byId('currentDetail').textContent = '現在値は取得できていません';
    } else if (isFresh) {
      byId('currentDetail').textContent = current.ageSeconds < 8 ? '記録中' : `最終取得 ${Math.round(current.ageSeconds)}秒前`;
    } else if (current.reason === 'hourly-rollup') {
      byId('currentDetail').textContent = `最新は1時間平均（${dateTime(current.timestamp)}）`;
    } else {
      byId('currentDetail').textContent = `古い記録（最終 ${dateTime(current.timestamp)}）`;
    }
    byId('currentHourlyCost').textContent = current.watts == null
      ? '1時間続けた場合: --'
      : `1時間続けた場合: 約${yen(current.watts / 1000 * (config.electricityRate || 0))}`;

    byId('periodCostLabel').textContent = `${data.label}の推定料金`;
    byId('periodCost').innerHTML = `${money(totals.cost)}<small>円</small>`;
    byId('periodCostDetail').textContent = `単価 ${config.electricityRate ?? '--'}円/kWh・推定値`;
    byId('periodEnergy').innerHTML = unit === 'wh'
      ? `${integer((totals.kwh ?? 0) * 1000)}<small>Wh</small>`
      : `${(totals.kwh ?? 0).toFixed(3)}<small>kWh</small>`;
    byId('periodEnergyDetail').textContent = `平均 ${watts(totals.averageWatts)} W`;
    byId('periodPeak').textContent = totals.maxWatts == null
      ? '最大 -- W（1時間平均のみの区間は出しません）'
      : `最大 ${watts(totals.maxWatts)} W${totals.maxWattsPartial ? '（1秒記録のある区間）' : ''}`;
    byId('activeTime').textContent = duration(totals.activeSeconds);
    byId('activeTimeDetail').textContent = totals.activeSecondsEstimated
      ? '1時間平均の記録を含むため概算です'
      : '記録のない時間は含みません';
    byId('coverageDetail').textContent = `記録率 ${percent(quality.coveragePercent)}・データ ${integer(quality.samples)}点`;

    const comparison = data.comparison || {};
    const comparisonHost = byId('comparisonValue');
    comparisonHost.classList.remove('trend-up', 'trend-down');
    if (comparison.comparable) {
      comparisonHost.textContent = signed(comparison.percentCost, 1, '%');
      comparisonHost.classList.add(deltaClass(comparison.percentCost));
      byId('comparisonDetail').textContent = `${money(comparison.previousCost)}円 → ${money(comparison.currentCost)}円（${signed(comparison.diffCost, 1, '円')}）`;
      byId('comparisonInline').textContent = `${comparison.label}: ${signed(comparison.percentCost, 1, '%')}${comparison.simple ? '（単純比較）' : ''}`;
    } else {
      comparisonHost.textContent = '比較なし';
      byId('comparisonDetail').textContent = comparison.reason || '比較データがありません';
      byId('comparisonInline').textContent = '比較: データ不足';
    }

    const state_ = data.state || {};
    byId('stateLabel').textContent = state_.label || '--';
    byId('stateDetail').textContent = state_.thresholds
      ? `この期間の目安: ${watts(state_.thresholds.low, 0)}W以下=アイドル / ${watts(state_.thresholds.high, 0)}W以上=高負荷`
      : 'データが増えると判定できます';

    const projection = data.quickStats?.monthProjection;
    if (projection) {
      byId('monthProjection').textContent = `約${money(projection.cost, 0)}円`;
      if (config.monthlyBudget > 0) {
        const remaining = config.monthlyBudget - projection.cost;
        byId('monthProjectionDetail').textContent = remaining >= 0
          ? `目安まで残り ${money(remaining, 0)}円（${energy(projection.kwh, unit)} 見込み）`
          : `目安を ${money(-remaining, 0)}円 超過見込み`;
      } else {
        byId('monthProjectionDetail').textContent = `${energy(projection.kwh, unit)} の見込み（目安未設定）`;
      }
    }

    const peak = data.peak?.cost;
    byId('peakBucket').textContent = peak ? `約${yen(peak.cost)}` : '--';
    byId('peakBucketDetail').textContent = peak
      ? `${bucketLabel(peak.timestamp, peak.granularity || data.granularity)}・平均${watts(peak.averageWatts)}W・${energy(peak.kwh)}`
      : 'この期間の記録がありません';

    const topCategory = (data.applicationCategories || [])[0];
    byId('topCategory').textContent = topCategory?.label || '--';
    byId('topCategoryDetail').textContent = topCategory
      ? `${percent(topCategory.share)}・約${money(topCategory.cost)}円（推定）`
      : 'アプリの記録がありません';

    const peakWatts = data.peak?.watts;
    byId('livePeak').textContent = peakWatts ? `${watts(peakWatts.maxWatts)} W` : '-- W';
    byId('livePeakDetail').textContent = peakWatts
      ? `${bucketLabel(peakWatts.timestamp, data.granularity)}の瞬間最大`
      : '記録待ち';

    helpers.renderWarnings(data.warnings || []);
    helpers.setStateChips(data);
  }

  // 初回読み込み中であることを画面上で伝える（空のデータと区別する）
  function renderLoading() {
    byId('liveChartEmpty').classList.remove('hidden');
    byId('liveChartEmpty').textContent = '記録を読み込んでいます…';
    byId('currentDetail').textContent = '読み込み中…';
    byId('stateDetail').textContent = '読み込み中…';
    byId('comparisonDetail').textContent = '読み込み中…';
    byId('peakBucketDetail').textContent = '読み込み中…';
    byId('liveComponentDetail').textContent = '読み込み中…';
    byId('liveApplicationDetail').textContent = '読み込み中…';
    byId('livePeakDetail').textContent = '読み込み中…';
    helpers.setStatus('ローカルデータを読み込んでいます…');
  }

  function renderRealtime(data) {
    const point = data.leaders?.application;
    const component = data.leaders?.component;
    byId('liveApplication').textContent = point?.name || '--';
    byId('liveApplicationDetail').textContent = point ? `約${watts(point.watts)} W（推定配分）` : 'アプリの記録がありません';
    byId('liveComponent').textContent = component?.name || '--';
    byId('liveComponentDetail').textContent = component ? `約${watts(component.watts)} W（推定）` : '部品の記録がありません';
    if (data.peak) {
      byId('livePeak').textContent = `${watts(data.peak.watts)} W`;
      byId('livePeakDetail').textContent = `${dateTime(data.peak.timestamp, { timeOnly: true })}・直近${data.minutes}分`;
    }
    state.liveModel = drawLineChart(byId('liveChart'), {
      points: data.points || [],
      series: [{ key: 'watts', label: 'PC全体（推定）', color: '#56e0a0' }],
      unit: 'W',
      height: 240,
      minimumMax: 50,
      fill: 'rgba(86,224,160,.22)',
      xMode: 'time',
      gapMs: state.liveMinutes <= 5 ? 8000 : state.liveMinutes <= 15 ? 20000 : 60000,
      formatValue: (value) => `${Math.round(value)}W`,
      xLabel: (item) => dateTime(item.timestamp, { timeOnly: true }),
    });
    byId('liveChartEmpty').classList.toggle('hidden', Boolean(state.liveModel));
    byId('liveChartNote').textContent = (data.points || []).length
      ? `直近${data.minutes}分の記録です。線が途切れている時間は、PC停止・スリープ・計測停止の可能性があります。`
      : '直近の記録がありません。WattSealが動作しているか「PC状態」タブで確認できます。';
  }

  return {
    renderSummary,
    renderRealtime,
    renderLoading,
    hideLiveTooltip: () => byId('liveTooltip').classList.add('hidden'),
  };
}
