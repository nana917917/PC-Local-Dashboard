'use strict';

// 設定の読み書き。既存 v0.11 系 config.json と互換のキーを維持し、
// 未知のキーは保存時に消さない（将来のキー追加で壊れないようにする）。

const fs = require('node:fs');
const path = require('node:path');
const { normalizeNetworkList } = require('./security');

const APP_CATEGORIES = Object.freeze([
  { key: 'game', label: 'ゲーム' },
  { key: 'browser', label: 'ブラウザー' },
  { key: 'video', label: '動画・音楽' },
  { key: 'dev', label: '開発' },
  { key: 'work', label: '仕事・制作' },
  { key: 'file', label: 'ファイル処理' },
  { key: 'communication', label: '通話・連絡' },
  { key: 'system', label: 'Windows・常駐' },
  { key: 'other', label: 'その他・未分類' },
]);

const CATEGORY_BY_KEY = new Map(APP_CATEGORIES.map((item) => [item.key, item]));

const RANGE_KEYS = Object.freeze([
  'session', 'today', 'yesterday', '7d', '30d', '90d', 'month', 'lastMonth',
  'thisYear', 'year', 'lastYear', 'all', 'custom',
]);
const DISPLAY_UNITS = Object.freeze(['kwh', 'wh']);

const DEFAULT_CONFIG = Object.freeze({
  // --- v0.11 互換キー ---
  electricityRate: 31,
  sensorFactor: 1.10,
  baseWatts: 25,
  monitorWatts: 0,
  monthlyBudget: 0,
  lanAccess: false,
  gameKeywords: [
    'steam', 'epicgames', 'riotclient', 'valorant', 'apex', 'genshin',
    'terraria', 'edf', 'earthdefenseforce', 'darkanddarker', 'mgs', 'metalgear',
  ],
  // --- v0.12 追加キー ---
  defaultRange: 'today',
  displayUnit: 'kwh',
  updateIntervalSeconds: 2,
  lanKeepAlive: false,
  wallCalibration: 1,
  thresholdWatts: 0,
  retentionDays: 0,
  appCategoryMap: {},
  lanAllowedNetworks: [],
});

function numberInRange(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function integerInRange(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function booleanValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.trim().toLowerCase() === 'true') return true;
    if (value.trim().toLowerCase() === 'false') return false;
  }
  return fallback;
}

function oneOf(value, fallback, allowed) {
  return allowed.includes(value) ? value : fallback;
}

function keywordList(value, fallback = []) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,]/) : fallback;
  if (!Array.isArray(source)) return [...fallback];
  return [...new Set(source
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => item.length >= 2 && item.length <= 80))]
    .slice(0, 120);
}

// 「chrome.exe = browser」形式のテキストやオブジェクトを受け取り、安全な対応表に変換する。
function categoryMap(value, fallback = {}) {
  const result = {};
  const entries = [];
  if (typeof value === 'string') {
    for (const line of value.split(/\r?\n/)) {
      const match = line.match(/^\s*(.+?)\s*(?:=|:|\t)\s*(.+?)\s*$/);
      if (match) entries.push([match[1], match[2]]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') entries.push([item.name ?? item.app ?? '', item.category ?? '']);
    }
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) entries.push([key, item]);
  } else {
    return { ...fallback };
  }
  for (const [rawName, rawCategory] of entries.slice(0, 300)) {
    const name = String(rawName || '').trim().toLowerCase().replace(/^"|"$/g, '');
    const category = String(rawCategory || '').trim().toLowerCase().replace(/^"|"$/g, '');
    if (name.length < 2 || name.length > 120) continue;
    if (!CATEGORY_BY_KEY.has(category)) continue;
    result[name] = category;
  }
  return result;
}

function normalizeConfig(source = {}) {
  return {
    electricityRate: numberInRange(source.electricityRate, DEFAULT_CONFIG.electricityRate, 0, 200),
    sensorFactor: numberInRange(source.sensorFactor, DEFAULT_CONFIG.sensorFactor, 0.5, 2),
    baseWatts: numberInRange(source.baseWatts, DEFAULT_CONFIG.baseWatts, 0, 300),
    monitorWatts: numberInRange(source.monitorWatts, DEFAULT_CONFIG.monitorWatts, 0, 500),
    monthlyBudget: numberInRange(source.monthlyBudget, DEFAULT_CONFIG.monthlyBudget, 0, 100000),
    lanAccess: booleanValue(source.lanAccess, DEFAULT_CONFIG.lanAccess),
    gameKeywords: keywordList(source.gameKeywords, DEFAULT_CONFIG.gameKeywords),
    defaultRange: oneOf(source.defaultRange, DEFAULT_CONFIG.defaultRange, RANGE_KEYS),
    displayUnit: oneOf(source.displayUnit, DEFAULT_CONFIG.displayUnit, DISPLAY_UNITS),
    updateIntervalSeconds: integerInRange(source.updateIntervalSeconds, DEFAULT_CONFIG.updateIntervalSeconds, 2, 60),
    lanKeepAlive: booleanValue(source.lanKeepAlive, DEFAULT_CONFIG.lanKeepAlive),
    wallCalibration: numberInRange(source.wallCalibration, DEFAULT_CONFIG.wallCalibration, 0.5, 2),
    thresholdWatts: numberInRange(source.thresholdWatts, DEFAULT_CONFIG.thresholdWatts, 0, 2000),
    retentionDays: integerInRange(source.retentionDays, DEFAULT_CONFIG.retentionDays, 0, 3650),
    appCategoryMap: categoryMap(source.appCategoryMap, DEFAULT_CONFIG.appCategoryMap),
    lanAllowedNetworks: normalizeNetworkList(source.lanAllowedNetworks).map((network) => network.cidr),
  };
}

function createConfigStore(configPath) {
  function readRaw() {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    } catch (_) {
      return {};
    }
  }

  function load() {
    return normalizeConfig(readRaw());
  }

  // 部分的に与えられた入力で更新する。未指定のキーは現在値を維持する。
  function save(input) {
    const raw = readRaw();
    const current = normalizeConfig(raw);
    const merged = { ...current };
    const provided = input && typeof input === 'object' ? input : {};
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (!Object.prototype.hasOwnProperty.call(provided, key)) continue;
      merged[key] = provided[key];
    }
    if (Object.prototype.hasOwnProperty.call(provided, 'appCategoryMap')) {
      merged.appCategoryMap = categoryMap(provided.appCategoryMap, current.appCategoryMap);
    }
    const next = normalizeConfig(merged);
    // 未知のキー（将来のバージョンの設定など）は消さずに残す
    const extras = {};
    for (const [key, value] of Object.entries(provided)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) extras[key] = value;
    }
    const onDisk = { ...raw, ...extras, ...next };
    const tempPath = `${configPath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, configPath);
    return next;
  }

  return { load, save, path: configPath, APP_CATEGORIES };
}

module.exports = {
  APP_CATEGORIES,
  CATEGORY_BY_KEY,
  DEFAULT_CONFIG,
  RANGE_KEYS,
  DISPLAY_UNITS,
  createConfigStore,
  normalizeConfig,
  categoryMap,
  keywordList,
  numberInRange,
};
