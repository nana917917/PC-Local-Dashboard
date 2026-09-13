'use strict';

// 実装後の最低限の静的検証。
//   - JavaScript / JSON / HTML / CSS の構文
//   - HTMLのID重複と、JSが参照するIDの存在
//   - 参照しているファイルが実在するか（404になる静的ファイル）
//   - 画面から呼ばれていないAPI、存在しないAPIの呼び出し
//   - デバッグ出力の残骸
//   - PowerShellスクリプトの構文（利用可能な場合）

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const appDir = path.join(root, 'app');
const publicDir = path.join(appDir, 'public');
const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function walk(dir, filter, list = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, list);
    else if (filter(full)) list.push(full);
  }
  return list;
}

// ---------------------------------------------------------------- JS/JSON

const jsFiles = [
  ...walk(appDir, (file) => file.endsWith('.js')),
  ...walk(path.join(root, 'tests'), (file) => file.endsWith('.js')),
];
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    fail(`JS構文エラー: ${path.relative(root, file)}\n${String(error.stderr || error.message).trim()}`);
  }
}

const jsonFiles = [
  path.join(root, 'package.json'),
  path.join(appDir, 'config.json'),
  path.join(publicDir, 'manifest.webmanifest'),
];
for (const file of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`JSON構文エラー: ${path.relative(root, file)} — ${error.message}`);
  }
}

// ---------------------------------------------------------------- HTML

const htmlFiles = walk(publicDir, (file) => file.endsWith('.html'))
  .concat(walk(path.join(appDir, 'storage-map'), (file) => file.endsWith('.html')));
const htmlById = {};
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) fail(`HTMLのID重複: ${path.relative(root, file)} — ${[...new Set(duplicates)].join(', ')}`);
  htmlById[file] = new Set(ids);

  // 参照している静的ファイルの存在確認
  const fileRoot = path.dirname(file);
  for (const match of html.matchAll(/(?:href|src)="(\/[^"#?]+)"/g)) {
    const target = match[1];
    if (target.startsWith('/api/')) continue;
    const resolved = path.join(fileRoot, target.replace(/^\//, ''));
    if (!fs.existsSync(resolved)) fail(`参照先が見つかりません: ${path.relative(root, file)} → ${target}`);
  }
  // タグの閉じ忘れ（主要タグのみ）
  for (const tag of ['section', 'div', 'table', 'dialog', 'main', 'form']) {
    const open = (html.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    if (open !== close) fail(`HTMLタグの対応が合いません: ${path.relative(root, file)} <${tag}> ${open} 対 ${close}`);
  }
}

// 画面のJSが参照するIDがHTMLに存在するか
const mainHtml = path.join(publicDir, 'index.html');
const mainIds = htmlById[mainHtml];
if (mainIds) {
  const frontEndFiles = walk(path.join(publicDir, 'js'), (file) => file.endsWith('.js'));
  const dynamic = new Set(['settingsDialog', 'helpDialog', 'storageFrame', 'customRange', 'deleteFrom', 'deleteTo']);
  const checked = new Set([...frontEndFiles, mainHtml]);
  for (const file of frontEndFiles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/byId\('([^']+)'\)|getElementById\('([^']+)'\)/g)) {
      const id = match[1] || match[2];
      if (!id) continue;
      if (dynamic.has(id)) continue;
      if (!mainIds.has(id)) fail(`HTMLに存在しないIDを参照しています: ${path.relative(root, file)} → ${id}`);
    }
  }
  if (!checked.size) notes.push('画面ファイルが見つかりませんでした。');
}

// ---------------------------------------------------------------- CSS

const cssFiles = walk(publicDir, (file) => file.endsWith('.css'));
for (const file of cssFiles) {
  const css = fs.readFileSync(file, 'utf8');
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  if (open !== close) fail(`CSSの波かっこが合いません: ${path.relative(root, file)} { ${open} 対 } ${close}`);
  if (/[^\x00-\x7F]/.test(css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"[^"]*"/g, '').replace(/'[^']*'/g, ''))) {
    notes.push(`${path.relative(root, file)} に日本語が含まれています（コメント以外は意図しない可能性があります）`);
  }
}

// ---------------------------------------------------------------- API

const serverSource = fs.readFileSync(path.join(appDir, 'server.js'), 'utf8');
const declared = new Set([...serverSource.matchAll(/url\.pathname === '(\/api\/[^']+)'/g)].map((match) => match[1]));
const frontEndSource = walk(path.join(publicDir, 'js'), (file) => file.endsWith('.js'))
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n')
  + htmlFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const used = new Set([...frontEndSource.matchAll(/['"](\/api\/[a-z0-9./-]+)['"]/g)].map((match) => match[1]));
for (const endpoint of used) {
  if (!declared.has(endpoint)) fail(`画面が存在しないAPIを呼んでいます: ${endpoint}`);
}
for (const endpoint of declared) {
  if (used.has(endpoint)) continue;
  if (endpoint === '/api/ping') continue;
  notes.push(`画面から使われていないAPI: ${endpoint}`);
}

// ---------------------------------------------------------------- debug leftovers

for (const file of jsFiles) {
  if (file.includes(`${path.sep}tests${path.sep}`)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/console\.(log|debug|info)\(/.test(line)) fail(`デバッグ出力が残っています: ${path.relative(root, file)}:${index + 1}`);
  });
  if (/\bdebugger\b/.test(text)) fail(`debugger文が残っています: ${path.relative(root, file)}`);
}

// ---------------------------------------------------------------- PowerShell

for (const file of fs.readdirSync(root).filter((name) => name.endsWith('.ps1'))) {
  const full = path.join(root, file);
  try {
    const command = `$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${full.replace(/'/g, "''")}', [ref]$null, [ref]$errors); if ($errors -and $errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }`;
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', command], { stdio: 'pipe' });
  } catch (error) {
    const message = String(error.stdout || error.stderr || error.message).trim().split('\n')[0];
    if (/Parser|ParseFile/.test(message) && /not recognized|認識されません/.test(message)) {
      notes.push(`PowerShell構文チェックを実行できませんでした: ${file}`);
    } else {
      fail(`PowerShell構文エラー: ${file} — ${message}`);
    }
  }
}

// ---------------------------------------------------------------- 機密ファイル

const forbidden = ['WattSeal.exe', 'power_monitoring.db', 'setup-log.txt'];
for (const name of forbidden) {
  if (fs.existsSync(path.join(appDir, name))) fail(`配布物に含めてはいけないファイルがあります: app/${name}`);
}

// ---------------------------------------------------------------- 結果

if (notes.length) {
  console.log('# 参考情報');
  for (const note of notes) console.log(`  - ${note}`);
}
if (problems.length) {
  console.error(`# 問題 ${problems.length}件`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`静的チェック: OK（JS ${jsFiles.length}ファイル・HTML ${htmlFiles.length}ファイル・CSS ${cssFiles.length}ファイル）`);
}
