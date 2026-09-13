// canvasを使った軽量なグラフ。外部ライブラリは使わない。
// 記録がない区間は線をつながず、ホバー／タップで値を確認できるようにする。

const PAD = { left: 56, right: 16, top: 26, bottom: 34 };

function prepare(canvas, fallbackHeight = 280) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(280, rect.width || 280);
  const height = Number(canvas.getAttribute('height') || fallbackHeight);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const normalized = value / base;
  // 1-2-5 だけだと 200W のデータで軸が500Wになり、線が下に張り付いて見える。
  // 細かい刻みから選び、データに対して軸が離れすぎないようにする。
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const step = steps.find((candidate) => normalized <= candidate) ?? 10;
  return step * base;
}

// 突出した1点だけで軸が伸びてしまうのを防ぐ。
// 上位1%を超えて飛び抜けている場合は、その点を切り取って表示する（値はツールチップで確認できる）。
function axisMaximum(values, minimumMax) {
  const sorted = values.slice().sort((a, b) => a - b);
  const highest = sorted.at(-1) ?? 0;
  const percentile = sorted[Math.max(0, Math.floor(sorted.length * 0.98) - 1)] ?? highest;
  const clipped = sorted.length > 8 && highest > percentile * 3;
  const base = clipped ? percentile : highest;
  return {
    maximum: niceMax(Math.max(minimumMax ?? 0, base * 1.1, 0.01)),
    clipped,
    highest,
  };
}

function drawAxes(ctx, width, height, maxValue, formatValue) {
  const plotWidth = width - PAD.left - PAD.right;
  const plotHeight = height - PAD.top - PAD.bottom;
  ctx.font = '11px "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let step = 0; step <= 4; step += 1) {
    const y = PAD.top + plotHeight * step / 4;
    const value = maxValue * (1 - step / 4);
    ctx.strokeStyle = 'rgba(143,160,184,.16)';
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(width - PAD.right, y);
    ctx.stroke();
    ctx.fillStyle = '#8fa0b8';
    ctx.fillText(formatValue(value), PAD.left - 8, y);
  }
  return { left: PAD.left, right: PAD.right, top: PAD.top, bottom: PAD.bottom, plotWidth, plotHeight };
}

function drawXLabels(ctx, area, height, positions, labels) {
  if (!positions.length) return;
  const maxLabels = Math.max(2, Math.floor(area.plotWidth / 78));
  const step = Math.max(1, Math.ceil((positions.length - 1) / Math.max(1, maxLabels - 1)));
  const indexes = [];
  for (let index = 0; index < positions.length; index += step) indexes.push(index);
  if (indexes.at(-1) !== positions.length - 1) indexes.push(positions.length - 1);
  ctx.font = '10px "Segoe UI", sans-serif';
  ctx.fillStyle = '#8fa0b8';
  ctx.textBaseline = 'bottom';
  for (const index of indexes) {
    ctx.textAlign = index === 0 ? 'left' : index === positions.length - 1 ? 'right' : 'center';
    ctx.fillText(labels[index], positions[index], height - 6);
  }
}

function legend(ctx, area, series) {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = '11px "Segoe UI", sans-serif';
  let x = area.left;
  for (const item of series) {
    ctx.fillStyle = item.color;
    ctx.fillRect(x, 6, 10, 3);
    ctx.fillStyle = '#8fa0b8';
    ctx.fillText(item.label, x + 15, 0);
    x += ctx.measureText(item.label).width + 42;
  }
}

