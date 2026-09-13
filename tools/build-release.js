'use strict';

// 配布ZIPを作るための補助スクリプト（Windows専用）。
//   node tools/build-release.js            … dist に展開用フォルダを作って内容を検証
//   node tools/build-release.js --zip      … 検証後、dist にZIPを作成
//
// 個人データ（DB・ログ・PID・WattSeal.exe・node_modules等）は必ず除外する。
// 除外した結果は実行時に一覧表示され、混入があれば終了コード1で失敗する。

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const releaseName = `PC-Local-Dashboard-v${version}`;
const distDir = path.join(root, 'dist');
const stageDir = path.join(distDir, releaseName);
const zipPath = path.join(distDir, `${releaseName}.zip`);

const ITEMS = [
  'app', 'tests', 'tools', 'docs',
  'README.md', 'SPECIFICATION.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
  'CHECK.cmd', 'SETUP.cmd', '初回セットアップ.cmd', 'アンインストール.cmd',
  'install.ps1', 'uninstall.ps1', 'package.json', 'VERSION', '.gitignore',
];

const FORBIDDEN_PATTERNS = [
  { pattern: /(^|\/)\.git(\/|$)/, reason: 'Git管理情報' },
  { pattern: /(^|\/)logs?(\/|$)/i, reason: 'ログ' },
  { pattern: /\.db(-wal|-shm)?$/i, reason: '個人の記録DB' },
  { pattern: /WattSeal\.exe$/i, reason: '同梱しない計測エンジン' },
  { pattern: /(^|\/)node_modules(\/|$)/, reason: '依存関係（同梱不要）' },
  { pattern: /(^|\/)\.env/i, reason: '環境変数・秘密情報' },
  { pattern: /(dashboard|storage-map)\.pid$/i, reason: '実行中PID' },
  { pattern: /node-path\.txt$/i, reason: '端末固有のパス' },
  { pattern: /setup-log\.txt$/i, reason: 'セットアップログ（個人環境の情報）' },
  { pattern: /(^|\/)storage-map\/data(\/|$)/, reason: '容量スキャン結果（個人環境の情報）' },
  { pattern: /\.zip$/i, reason: 'ZIPの重複' },
];

function copyTree(source, target, relative = '') {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      const child = path.join(source, entry);
      const childRelative = relative ? `${relative}/${entry}` : entry;
      if (FORBIDDEN_PATTERNS.some((rule) => rule.pattern.test(childRelative))) {
        console.log(`  除外: ${childRelative}`);
        continue;
      }
      copyTree(child, path.join(target, entry), childRelative);
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function listFiles(dir, base = dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full, base));
    else files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files.sort();
}

function main() {
  fs.mkdirSync(distDir, { recursive: true });
  // 前回のビルド結果が残っていると古いファイルが混入するため、作り直す
  if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  console.log(`配布物を作成します: ${releaseName}`);
  for (const item of ITEMS) {
    const source = path.join(root, item);
    if (!fs.existsSync(source)) continue;
    copyTree(source, path.join(stageDir, item), item);
  }

  const files = listFiles(stageDir);
  const forbidden = files.filter((file) => {
    const rule = FORBIDDEN_PATTERNS.find((candidate) => candidate.pattern.test(file));
    return Boolean(rule);
  });
  const bytes = files.reduce((sum, file) => sum + fs.statSync(path.join(stageDir, file)).size, 0);
  console.log(` ファイル数: ${files.length}`);
  console.log(` 合計サイズ: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  if (forbidden.length) {
    console.error(' 含めてはいけないファイルがあります:');
    for (const file of forbidden) console.error(`   - ${file}`);
    process.exitCode = 1;
    return;
  }
  console.log(' 混入チェック: OK（DB・ログ・WattSeal・PID・秘密情報なし）');

  if (process.argv.includes('--zip')) {
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
    execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-Command',
      `Compress-Archive -LiteralPath '${stageDir}' -DestinationPath '${zipPath}' -CompressionLevel Optimal`,
    ], { stdio: 'inherit' });
    const size = fs.statSync(zipPath).size;
    console.log(` ZIP: ${zipPath}（${(size / 1024).toFixed(1)} KB）`);
  } else {
    console.log(` 展開用フォルダ: ${stageDir}`);
  }
}

main();
