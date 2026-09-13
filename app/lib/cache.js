'use strict';

// 重い集計（アプリ別配分・部品別など）の短期キャッシュ。
// 画面は数秒ごとに更新するが、元データは1秒ごとにしか増えないため、
// 同じ期間の再計算を避けて表示を軽く保つ。

function createCache(options = {}) {
  const ttlMs = Number(options.ttlMs || 120000);
  const maxEntries = Number(options.maxEntries || 32);
  const store = new Map();

  function get(key, producer) {
    const now = Date.now();
    const hit = store.get(key);
    if (hit && now - hit.time < ttlMs) return { value: hit.value, cached: true, ageMs: now - hit.time };
    const value = producer();
    store.set(key, { time: now, value });
    if (store.size > maxEntries) {
      const oldest = [...store.entries()].sort((a, b) => a[1].time - b[1].time)[0];
      if (oldest) store.delete(oldest[0]);
    }
    return { value, cached: false, ageMs: 0 };
  }

  return {
    get,
    clear: () => store.clear(),
    size: () => store.size,
    ttlMs,
  };
}

module.exports = { createCache };