function valueOf(point, key) {
  const value = point?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// 折れ線（欠損区間は線を切る）
export function drawLineChart(canvas, options) {
  const { ctx, width, height } = prepare(canvas, options.height);
  const { points = [], series = [], xMode = 'index', gapMs = Infinity } = options;
  const values = [];
  for (const point of points) {
    for (const item of series) {
      const value = valueOf(point, item.key);
      if (value !== null) values.push(value);
    }
  }
  const axis = axisMaximum(values, options.minimumMax ?? 10);
  const maximum = axis.maximum;
  const area = drawAxes(ctx, width, height, maximum, options.formatValue || ((value) => String(Math.round(value))));
  if (!points.length || !values.length) return null;

  const firstStamp = Number(points[0].timestamp);
  const lastStamp = Number(points.at(-1).timestamp);
  const span = Math.max(1, lastStamp - firstStamp);
  const xPositions = points.map((point, index) => (xMode === 'time'
    ? area.left + (Number(point.timestamp) - firstStamp) / span * area.plotWidth
    : area.left + (points.length === 1 ? 0 : index / (points.length - 1) * area.plotWidth)));

  const fillSeries = options.fill ? series[0] : null;
  if (fillSeries) {
    const gradient = ctx.createLinearGradient(0, area.top, 0, area.top + area.plotHeight);
    gradient.addColorStop(0, options.fill);
    gradient.addColorStop(1, 'rgba(74,168,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    let started = false;
    points.forEach((point, index) => {
      const value = valueOf(point, fillSeries.key);
      if (value === null) { started = false; return; }
      const y = area.top + (1 - value / maximum) * area.plotHeight;
      if (!started) { ctx.moveTo(xPositions[index], area.top + area.plotHeight); ctx.lineTo(xPositions[index], y); started = true; return; }
      ctx.lineTo(xPositions[index], y);
    });
    const lastPoint = [...points].reverse().find((point) => valueOf(point, fillSeries.key) !== null);
    if (lastPoint && started) {
      const lastIndex = points.lastIndexOf(lastPoint);
      ctx.lineTo(xPositions[lastIndex], area.top + area.plotHeight);
      ctx.closePath();
      ctx.fill();
    }
  }

  for (const item of series) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.plotWidth, area.plotHeight);
    ctx.clip();
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash(item.dashed ? [5, 4] : []);
    ctx.beginPath();
    let drawing = false;
    let previousStamp = null;
    let previousY = null;
    points.forEach((point, index) => {
      const value = valueOf(point, item.key);
      if (value === null) { drawing = false; previousStamp = null; previousY = null; return; }
      const stamp = Number(point.timestamp);
      const x = xPositions[index];
      const y = area.top + (1 - value / maximum) * area.plotHeight;
      const tooFar = previousStamp !== null && stamp - previousStamp > gapMs;
      if (!drawing || tooFar) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        if (options.step && previousY !== null) ctx.lineTo(x, previousY);
        ctx.lineTo(x, y);
      }
      previousStamp = stamp;
      previousY = y;
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  legend(ctx, area, series);
  const labels = points.map((point, index) => (options.xLabel ? options.xLabel(point, index) : ''));
  drawXLabels(ctx, area, height, xPositions, labels);
  return { points, xPositions, area, series, maximum, clipped: axis.clipped, highest: axis.highest };
}

// 棒グラフ（区間ごとの料金・電力量など）
export function drawBarChart(canvas, options) {
  const { ctx, width, height } = prepare(canvas, options.height);
  const points = options.points || [];
  const values = points.map((point) => Number(options.valueOf(point))).filter(Number.isFinite);
  const axis = axisMaximum(values, options.minimumMax ?? 0.05);
  const maximum = axis.maximum;
  const area = drawAxes(ctx, width, height, maximum, options.formatValue || ((value) => String(Math.round(value))));
  if (!points.length) return null;
  const slot = area.plotWidth / points.length;
  const barWidth = Math.max(2, Math.min(30, slot * 0.7));
  const gradient = ctx.createLinearGradient(0, area.top, 0, area.top + area.plotHeight);
  gradient.addColorStop(0, '#56e0a0');
  gradient.addColorStop(1, '#2388e6');
  const xPositions = [];
  points.forEach((point, index) => {
    const value = Number(options.valueOf(point));
    const x = area.left + slot * index + (slot - barWidth) / 2;
    xPositions.push(x + barWidth / 2);
    if (!Number.isFinite(value) || value <= 0) return;
    const barHeight = Math.max(1, value / maximum * area.plotHeight);
    ctx.fillStyle = options.colorOf ? options.colorOf(point) : gradient;
    ctx.fillRect(x, area.top + area.plotHeight - barHeight, barWidth, barHeight);
  });
  const labels = points.map((point, index) => (options.xLabel ? options.xLabel(point, index) : ''));
  drawXLabels(ctx, area, height, xPositions, labels);
  return { points, xPositions, area, maximum, clipped: axis.clipped, highest: axis.highest };
}

// 24時間の平均パターン
export function drawProfileChart(canvas, options) {
  const { ctx, width, height } = prepare(canvas, options.height || 180);
  const values = (options.values || []).filter((value) => Number.isFinite(value));
  const maximum = niceMax(Math.max(50, ...values) * 1.1);
  const area = drawAxes(ctx, width, height, maximum, options.formatValue || ((value) => String(Math.round(value))));
  const slot = area.plotWidth / 24;
  const barWidth = Math.max(3, slot * 0.62);
  const gradient = ctx.createLinearGradient(0, area.top, 0, area.top + area.plotHeight);
  gradient.addColorStop(0, '#4aa8ff');
  gradient.addColorStop(1, '#1d4f80');
  const xPositions = [];
  (options.values || []).forEach((value, hour) => {
    const x = area.left + slot * hour + (slot - barWidth) / 2;
    xPositions.push(x + barWidth / 2);
    if (!Number.isFinite(value)) return;
    const barHeight = Math.max(1, value / maximum * area.plotHeight);
    ctx.fillStyle = gradient;
    ctx.fillRect(x, area.top + area.plotHeight - barHeight, barWidth, barHeight);
  });
  drawXLabels(ctx, area, height, xPositions, Array.from({ length: 24 }, (_, hour) => `${hour}時`));
  return { xPositions, area };
}

// 曜日×時間のヒートマップ
export function drawHeatmap(canvas, options) {
  const { ctx, width, height } = prepare(canvas, options.height || 260);
  const cells = options.cells || [];
  const maximum = Math.max(1, options.maxWatts || 0);
  const left = 46;
  const top = 24;
  const cellWidth = Math.max(18, (width - left - 12) / 24);
  const cellHeight = Math.max(20, (height - top - 24) / 7);
  ctx.font = '10px "Segoe UI", sans-serif';
  ctx.fillStyle = '#8fa0b8';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  // セルが狭いときはラベルを間引いて重ならないようにする
  const labelStep = cellWidth < 20 ? 3 : cellWidth < 26 ? 2 : 1;
  for (let hour = 0; hour < 24; hour += 1) {
    if (hour % labelStep !== 0) continue;
    ctx.fillText(String(hour), left + cellWidth * (hour + 0.5), top - 6);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    ctx.fillText(weekdays[weekday], left - 8, top + cellHeight * (weekday + 0.5));
  }
  const byKey = new Map(cells.map((cell) => [`${cell.weekday}-${cell.hour}`, cell]));
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const cell = byKey.get(`${weekday}-${hour}`);
      const x = left + cellWidth * hour;
      const y = top + cellHeight * weekday;
      if (!cell || !cell.samples) {
        ctx.fillStyle = 'rgba(255,255,255,.04)';
        ctx.fillRect(x + 1, y + 1, cellWidth - 2, cellHeight - 2);
        continue;
      }
      const ratio = Math.max(0, Math.min(1, cell.watts / maximum));
      const color = `rgba(${Math.round(30 + 226 * ratio)},${Math.round(120 + 40 * (1 - ratio))},${Math.round(230 - 140 * ratio)},${0.22 + 0.7 * ratio})`;
      ctx.fillStyle = color;
      ctx.fillRect(x + 1, y + 1, cellWidth - 2, cellHeight - 2);
    }
  }
  return { left, top, cellWidth, cellHeight, cells };
}

