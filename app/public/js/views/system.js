// PC状態画面: 取得できている値と、取得できない理由を必ずセットで表示する。

import { getJson } from '../api.js';
import { drawLineChart } from '../chart.js';
import { bytes, dateTime, duration, escapeHtml, integer, percent, statusClass, statusLabel, watts } from '../format.js';

const byId = (id) => document.getElementById(id);

export function createSystemView(state) {
  async function load() {
    if (!state.system) {
      byId('systemUpdated').textContent = '読み込み中…';
      byId('systemItems').innerHTML = '<p class="muted">PCの状態を取得しています…</p>';
    }
    state.system = await getJson('/api/system', { range: state.systemRange });
    render(state.system);
  }

  function render(data) {
    state.system = data;
    byId('systemUpdated').textContent = `取得 ${dateTime(data.generatedAt, { timeOnly: true })}${data.cached ? '（キャッシュ）' : ''}`;

    byId('systemItems').innerHTML = (data.items || []).map((item) => {
      const value = formatItemValue(item);
      return `<article class="sensor-card ${item.status}">`
        + `<div class="sensor-label"><span>${escapeHtml(item.label)}</span><span class="chip ${statusClass(item.status)}">${statusLabel(item.status)}</span></div>`
        + `<strong>${escapeHtml(value)}</strong>`
        + `<small>${escapeHtml(item.source || '')}${item.updatedAt && item.status !== 'ok' ? `・${dateTime(item.updatedAt, { short: true })}` : ''}</small>`
        + `${item.note ? `<small>${escapeHtml(item.note)}</small>` : ''}`
        + '</article>';
    }).join('');

    const availability = data.usageAvailability || {};
    const available = ['cpu', 'gpu', 'ram'].filter((key) => availability[key]?.available);
    byId('usageAvailability').textContent = available.length
      ? `%・履歴あり: ${available.join(' / ').toUpperCase()}`
      : '使用率の履歴はありません（現在値のみ）';
    const model = drawLineChart(byId('systemChart'), {
      points: data.usageHistory || [],
      series: [
        { key: 'cpu', label: 'CPU', color: '#4aa8ff' },
        { key: 'gpu', label: 'GPU', color: '#56e0a0' },
        { key: 'ram', label: 'RAM', color: '#ffb65b' },
      ],
      height: 260,
      minimumMax: 100,
      xMode: 'time',
      gapMs: state.systemRange === 'today' ? 20 * 60000 : 90000,
      formatValue: (value) => `${Math.round(value)}%`,
      xLabel: (point) => dateTime(point.timestamp, { timeOnly: true }),
    });
    byId('systemChartEmpty').classList.toggle('hidden', Boolean(model));

    const drives = data.drives || [];
    byId('driveList').innerHTML = drives.length ? drives.map((drive) => {
      const used = Math.max(0, drive.total - drive.free);
      const percentUsed = drive.total ? used / drive.total * 100 : 0;
      return '<div class="bar-item">'
        + `<span class="bar-label">${escapeHtml(drive.path)} ${escapeHtml(drive.label || 'ローカルディスク')}</span>`
        + `<span class="bar-value">空き ${bytes(drive.free)} / ${bytes(drive.total)}（使用 ${percent(percentUsed, 0)}）</span>`
        + `<div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, Math.min(100, percentUsed))}%"></div></div>`
        + '</div>';
    }).join('') : '<p class="muted">ドライブ情報を取得できませんでした（管理者権限が必要な場合があります）。</p>';
    byId('driveHealth').textContent = data.driveStatus?.health || statusLabel(data.driveStatus?.status || 'unavailable');
    byId('driveHealth').className = `chip ${data.driveStatus?.health === '正常' ? '' : 'muted'}`;

    const hardware = data.hardware || {};
    const rows = [
      ['CPU', data.cpu?.name || '--'],
      ['CPUコア', data.cpu?.cores ? `${integer(data.cpu.cores)} スレッド` : '--'],
      ['CPUクロック', data.cpu?.clockMhz ? `${integer(data.cpu.clockMhz)} MHz` : '未取得'],
      ['GPU', data.gpu?.name || '未取得'],
      ['メモリ', data.ram?.totalBytes ? `${bytes(data.ram.totalBytes)}（使用 ${bytes(data.ram.usedBytes)}）` : '--'],
      ['OS', hardware.system?.os || '--'],
      ['PC稼働時間', duration(data.uptimeSeconds)],
      ['WattSeal', data.wattseal?.running ? '記録中' : '停止中'],
      ['最終記録', data.wattseal?.latestSample ? `${dateTime(data.wattseal.latestSample)}（${Math.round(data.wattseal.ageSeconds ?? 0)}秒前）` : '--'],
      ['GPU温度', data.gpu?.temperatureC != null ? `${data.gpu.temperatureC} ℃` : '未取得'],
      ['GPU電力', data.gpu?.powerWatts != null ? `${watts(data.gpu.powerWatts)} W` : '未取得'],
    ];
    byId('hardwareList').innerHTML = rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join('');
  }

  function formatItemValue(item) {
    if (item.text) return item.text;
    if (item.value == null) return statusLabel(item.status);
    if (item.key === 'uptime') return duration(item.value);
    if (item.key === 'wattseal') return `${statusLabel(item.status)}（最終 ${Math.round(item.value)}秒前）`;
    if (item.unit === '%') return `${Number(item.value).toFixed(1)} %`;
    if (item.unit === '℃') return `${Number(item.value).toFixed(0)} ℃`;
    if (item.unit === 'MHz') return `${integer(item.value)} MHz`;
    return `${Number(item.value).toFixed(1)} ${item.unit || ''}`.trim();
  }

  return { load, render };
}
