'use strict';

// 通常ログ（人が読む）と詳細ログ（技術情報）を分離して扱う。
// 通常ログには長い標準出力・個人名・PC名・絶対パス・秘密情報・スタックトレースを出さない。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_LOG_BYTES = 512 * 1024;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createSanitizer(extraPaths = []) {
  const replacements = [];
  const add = (from, to) => {
    const text = String(from || '').trim();
    if (text.length >= 3) replacements.push([text, to]);
  };
  try { add(os.homedir(), '%USERPROFILE%'); } catch (_) {}
  for (const value of extraPaths) add(value, '%APP_DIR%');
  let hostname = '';
  let username = '';
  try { hostname = os.hostname(); } catch (_) {}
  try { username = os.userInfo().username; } catch (_) {}
  add(hostname, '%COMPUTERNAME%');
  if (username && username.length >= 3 && username.toLowerCase() !== 'system') add(username, '%USERNAME%');
  replacements.sort((a, b) => b[0].length - a[0].length);
  return (value) => {
    let text = String(value ?? '');
    for (const [from, to] of replacements) {
      text = text.replace(new RegExp(escapeRegExp(from), 'gi'), to);
    }
    // 念のため: 認証情報らしき文字列と長大なバイト列は残さない
    text = text.replace(/\b(bearer|token|apikey|api_key|password)\b\s*[:=]\s*\S+/gi, '$1: ***');
    return text;
  };
}

function oneLine(value, limit = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function rotateIfNeeded(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= MAX_LOG_BYTES) return;
    fs.renameSync(filePath, `${filePath}.1`);
  } catch (_) {}
}

function createLogger(options = {}) {
  const dir = options.dir;
  const sanitize = createSanitizer(options.paths || []);
  const normalPath = path.join(dir, 'app.log');
  const detailPath = path.join(dir, 'debug.log');
  let echo = options.echo !== false;

  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

  function append(filePath, line) {
    rotateIfNeeded(filePath);
    try { fs.appendFileSync(filePath, `${line}\n`, 'utf8'); } catch (_) {}
  }

  function write(level, message) {
    const text = oneLine(sanitize(message));
    const line = `[${timestamp()}][${level}] ${text}`;
    append(normalPath, line);
    if (echo) {
      const stream = level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout;
      try { stream.write(`[${level}] ${text}\n`); } catch (_) {}
    }
    return line;
  }

  const logger = {
    normalPath,
    detailPath,
    info: (message) => write('INFO', message),
    ok: (message) => write('OK', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
    setEcho: (value) => { echo = Boolean(value); },
    // 詳細ログ: エラー種別・発生箇所・HTTPステータス・センサー取得結果・例外の技術情報
    detail(event, data = {}) {
      const payload = { time: new Date().toISOString(), event };
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined) continue;
        if (value instanceof Error) {
          payload[key] = { name: value.name, message: sanitize(value.message), stack: sanitize(value.stack || '') };
        } else if (value && typeof value === 'object') {
          payload[key] = JSON.parse(sanitize(JSON.stringify(value)));
        } else {
          payload[key] = sanitize(value);
        }
      }
      append(detailPath, JSON.stringify(payload));
      return payload;
    },
    sanitize,
    // 画面上で確認するための末尾読み出し（通常ログは行テキスト、詳細ログはJSON）
    read(kind, limit = 200) {
      const filePath = kind === 'detail' ? detailPath : normalPath;
      try {
        const text = fs.readFileSync(filePath, 'utf8');
        const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
        const tail = lines.slice(-Math.max(1, Math.min(1000, limit)));
        if (kind !== 'detail') return { kind: 'normal', lines: tail, total: lines.length, path: normalPath };
        return {
          kind: 'detail',
          total: lines.length,
          path: detailPath,
          entries: tail.map((line) => {
            try { return JSON.parse(line); } catch (_) { return { raw: line }; }
          }),
        };
      } catch (_) {
        return kind === 'detail'
          ? { kind: 'detail', entries: [], total: 0, path: detailPath }
          : { kind: 'normal', lines: [], total: 0, path: normalPath };
      }
    },
  };

  return logger;
}

module.exports = { createLogger, createSanitizer, oneLine };