// グラフのホバー／タップ表示
export function bindInteractive(canvas, options) {
  const { crosshair, tooltip, onLeave } = options;
  let model = null;

  function hide() {
    if (crosshair) crosshair.classList.add('hidden');
    if (tooltip) tooltip.classList.add('hidden');
    if (onLeave) onLeave();
  }

  function handle(event) {
    model = options.getModel ? options.getModel() : model;
    if (!model || !model.points?.length) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = event.clientX ?? event.touches?.[0]?.clientX;
    if (!Number.isFinite(clientX)) return;
    const x = clientX - rect.left;
    let nearest = 0;
    let best = Infinity;
    model.xPositions.forEach((position, index) => {
      const distance = Math.abs(position - x);
      if (distance < best) { best = distance; nearest = index; }
    });
    const position = model.xPositions[nearest];
    if (crosshair) {
      crosshair.style.left = `${position}px`;
      crosshair.style.height = `${model.area.plotHeight}px`;
      crosshair.style.top = `${model.area.top}px`;
      crosshair.classList.remove('hidden');
    }
    if (tooltip && options.format) {
      tooltip.innerHTML = options.format(model.points[nearest], nearest, model);
      tooltip.classList.remove('hidden');
      const tooltipWidth = tooltip.offsetWidth || 200;
      tooltip.style.left = `${Math.max(6, Math.min(rect.width - tooltipWidth - 6, position + (position > rect.width * 0.6 ? -tooltipWidth - 12 : 12)))}px`;
      tooltip.style.top = '26px';
    }
  }

  canvas.addEventListener('pointermove', handle);
  canvas.addEventListener('pointerdown', handle);
  canvas.addEventListener('pointerleave', hide);
  canvas.addEventListener('pointercancel', hide);
  return { hide, show: handle };
}
