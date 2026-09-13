// 容量画面: 既存の容量マップをそのまま使い、実行状態と最終スキャンだけを上部に要約する。

import { getJson, postJson } from '../api.js';
import { bytes, dateTime } from '../format.js';

const byId = (id) => document.getElementById(id);

export function createStorageView(state) {
  async function loadStatus() {
    try {
      const status = await getJson('/api/storage-status');
      const scanning = status.scanState === 'scanning' || status.scanning;
      byId('storageState').textContent = scanning ? 'スキャン中' : status.running ? '画面を表示中' : '停止中';
      byId('storageStateDetail').textContent = status.running
        ? 'タブを開いている間だけ動作します'
        : '容量タブを開くと自動で起動します（常駐しません）';
      byId('storageLastScan').textContent = status.lastScanAt ? dateTime(status.lastScanAt) : '--';
      byId('storageLastScanDetail').textContent = status.rootPath ? `対象: ${status.rootPath}` : 'まだスキャンしていません';
      byId('storageCacheSize').textContent = status.lastScanBytes ? bytes(status.lastScanBytes) : '--';
      byId('storageCacheDetail').textContent = '保存されたスキャン結果のサイズ';
      byId('storageDiff').textContent = '比較は画面内で';
      byId('storageDiffDetail').textContent = '同じ場所を再スキャンすると差分が表示されます';
    } catch (error) {
      byId('storageState').textContent = '確認できません';
      byId('storageStateDetail').textContent = error.message;
    }
  }

  async function open(force = false) {
    // 容量マップはフォルダ名・パスを扱うため、PC側（書き込み可能な接続）でのみ開く
    if (state.access && state.access.canWrite === false) {
      byId('storageLocalOnly').classList.remove('hidden');
      byId('storageLoading').classList.add('hidden');
      byId('storageFrame').classList.add('hidden');
      state.storageStarted = false;
      return;
    }
    byId('storageLocalOnly').classList.add('hidden');
    if (state.storageStarted && !force) return;
    state.storageStarted = true;
    const frame = byId('storageFrame');
    const loading = byId('storageLoading');
    frame.classList.add('hidden');
    loading.classList.remove('hidden');
    loading.textContent = '容量画面を起動しています…';
    try {
      const result = await postJson('/api/open-storage', {});
      frame.onload = () => { loading.classList.add('hidden'); frame.classList.remove('hidden'); };
      // 容量サーバーが応答を返せるようになってから読み込む
      // （起動前にiframeを開くと接続エラーがコンソールに出るため）
      const ready = await waitForStorageServer(10);
      if (!ready) {
        loading.textContent = '容量画面の起動を待っています…';
      }
      frame.src = `${result.url}/?embedded=1&t=${Date.now()}`;
      setTimeout(loadStatus, 800);
    } catch (error) {
      loading.textContent = `容量画面を開けませんでした: ${error.message}`;
      state.storageStarted = false;
    }
  }

  async function waitForStorageServer(seconds) {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      try {
        const status = await getJson('/api/storage-status');
        if (status.running) return true;
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return false;
  }

  async function reload() {
    state.storageStarted = false;
    await open(true);
    await loadStatus();
  }

  return { loadStatus, open, reload };
}
