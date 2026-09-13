// 表示用の書式。数値の意味（推定・欠損）を崩さないため、
// 欠損は必ず「--」や「記録なし」で表示し、0 と混同させない。

const number0 = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
const number1 = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 });
const number2 = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 });

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function watts(value, digits = 1) {
  if (!isNumber(value)) return '--';
  return digits === 0 ? number0.format(value) : number1.format(Number(value.toFixed(digits)));
}

export function money(value, digits = 1) {
  if (!isNumber(value)) return '--';
  return number1.format(Number(value.toFixed(digits)));
}

// 料金の表示。1円未満は小数2桁まで見せて「0円」と区別できるようにする。
export function yen(value) {
  if (!isNumber(value)) return '--';
  return Math.abs(value) < 1 ? `${number2.format(value)}円` : `${number1.format(value)}円`;
}

export function integer(value) {
  if (!isNumber(value)) return '--';
  return number0.format(Math.round(value));
}

// kWh は桁が小さいので3桁、Wh表示のときは整数で見せる
export function energy(kwh, unit = 'kwh') {
  if (!isNumber(kwh)) return '--';
  if (unit === 'wh') return `${number0.format(Math.round(kwh * 1000))} Wh`;
  if (Math.abs(kwh) < 1) return `${kwh.toFixed(3)} kWh`;
  return `${number2.format(kwh)} kWh`;
}

export function percent(value, digits = 1) {
  if (!isNumber(value)) return '--';
  return `${value.toFixed(digits)}%`;
}

export function duration(seconds) {
  if (!isNumber(seconds)) return '--';
  const value = Math.max(0, Math.round(seconds));
  if (value >= 86400) return `${Math.floor(value / 86400)}日${Math.floor(value % 86400 / 3600)}時間`;
  if (value >= 3600) return `${Math.floor(value / 3600)}時間${Math.floor(value % 3600 / 60)}分`;
  if (value >= 60) return `${Math.floor(value / 60)}分`;
  return `${value}秒`;
}

export function shortDuration(seconds) {
  if (!isNumber(seconds)) return '--';
  const value = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(value / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
  if (minutes >= 1) return `${minutes}分`;
  return `${value}秒`;
}

export function bytes(value) {
  if (!isNumber(value)) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Math.max(0, value);
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(index >= 3 ? 2 : index >= 2 ? 1 : 0)} ${units[index]}`;
}

export function dateTime(stamp, options = {}) {
  if (!stamp) return '--';
  const date = new Date(Number(stamp));
  if (options.dateOnly) return date.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });
  if (options.timeOnly) return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  if (options.short) return date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return date.toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function bucketLabel(timestamp, granularity) {
  const date = new Date(Number(timestamp));
  if (granularity === 'month') return `${date.getFullYear()}/${date.getMonth() + 1}月`;
  if (granularity === 'day') return date.toLocaleDateString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric' });
  return date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function granularityLabel(granularity) {
  return { minute: '分単位', hour: '時間単位', day: '日単位', month: '月単位' }[granularity] || granularity;
}

// 区間の状態を人に伝わる言葉にする（0・欠損・1時間平均を区別する）
export function qualityLabel(bucket) {
  if (!bucket) return '--';
  if (bucket.missing) return '記録なし';
  if (bucket.quality === 'partial') return `一部欠損（記録${Math.round(bucket.coveragePercent ?? 0)}%）`;
  if (bucket.quality === 'rollup') return '1時間平均の記録';
  if (bucket.quality === 'zero') return '0Wとして記録';
  return '通常（1秒記録）';
}

export function qualityClass(bucket) {
  if (!bucket) return '';
  if (bucket.missing) return 'quality-missing';
  if (bucket.quality === 'partial') return 'quality-partial';
  if (bucket.quality === 'rollup') return 'quality-rollup';
  if (bucket.quality === 'zero') return 'quality-zero';
  return '';
}

export const STATUS_LABELS = {
  ok: '取得済み',
  pending: '取得中',
  stale: '古い値',
  unavailable: '未取得',
  unsupported: '未対応',
  error: 'エラー',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || '--';
}

export function statusClass(status) {
  if (status === 'ok') return '';
  if (status === 'pending') return 'info';
  if (status === 'unavailable' || status === 'unsupported') return 'muted';
  return 'warn';
}

export function signed(value, digits = 1, suffix = '') {
  if (!isNumber(value)) return '--';
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0) return `±${(0).toFixed(digits)}${suffix}`;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(digits)}${suffix}`;
}

export function deltaClass(value) {
  if (!isNumber(value) || Math.abs(Number(value.toFixed(1))) < 0.05) return '';
  return value > 0 ? 'trend-up' : 'trend-down';
}

export function rangeLabel(rangeKey) {
  return {
    session: '今回', today: '今日', yesterday: '昨日', '7d': '直近7日', '30d': '直近30日', '90d': '直近90日',
    month: '今月', lastMonth: '先月', thisYear: '今年', year: '直近1年', lastYear: '前年', all: '全期間', custom: 'カスタム期間',
  }[rangeKey] || rangeKey;
}
