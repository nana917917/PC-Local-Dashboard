// セッション画面: 起動していた区間ごとに、時間・電力・料金・主なアプリを確認する。

import { getJson } from '../api.js';
import { dateTime, duration, energy, escapeHtml, integer, money, percent, watts } from '../format.js';

const byId = (id) => document.getElementById(id);

export function createSessionsView(state) {
  async function load() {
    if (!state.sessions) {
      byId('sessionNote').textContent = 'セッションを読み込んでいます…';
      byId('sessionRows').innerHTML = '<tr><td colspan="10" class="muted">読み込み中…</td></tr>';
    }
    state.sessions = await getJson('/api/sessions', { days: state.sessionDays });
    render(state.sessions);
  }

  function render(data) {
    const sessions = data.sessions || [];
    byId('sessionNote').textContent = [data.note, data.resolutionNote].filter(Boolean).join(' ');
    byId('sessionTableSummary').textContent = `${integer(sessions.length)}件（直近${data.days}日）`;

    byId('sessionCards').innerHTML = sessions.slice(0, 6).map((session) => {
      const apps = (session.topApps || []).slice(0, 3);
      return '<article class="session-card">'
        + `<h3>${dateTime(session.start, { short: true })} 〜 ${dateTime(session.end, { timeOnly: true })}</h3>`
        + `<p class="session-meta">${duration(session.durationSeconds)}・${session.status === 'recording' ? '記録中' : '終了'}</p>`
        + '<dl>'
        + `<div><dt>平均 / 最大</dt><dd>${watts(session.averageWatts)} / ${watts(session.maxWatts)} W</dd></div>`
        + `<div><dt>推定料金</dt><dd>約${money(session.cost)}円</dd></div>`
        + `<div><dt>電力量</dt><dd>${energy(session.kwh)}</dd></div>`
        + `<div><dt>アイドル時間</dt><dd>${duration(session.idleSeconds)}（${percent(session.activeRatio, 0)}が記録時間）</dd></div>`
        + `<div><dt>主なアプリ（推定）</dt><dd>${apps.length ? escapeHtml(apps.map((app) => app.name).join(', ')) : '未分類'}</dd></div>`
        + '</dl></article>';
    }).join('') || '<p class="muted">この期間に1秒記録から復元できるセッションはありません。</p>';

    byId('sessionRows').innerHTML = sessions.length ? sessions.map((session) => '<tr>'
      + `<td>${dateTime(session.start)}</td>`
      + `<td>${dateTime(session.end)}</td>`
      + `<td>${duration(session.durationSeconds)}</td>`
      + `<td>${watts(session.averageWatts)} W</td>`
      + `<td>${watts(session.maxWatts)} W</td>`
      + `<td>${Number(session.kwh || 0).toFixed(4)}</td>`
      + `<td>${money(session.cost)}円</td>`
      + `<td class="app-name" title="${escapeHtml(session.topApp || '')}">${session.topApp ? escapeHtml(session.topApp) : '未分類'}</td>`
      + `<td>${duration(session.idleSeconds)}</td>`
      + `<td>${session.status === 'recording' ? '記録中' : '終了'}</td>`
      + '</tr>').join('') : '<tr><td colspan="10" class="muted">セッションが見つかりません。1時間平均しかない期間は表示できません。</td></tr>';
  }

  return { load, render };
}
