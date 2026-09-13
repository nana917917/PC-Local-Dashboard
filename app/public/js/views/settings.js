// 設定・データ管理ダイアログ。読み取り専用（LAN側）では変更操作を無効にする。

import { getJson, postJson, query } from '../api.js';
import { bytes, dateTime, escapeHtml, integer } from '../format.js';

const byId = (id) => document.getElementById(id);
const CALC_FIELDS = ['electricityRate', 'sensorFactor', 'wallCalibration', 'baseWatts', 'monitorWatts', 'monthlyBudget'];
const DISPLAY_FIELDS = ['defaultRange', 'displayUnit', 'updateIntervalSeconds', 'thresholdWatts'];

export function createSettingsView(state, helpers) {
  let access = null;
  let logKind = 'normal';

  async function open() {
    try {
      const [config, status, accessInfo] = await Promise.all([
        getJson('/api/settings'),
        getJson('/api/data-status'),
        getJson('/api/access-info'),
      ]);
      access = accessInfo;
      fillForm(config);
      renderDataStatus(status, config);
      renderAccess(accessInfo, config);
      applyReadOnly(!accessInfo.canWrite);
      await loadLogs();
      byId('settingsDialog').showModal();
    } catch (error) {
      helpers.setStatus(`設定を開けませんでした: ${error.message}`, 'error');
    }
  }

  function fillForm(config) {
    for (const key of [...CALC_FIELDS, ...DISPLAY_FIELDS]) {
      if (byId(key)) byId(key).value = config[key] ?? '';
    }
    byId('gameKeywords').value = (config.gameKeywords || []).join(', ');
    byId('appCategoryMap').value = Object.entries(config.appCategoryMap || {})
      .map(([name, category]) => `${name} = ${category}`)
      .join('\n');
    byId('lanAccess').checked = Boolean(config.lanAccess);
    byId('lanKeepAlive').checked = Boolean(config.lanKeepAlive);
    byId('lanKeepAlive').disabled = !config.lanAccess;
    byId('lanAllowedNetworks').value = (config.lanAllowedNetworks || []).join('\n');
  }

  function renderDataStatus(status, config) {
    const lines = [
      `バージョン <strong>${escapeHtml(status.version)}</strong>`,
      `電力履歴 <strong>${bytes(status.databaseBytes)}</strong>・${integer(status.recordedDays)}日分・${integer(status.samples)}件`,
      `記録開始 ${status.startedAt ? dateTime(status.startedAt) : 'まだありません'}`,
      `容量スキャン結果 <strong>${bytes(status.storageCacheBytes)}</strong>${status.storageCacheUpdatedAt ? `（${dateTime(status.storageCacheUpdatedAt)}）` : ''}`,
      config.retentionDays > 0 ? `保持期間の目安 ${integer(config.retentionDays)}日（自動削除はしません）` : '保持期間の目安 未設定（自動削除はしません）',
    ];
    // LAN側には保存場所（絶対パス）を出さない
    if (status.logDirectory) lines.splice(4, 0, `ログ <code>${escapeHtml(status.logDirectory)}</code>`);
    if (status.databasePath) lines.push(`DB <code>${escapeHtml(status.databasePath)}</code>`);
    if (status.redactedForLan) lines.push('<span>※ スマホ表示のため、保存場所などのPC内情報は表示していません。</span>');
    byId('dataSummary').innerHTML = lines.join('<br>');
    byId('dataWarning').textContent = status.warning || '';
    byId('dataWarning').classList.toggle('hidden', !status.warning);
    const exportQuery = query(rangeParams());
    byId('backupCsv').href = `/api/export${exportQuery}`;
    byId('backupJson').href = `/api/export.json${exportQuery}`;
    byId('deleteFrom').value = byId('deleteFrom').value || '';
  }

  function rangeParams() {
    const params = { range: state.range };
    if (state.range === 'custom') {
      params.from = state.customFrom;
      params.to = state.customTo;
    }
    return params;
  }

  function renderAccess(info, config) {
    const lines = [];
    if (!info.lanAccess) {
      lines.push('<strong>現在はこのPC内だけで開く設定です。</strong>');
      lines.push('上のスイッチを有効にすると、再起動後に同一Wi-Fiのスマホから開けます（LAN側は読み取り専用）。');
    } else {
      lines.push(`<strong>スマホ用URL（読み取り専用）</strong><br>${(info.smartphoneUrls || []).map((url) => `<code>${escapeHtml(url)}</code>`).join('<br>') || 'LAN側のアドレスを取得できませんでした。'}`);
      lines.push('接続できるのは、このPCと同じサブネット（同じWi-Fi）の端末だけです。インターネット公開は行いません。');
      if (info.allowedNetworks?.length) lines.push(`許可しているネットワーク: ${escapeHtml(info.allowedNetworks.join(' / '))}`);
      if (info.extraAllowedNetworks?.length) lines.push(`設定で追加したネットワーク: ${escapeHtml(info.extraAllowedNetworks.join(' / '))}`);
      if (info.excludedVirtualNetworks?.length) lines.push(`<span>仮想アダプター（既定では許可しません）: ${escapeHtml(info.excludedVirtualNetworks.join(' / '))}</span>`);
    }
    lines.push(`<strong>サーバー状態</strong>: 起動から ${Math.round((info.serverState?.uptimeSeconds || 0) / 60)}分・最終アクセス ${dateTime(info.serverState?.lastActivityAt, { timeOnly: true })}`);
    if (info.matchedNetwork) lines.push(`この画面の接続元: <strong>${escapeHtml(info.client || '')}</strong>（${escapeHtml(String(info.matchedNetwork))}）`);
    lines.push(`サーバー維持（常駐）: <strong>${info.keepAlive ? '有効' : '無効'}</strong>${info.keepAlive ? '' : `・ブラウザーを閉じて約${info.idleExitMinutes}分で終了します`}`);
    lines.push(`この画面の権限: <strong>${info.canWrite ? '変更できます（PC内）' : '読み取りのみ（LAN側）'}</strong>`);
    if (config.lanKeepAlive && !config.lanAccess) lines.push('<span>サーバー維持は、スマホ閲覧を有効にしたときだけ働きます。</span>');
    byId('accessInfo').innerHTML = lines.join('<br>');
  }

  function applyReadOnly(readOnly) {
    byId('readOnlyNotice').classList.toggle('hidden', !readOnly);
    for (const element of document.querySelectorAll('#settingsForm input, #settingsForm textarea, #settingsForm select, #settingsForm button[type="submit"]')) {
      element.disabled = readOnly;
    }
    for (const id of ['clearStorageData', 'clearPowerData', 'deleteRange', 'resetAllSettings', 'restartDashboard', 'resetSettings']) {
      const element = byId(id);
      if (element) element.disabled = readOnly;
    }
    if (!readOnly) byId('lanKeepAlive').disabled = !byId('lanAccess').checked;
  }

  async function save(event) {
    event.preventDefault();
    if (!access?.canWrite) return;
    const payload = {};
    for (const key of CALC_FIELDS) payload[key] = byId(key).value;
    for (const key of DISPLAY_FIELDS) payload[key] = byId(key).value;
    payload.gameKeywords = byId('gameKeywords').value;
    payload.appCategoryMap = byId('appCategoryMap').value;
    payload.lanAccess = byId('lanAccess').checked;
    payload.lanKeepAlive = byId('lanKeepAlive').checked;
    payload.lanAllowedNetworks = byId('lanAllowedNetworks').value;
    const result = await postJson('/api/settings', payload);
    byId('settingsDialog').close();
    helpers.setStatus('設定を保存しました。再計算しています…', 'ok');
    await helpers.refreshAll();
    if (result.restartRequired) {
      helpers.setStatus('接続設定を反映するため再起動しています…', 'stale');
      await postJson('/api/restart', {}).catch(() => {});
      setTimeout(() => window.location.reload(), 1800);
    }
  }

  async function resetSettings(formOnly = false) {
    if (!confirm('計算と表示の設定を初期値へ戻しますか？（記録データは消えません）')) return;
    await postJson('/api/reset-settings', {});
    byId('settingsDialog').close();
    helpers.setStatus('設定を初期値へ戻しました。', 'ok');
    await helpers.refreshAll();
  }

  async function clearStorageData() {
    if (!confirm('保存された容量スキャン結果を削除しますか？（ファイル本体は削除しません）')) return;
    await postJson('/api/clear-storage-cache', {});
    state.storageStarted = false;
    const frame = byId('storageFrame');
    if (frame) frame.src = 'about:blank';
    byId('settingsDialog').close();
    helpers.setStatus('容量スキャン結果を削除しました。', 'ok');
    if (helpers.refreshStorage) helpers.refreshStorage();
  }

  async function clearPowerData() {
    if (!confirm('電力履歴をすべて削除します。先にCSV・DBバックアップを保存しましたか？')) return;
    if (!confirm('この操作は元に戻せません。本当にすべての電力履歴を初期化しますか？')) return;
    const typed = prompt('確認のため「削除」と入力してください。');
    if (typed !== '削除') return;
    await postJson('/api/clear-power-history', { confirmation: 'DELETE_POWER_HISTORY' });
    byId('settingsDialog').close();
    helpers.setStatus('電力履歴を初期化しました。WattSealの再開を待っています。', 'stale');
    setTimeout(() => helpers.refreshAll().catch(() => {}), 5000);
  }

  async function deleteRange() {
    const from = byId('deleteFrom').value;
    const to = byId('deleteTo').value;
    if (!from || !to) {
      alert('削除する期間（から・まで）を選んでください。');
      return;
    }
    const fromStamp = new Date(`${from}T00:00:00`).getTime();
    const toStamp = new Date(`${to}T00:00:00`).getTime();
    const start = Math.min(fromStamp, toStamp);
    const end = Math.max(fromStamp, toStamp);
    if (end - start > 3660 * 86400000) {
      alert('期間が長すぎます。');
      return;
    }
    if (!confirm(`${from} 〜 ${to} の記録を削除します。元に戻せません。よろしいですか？`)) return;
    const typed = prompt('確認のため「削除」と入力してください。');
    if (typed !== '削除') return;
    const result = await postJson('/api/delete-range', { from, to, confirmation: 'DELETE_RANGE' });
    byId('settingsDialog').close();
    helpers.setStatus(`${from}〜${to} の記録を削除しました（${integer(result.deletedSamples)}件）。`, 'ok');
    await helpers.refreshAll();
  }

  async function restartDashboard() {
    if (!confirm('表示サーバーを再起動しますか？（LAN設定の変更を反映します）')) return;
    await postJson('/api/restart', {}).catch(() => {});
    helpers.setStatus('サーバーを再起動しています…', 'stale');
    setTimeout(() => window.location.reload(), 1800);
  }

  async function loadLogs() {
    try {
      const data = await getJson('/api/logs', { kind: logKind, limit: 250 });
      if (logKind === 'detail') {
        byId('logOutput').textContent = (data.entries || []).map((entry) => JSON.stringify(entry)).join('\n') || '（詳細ログはまだありません）';
      } else {
        byId('logOutput').textContent = (data.lines || []).join('\n') || '（通常ログはまだありません）';
      }
    } catch (error) {
      byId('logOutput').textContent = `ログを読み込めませんでした: ${error.message}`;
    }
  }

  function setLogKind(kind) {
    logKind = kind;
    for (const button of document.querySelectorAll('[data-log-kind]')) {
      button.classList.toggle('active', button.dataset.logKind === kind);
    }
    return loadLogs();
  }

  return {
    open,
    save,
    resetSettings,
    clearStorageData,
    clearPowerData,
    deleteRange,
    restartDashboard,
    loadLogs,
    setLogKind,
    applyReadOnly,
  };
}
