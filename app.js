"use strict";

const config = window.READ_SENSOR_CONFIG;
const $ = (id) => document.getElementById(id);
const state = {
  device: config.defaultDevice,
  metric: config.defaultMetric,
  readings: [],
  chart: null,
  distributionChart: null,
  distributionMeta: [],
  normalizeTemperature: false,
  sensorRollingWindow: false,
  sensorWindowMs: 24 * 60 * 60 * 1000,
  sensorWindowKey: "24h",
  sensorDataLimit: 500,
  sensorAverageMinutes: 0,
  sensorTableRows: [],
  map: null,
  mapGrid: null,
};

function apiUrl(path, parameters = {}) {
  const url = new URL(path, `${config.apiBase}/`);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function fetchJson(path, parameters = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(apiUrl(path, parameters), {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function setStatus(message, kind = "") {
  $("live").textContent = message;
  $("live").className = `status ${kind}`.trim();
}

function readingTime(reading) {
  return reading ? new Date(reading.recorded_at) : null;
}

function latestReading() {
  return state.readings.at(-1) || null;
}

function updateAge() {
  const latest = latestReading();
  if (!latest) {
    $("age").textContent = "—";
    return;
  }

  const minutes = Math.max(0, Math.round((Date.now() - readingTime(latest)) / 60000));
  $("age").textContent = minutes < 1 ? "now" : `${minutes} min`;
  const stale = minutes > 15;
  setStatus(stale ? "Stale" : "Live", stale ? "warning" : "ok");
  const sensorAge = $("sensorAge");
  if (sensorAge) sensorAge.textContent = minutes < 1 ? "now" : `${minutes} min`;
}


const CPU_TIME_ZONE = "Europe/Berlin";
const CPU_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const CPU_GAP_THRESHOLD_MS = 7.5 * 60 * 1000;
const SENSOR_TABLE_PREVIEW_LIMIT = 500;
const SENSOR_WINDOWS = Object.freeze({
  "1h": 60 * 60 * 1000,
  "3h": 3 * 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
});

function sensorWindowLabel() {
  const labels = {
    "1h": "1 hour", "3h": "3 hours", "6h": "6 hours", "12h": "12 hours",
    "24h": "24 hours", "3d": "3 days", "7d": "7 days", "30d": "30 days",
  };
  return labels[state.sensorWindowKey] || state.sensorWindowKey;
}

function formatCpuTick(date, spanMs) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "—";
  const options = spanMs <= 24 * 60 * 60 * 1000
    ? { timeZone: CPU_TIME_ZONE, hour: "2-digit", hourCycle: "h23" }
    : spanMs <= 3 * 24 * 60 * 60 * 1000
      ? { timeZone: CPU_TIME_ZONE, day: "2-digit", month: "short", hour: "2-digit", hourCycle: "h23" }
      : { timeZone: CPU_TIME_ZONE, day: "2-digit", month: "short" };
  return new Intl.DateTimeFormat("en-GB", options).format(date);
}

function cpuAxisTickValues(start, end) {
  const span = end - start;
  let step;
  if (span <= 60 * 60 * 1000) step = 15 * 60 * 1000;
  else if (span <= 3 * 60 * 60 * 1000) step = 30 * 60 * 1000;
  else if (span <= 6 * 60 * 60 * 1000) step = 60 * 60 * 1000;
  else if (span <= 12 * 60 * 60 * 1000) step = 2 * 60 * 60 * 1000;
  else if (span <= 24 * 60 * 60 * 1000) step = 3 * 60 * 60 * 1000;
  else if (span <= 3 * 24 * 60 * 60 * 1000) step = 12 * 60 * 60 * 1000;
  else if (span <= 7 * 24 * 60 * 60 * 1000) step = 24 * 60 * 60 * 1000;
  else if (span <= 14 * 24 * 60 * 60 * 1000) step = 2 * 24 * 60 * 60 * 1000;
  else step = 5 * 24 * 60 * 60 * 1000;

  const first = Math.ceil(start / step) * step;
  const values = [];
  for (let value = first; value <= end; value += step) values.push(value);
  return values;
}

function formatCpuTimestamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: CPU_TIME_ZONE, weekday: "short", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZoneName: "short",
  }).format(date);
}

function formatDuration(milliseconds) {
  const minutes = Math.max(0, Math.round(milliseconds / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 48) return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const hourRemainder = hours % 24;
  return hourRemainder ? `${days} d ${hourRemainder} h` : `${days} d`;
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  const remainder = position - base;
  return sorted[base + 1] === undefined
    ? sorted[base]
    : sorted[base] + remainder * (sorted[base + 1] - sorted[base]);
}

function temperatureDistribution(rows, normalizeTemperature = false) {
  const values = rows
    .map((row) => Number(row.value))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!values.length) return { points: [], probabilities: [], meta: [], count: 0 };

  const min = values[0];
  const max = values.at(-1);
  const range = max - min;
  let binCount = 1;
  if (range > 0 && values.length > 1) {
    const q1 = quantile(values, 0.25);
    const q3 = quantile(values, 0.75);
    const iqr = q3 - q1;
    const fdWidth = iqr > 0 ? (2 * iqr) / Math.cbrt(values.length) : 0;
    const suggested = fdWidth > 0
      ? Math.ceil(range / fdWidth)
      : Math.ceil(Math.sqrt(values.length));
    binCount = Math.min(30, Math.max(2, Math.min(values.length, suggested)));
  }

  const width = range > 0 ? range / binCount : 1;
  const counts = Array(binCount).fill(0);
  for (const value of values) {
    const index = range > 0
      ? Math.min(binCount - 1, Math.floor((value - min) / width))
      : 0;
    counts[index] += 1;
  }

  const decimals = width < 0.1 ? 2 : width < 1 ? 1 : 0;
  const meta = [];
  const probabilities = [];
  const points = counts.map((count, index) => {
    const from = range > 0 ? min + index * width : min - 0.5;
    const to = range > 0 ? (index === binCount - 1 ? max : min + (index + 1) * width) : min + 0.5;
    const center = (from + to) / 2;
    const probability = count / values.length;
    const normalizedCenter = range > 0 ? (center - min) / range : 0.5;
    meta.push({ from, to, center, normalizedCenter, count });
    probabilities.push(probability);
    return { x: normalizeTemperature ? normalizedCenter : center, y: probability };
  });

  return { points, probabilities, meta, count: values.length, decimals, min, max, range, normalized: normalizeTemperature };
}

function renderTemperatureDistribution(timeline) {
  const canvas = $("distributionChart");
  const summary = $("distributionSummary");
  if (!canvas) return;
  const distribution = temperatureDistribution(timeline.seriesRows, state.normalizeTemperature);
  state.distributionMeta = distribution.meta;
  const axisNote = $("distributionAxisNote");
  if (axisNote) {
    axisNote.textContent = state.normalizeTemperature
      ? "x = normalized temperature (0–1; min–max) · y = probability per bin (count / total count), constrained to 0–1."
      : "x = temperature (degrees_celsius) · y = probability per bin (count / total count), constrained to 0–1.";
  }

  if (summary) {
    const totalProbability = distribution.probabilities.reduce((sum, value) => sum + value, 0);
    summary.textContent = distribution.count
      ? `${distribution.count.toLocaleString()} displayed values · ${distribution.probabilities.length} bins · sum = ${totalProbability.toFixed(3)}`
      : "No values in the selected range";
  }

  if (state.distributionChart) {
    state.distributionChart.data.datasets[0].data = distribution.points;
    state.distributionChart.options.scales.x.min = state.normalizeTemperature ? 0 : undefined;
    state.distributionChart.options.scales.x.max = state.normalizeTemperature ? 1 : undefined;
    state.distributionChart.options.scales.x.title.text = state.normalizeTemperature
      ? "Normalized temperature (0–1)"
      : "Temperature (degrees_celsius)";
    state.distributionChart.update("none");
    return;
  }

  state.distributionChart = new Chart(canvas, {
    type: "line",
    data: {
      datasets: [{
        label: "Probability per bin",
        data: distribution.points,
        parsing: false,
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        fill: false,
        tension: 0.18,
      }],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title(items) {
              if (!items.length) return "";
              const meta = state.distributionMeta[items[0].dataIndex];
              if (!meta) return "";
              return `${meta.from.toFixed(2)} to ${meta.to.toFixed(2)} degrees_celsius`;
            },
            label(item) {
              const probability = Number(item.parsed.y || 0);
              const meta = state.distributionMeta[item.dataIndex];
              const normalized = meta?.normalizedCenter;
              const suffix = state.normalizeTemperature && Number.isFinite(normalized)
                ? ` · normalized x ${normalized.toFixed(3)}`
                : "";
              return `Probability ${probability.toFixed(3)} (${(probability * 100).toFixed(1)}%) · count ${meta?.count ?? 0}${suffix}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: state.normalizeTemperature ? 0 : undefined,
          max: state.normalizeTemperature ? 1 : undefined,
          title: {
            display: true,
            text: state.normalizeTemperature ? "Normalized temperature (0–1)" : "Temperature (degrees_celsius)",
            color: "#57606a",
          },
          ticks: {
            color: "#57606a",
            maxRotation: 0,
            callback(value) { return Number(value).toFixed(1); },
          },
          grid: { display: false },
        },
        y: {
          min: 0,
          max: 1,
          title: { display: true, text: "Probability per bin", color: "#57606a" },
          ticks: {
            color: "#57606a",
            callback(value) { return Number(value).toFixed(1); },
          },
          grid: { color: "rgba(27, 31, 36, 0.09)" },
        },
      },
    },
  });
}

function sensorUnit(reading) {
  const unit = reading?.unit || "";
  return unit === "C" || unit === "°C" ? "degrees_celsius" : unit;
}

function aggregateSensorRows(visible, windowStart) {
  if (!state.sensorAverageMinutes) {
    return visible.map(({ reading, time }) => ({
      time,
      value: Number(reading.value),
      unit: sensorUnit(reading),
      samples: 1,
    }));
  }

  const intervalMs = state.sensorAverageMinutes * 60 * 1000;
  const buckets = new Map();
  for (const { reading, time } of visible) {
    const bucketTime = Math.max(windowStart, Math.floor(time / intervalMs) * intervalMs);
    let bucket = buckets.get(bucketTime);
    if (!bucket) {
      bucket = { time: bucketTime, total: 0, samples: 0, unit: sensorUnit(reading) };
      buckets.set(bucketTime, bucket);
    }
    bucket.total += Number(reading.value);
    bucket.samples += 1;
    if (!bucket.unit) bucket.unit = sensorUnit(reading);
  }
  return [...buckets.values()]
    .sort((a, b) => a.time - b.time)
    .map((bucket) => ({
      time: bucket.time,
      value: bucket.total / bucket.samples,
      unit: bucket.unit,
      samples: bucket.samples,
    }));
}

function cpuWindow(now = Date.now()) {
  const all = state.readings
    .map((reading) => ({ reading, time: readingTime(reading)?.getTime() }))
    .filter(({ time }) => Number.isFinite(time) && time <= now)
    .sort((a, b) => a.time - b.time);

  const rollingStart = now - state.sensorWindowMs;
  const visible = state.sensorRollingWindow
    ? all.filter(({ time }) => time >= rollingStart)
    : all.slice(-state.sensorDataLimit);

  const dataStart = visible[0]?.time ?? now;
  const dataEnd = visible.at(-1)?.time ?? now;
  const start = state.sensorRollingWindow ? rollingStart : dataStart;
  const end = state.sensorRollingWindow ? now : dataEnd;
  const seriesRows = aggregateSensorRows(visible, start);
  const intervalMs = state.sensorAverageMinutes
    ? state.sensorAverageMinutes * 60 * 1000
    : CPU_SAMPLE_INTERVAL_MS;
  const gapThresholdMs = state.sensorAverageMinutes
    ? intervalMs * 1.5
    : CPU_GAP_THRESHOLD_MS;
  const gaps = [];

  if (!seriesRows.length) {
    if (state.sensorRollingWindow) gaps.push({ from: start, to: end, open: true });
  } else {
    const first = seriesRows[0];
    if (state.sensorRollingWindow && first.time - start > gapThresholdMs) {
      gaps.push({ from: start, to: first.time, open: false });
    }
    for (let index = 1; index < seriesRows.length; index += 1) {
      const before = seriesRows[index - 1];
      const after = seriesRows[index];
      if (after.time - before.time > gapThresholdMs) {
        gaps.push({ from: before.time + intervalMs, to: after.time, open: false });
      }
    }
    const last = seriesRows.at(-1);
    if (state.sensorRollingWindow && end - last.time > gapThresholdMs) {
      gaps.push({ from: last.time + intervalMs, to: end, open: true });
    }
  }

  const points = [];
  seriesRows.forEach((row, index) => {
    const before = seriesRows[index - 1];
    if (before && row.time - before.time > gapThresholdMs) {
      points.push({ x: before.time + ((row.time - before.time) / 2), y: null });
    }
    points.push({ x: row.time, y: row.value });
  });

  return { start, end, visible, seriesRows, points, gaps, intervalMs };
}

function updateCpuRange(timeline) {
  const el = $("cpuRange");
  if (!el) return;
  const gapTotal = timeline.gaps.reduce((total, gap) => total + Math.max(0, gap.to - gap.from), 0);
  const gapSummary = timeline.gaps.length
    ? `${timeline.gaps.length} no-data ${timeline.gaps.length === 1 ? "period" : "periods"} · ${formatDuration(gapTotal)} total`
    : "No downtime detected";
  const aggregation = state.sensorAverageMinutes
    ? `${state.sensorAverageMinutes} min average`
    : "raw readings";
  const selection = state.sensorRollingWindow
    ? `Rolling ${sensorWindowLabel()}`
    : `Data limit ${state.sensorDataLimit.toLocaleString()}`;
  el.textContent = `${selection} · ${aggregation} · ${timeline.visible.length.toLocaleString()} source readings · ${timeline.seriesRows.length.toLocaleString()} plotted points · ${gapSummary}`;
}

const cpuDowntimePlugin = {
  id: "cpuDowntime",
  beforeDatasetsDraw(chart, _args, options) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales.x || !options?.gaps?.length) return;
    ctx.save();
    ctx.fillStyle = "rgba(248, 81, 73, 0.09)";
    for (const gap of options.gaps) {
      const left = Math.max(chartArea.left, scales.x.getPixelForValue(gap.from));
      const right = Math.min(chartArea.right, scales.x.getPixelForValue(gap.to));
      if (right > left) ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top);
    }
    ctx.restore();
  },
  afterDatasetsDraw(chart, _args, options) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales.x || !options?.gaps?.length) return;
    ctx.save();
    ctx.fillStyle = "#cf222e";
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const gap of options.gaps) {
      const left = Math.max(chartArea.left, scales.x.getPixelForValue(gap.from));
      const right = Math.min(chartArea.right, scales.x.getPixelForValue(gap.to));
      if (right - left >= 56) ctx.fillText(gap.open ? "No data · now" : "No data", (left + right) / 2, chartArea.top + 8);
    }
    ctx.restore();
  },
};

function renderSensorHistory(timeline) {
  const body = $("sensorHistory");
  if (!body) return;
  const rows = timeline.seriesRows;
  state.sensorTableRows = rows;
  body.replaceChildren();
  const csvButton = $("sensorCsvDownload");
  if (csvButton) csvButton.disabled = rows.length === 0;
  const summary = $("sensorHistorySummary");
  const preview = rows.slice(-SENSOR_TABLE_PREVIEW_LIMIT).reverse();
  if (summary) {
    const aggregation = state.sensorAverageMinutes ? `${state.sensorAverageMinutes} min averages` : "raw readings";
    summary.textContent = rows.length > SENSOR_TABLE_PREVIEW_LIMIT
      ? `${aggregation} · showing latest ${SENSOR_TABLE_PREVIEW_LIMIT.toLocaleString()} of ${rows.length.toLocaleString()} rows · CSV includes all rows`
      : `${aggregation} · ${rows.length.toLocaleString()} rows in selected range`;
  }
  if (!preview.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.className = "muted";
    cell.textContent = "No data in the selected range.";
    row.append(cell);
    body.append(row);
    return;
  }
  for (const item of preview) {
    const row = document.createElement("tr");
    const time = document.createElement("td");
    const value = document.createElement("td");
    const samples = document.createElement("td");
    const unit = document.createElement("td");
    time.textContent = formatCpuTimestamp(new Date(item.time));
    value.textContent = Number(item.value).toFixed(2);
    samples.textContent = String(item.samples);
    unit.textContent = item.unit || "—";
    row.append(time, value, samples, unit);
    body.append(row);
  }
}

function csvCell(value, delimiter = ",") {
  const text = String(value ?? "");
  const escaped = text.replaceAll('"', '""');
  return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${escaped}"` : text;
}

function exportSensorUnit(unit) {
  return unit === "C" || unit === "°C" ? "degrees_celsius" : unit;
}

function downloadSensorCsv() {
  const rows = state.sensorTableRows;
  if (!rows.length) return;
  const aggregation = state.sensorAverageMinutes ? `${state.sensorAverageMinutes}min_average` : "raw";
  const delimiter = ",";
  const selectionMode = state.sensorRollingWindow ? "rolling_window" : "data_limit";
  const selectionValue = state.sensorRollingWindow ? state.sensorWindowKey : state.sensorDataLimit;
  const header = [
    "timestamp", "device", "metric", "selection_mode", "selection_value",
    "aggregation_minutes", "value", "unit", "samples",
  ];
  const lines = [header.map((value) => csvCell(value, delimiter)).join(delimiter)];
  for (const row of rows) {
    lines.push([
      new Date(row.time).toISOString(),
      state.device,
      state.metric,
      selectionMode,
      selectionValue,
      state.sensorAverageMinutes || 0,
      Number(row.value).toFixed(6),
      exportSensorUnit(row.unit || ""),
      row.samples,
    ].map((value) => csvCell(value, delimiter)).join(delimiter));
  }
  const csv = `\uFEFF${lines.join("\r\n")}\r\n`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const selection = state.sensorRollingWindow ? state.sensorWindowKey : `limit-${state.sensorDataLimit}`;
  link.href = url;
  link.download = `${state.device}_${state.metric}_${selection}_${aggregation}_${stamp}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderReadings() {
  const latest = latestReading();
  if (!latest) {
    $("cpuNow").textContent = "waiting";
    $("age").textContent = "—";
    $("raw").textContent = "No data yet.";
    if ($("sensorNow")) $("sensorNow").textContent = "—";
    if ($("sensorAge")) $("sensorAge").textContent = "—";
    if ($("sensorMetric")) $("sensorMetric").textContent = state.metric.replaceAll("_", " ");
    setStatus("Waiting", "warning");
  } else {
    const unit = latest.unit ? ` ${sensorUnit(latest)}` : "";
    const formattedValue = `${Number(latest.value).toFixed(1)}${unit}`;
    $("cpuNow").textContent = formattedValue;
    $("raw").textContent = JSON.stringify(latest, null, 2);
    if ($("sensorNow")) $("sensorNow").textContent = formattedValue;
    if ($("sensorMetric")) $("sensorMetric").textContent = latest.metric.replaceAll("_", " ");
    updateAge();
  }

  const timeline = cpuWindow();
  updateCpuRange(timeline);
  renderTemperatureDistribution(timeline);
  renderSensorHistory(timeline);
  const chartLabel = state.sensorAverageMinutes
    ? `${state.metric.replaceAll("_", " ")} · ${state.sensorAverageMinutes} min average`
    : state.metric.replaceAll("_", " ");
  const unit = timeline.seriesRows.find((row) => row.unit)?.unit || sensorUnit(latest) || "";
  if (state.chart) {
    state.chart.data.datasets[0].label = chartLabel;
    state.chart.data.datasets[0].data = timeline.points;
    state.chart.options.scales.x.min = timeline.start;
    state.chart.options.scales.x.max = timeline.end;
    state.chart.options.scales.x.title.text = `Time (${CPU_TIME_ZONE})`;
    state.chart.options.scales.y.title.text = unit || "Value";
    state.chart.options.plugins.cpuDowntime.gaps = timeline.gaps;
    state.chart.update("none");
    return;
  }

  state.chart = new Chart($("chart"), {
    type: "line",
    data: {
      datasets: [
        {
          label: chartLabel,
          data: timeline.points,
          borderColor: "#0969da",
          backgroundColor: "rgba(9, 105, 218, 0.07)",
          borderWidth: 1.35,
          borderCapStyle: "round",
          borderJoinStyle: "round",
          fill: true,
          parsing: false,
          spanGaps: false,
          tension: 0.18,
          pointRadius: 0,
          pointHoverRadius: 3,
          pointHitRadius: 8,
          pointHoverBorderWidth: 1.5,
        },
      ],
    },
    plugins: [cpuDowntimePlugin],
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        cpuDowntime: { gaps: timeline.gaps },
        legend: { labels: { color: "#24292f", boxWidth: 24, boxHeight: 2 } },
        tooltip: {
          backgroundColor: "rgba(36, 41, 47, 0.94)",
          displayColors: false,
          padding: 10,
          callbacks: {
            title(items) {
              if (!items.length) return "";
              return formatCpuTimestamp(new Date(items[0].parsed.x));
            },
            label(item) {
              if (item.parsed.y == null) return "No data";
              const currentUnit = item.chart.options.scales.y.title.text === "Value" ? "" : item.chart.options.scales.y.title.text;
              return `${item.dataset.label}: ${Number(item.parsed.y).toFixed(2)}${currentUnit ? ` ${currentUnit}` : ""}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: timeline.start,
          max: timeline.end,
          border: { color: "#d0d7de" },
          grid: { color: "rgba(27, 31, 36, 0.09)" },
          title: { display: true, text: `Time (${CPU_TIME_ZONE})`, color: "#57606a" },
          afterBuildTicks(scale) {
            scale.ticks = cpuAxisTickValues(scale.min, scale.max).map((value) => ({ value }));
          },
          ticks: {
            color: "#57606a",
            maxRotation: 0,
            autoSkip: false,
            callback(value) {
              return formatCpuTick(new Date(value), this.max - this.min);
            },
          },
        },
        y: {
          border: { color: "#d0d7de" },
          grid: { color: "rgba(27, 31, 36, 0.09)" },
          ticks: { color: "#57606a" },
          title: { display: true, text: unit || "Value", color: "#57606a" },
        },
      },
    },
  });
}

function normalizedDataLimit(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 500;
  return Math.min(config.maxHistoryLimit || 10000, Math.max(10, number));
}

function historyQueryLimit() {
  if (!state.sensorRollingWindow) return state.sensorDataLimit;
  const sourceInterval = CPU_SAMPLE_INTERVAL_MS;
  const expected = Math.ceil((state.sensorWindowMs + (2 * sourceInterval)) / sourceInterval) + 50;
  return Math.min(config.maxHistoryLimit || 10000, Math.max(288, expected));
}

function trimHistoryBuffer(now = Date.now()) {
  if (!state.sensorRollingWindow) {
    state.readings = state.readings.slice(-state.sensorDataLimit);
    return;
  }
  const margin = Math.max(
    CPU_GAP_THRESHOLD_MS * 2,
    state.sensorAverageMinutes * 60 * 1000 * 2,
  );
  const cutoff = now - state.sensorWindowMs - margin;
  state.readings = state.readings.filter((reading) => {
    const time = readingTime(reading)?.getTime();
    return Number.isFinite(time) && time >= cutoff;
  });
}

async function loadHistory() {
  setStatus("Loading…");
  const parameters = {
    device: state.device,
    metric: state.metric,
    limit: historyQueryLimit(),
  };
  if (state.sensorRollingWindow) {
    const margin = Math.max(
      CPU_GAP_THRESHOLD_MS * 2,
      state.sensorAverageMinutes * 60 * 1000 * 2,
    );
    parameters.since = new Date(Date.now() - state.sensorWindowMs - margin).toISOString();
  }
  try {
    const payload = await fetchJson("/api/v1/history", parameters);
    state.readings = payload.readings;
    renderReadings();
  } catch (error) {
    console.error("history_failed", error);
    setStatus("Telemetry API unavailable", "error");
  }
}

async function pollLatest() {
  try {
    const payload = await fetchJson("/api/v1/latest", {
      device: state.device,
      metric: state.metric,
    });
    const reading = payload.reading;
    if (!reading) {
      renderReadings();
      return;
    }

    const previous = latestReading();
    if (!previous || previous.recorded_at !== reading.recorded_at) {
      state.readings.push(reading);
      state.readings.sort((a, b) => readingTime(a) - readingTime(b));
      trimHistoryBuffer();
    }
    renderReadings();
  } catch (error) {
    console.error("latest_failed", error);
    setStatus("Telemetry API unavailable", "error");
  }
}

function syncSensorSelectionControls() {
  const rolling = $("sensorRollingWindow");
  const windowSelect = $("sensorWindow");
  const limitInput = $("sensorDataLimit");
  if (!rolling || !windowSelect || !limitInput) return;
  state.sensorRollingWindow = rolling.checked;
  windowSelect.disabled = !state.sensorRollingWindow;
  limitInput.disabled = state.sensorRollingWindow;
}

function initDistributionControls() {
  const checkbox = $("normalizeTemperature");
  checkbox?.addEventListener("change", () => {
    state.normalizeTemperature = checkbox.checked;
    renderReadings();
  });
}

function initSensorChartControls() {
  const rolling = $("sensorRollingWindow");
  const windowSelect = $("sensorWindow");
  const limitInput = $("sensorDataLimit");
  const averageSelect = $("sensorAverage");
  syncSensorSelectionControls();

  rolling?.addEventListener("change", async () => {
    syncSensorSelectionControls();
    state.readings = [];
    await loadHistory();
  });
  windowSelect?.addEventListener("change", async () => {
    const key = windowSelect.value;
    if (!state.sensorRollingWindow || !SENSOR_WINDOWS[key]) return;
    state.sensorWindowKey = key;
    state.sensorWindowMs = SENSOR_WINDOWS[key];
    state.readings = [];
    await loadHistory();
  });
  limitInput?.addEventListener("change", async () => {
    if (state.sensorRollingWindow) return;
    state.sensorDataLimit = normalizedDataLimit(limitInput.value);
    limitInput.value = String(state.sensorDataLimit);
    state.readings = [];
    await loadHistory();
  });
  averageSelect?.addEventListener("change", () => {
    const value = Number(averageSelect.value);
    state.sensorAverageMinutes = [0, 5, 10, 15, 20, 25].includes(value) ? value : 0;
    renderReadings();
  });
  $("sensorCsvDownload")?.addEventListener("click", downloadSensorCsv);
}

async function loadDevices() {
  try {
    const payload = await fetchJson("/api/v1/devices");
    const cpuDevices = payload.devices.filter((device) => device.metric === config.defaultMetric);
    const known = new Map(
      cpuDevices.map((device) => [device.device_id, device.label || device.device_id]),
    );
    if (!known.has(config.defaultDevice)) known.set(config.defaultDevice, config.defaultDevice);

    const select = $("deviceSelect");
    const current = select.value || state.device;
    select.replaceChildren();
    for (const [deviceId, label] of known) {
      const option = document.createElement("option");
      option.value = deviceId;
      option.textContent = `${label} (${deviceId})`;
      select.append(option);
    }
    select.value = known.has(current) ? current : config.defaultDevice;
    state.device = select.value;
  } catch (error) {
    console.error("devices_failed", error);
    const option = document.createElement("option");
    option.value = config.defaultDevice;
    option.textContent = config.defaultDevice;
    $("deviceSelect").replaceChildren(option);
  }
}

function weatherCard(label, value) {
  const article = document.createElement("article");
  const small = document.createElement("small");
  const strong = document.createElement("strong");
  small.textContent = label;
  strong.textContent = value;
  article.append(small, strong);
  return article;
}

async function loadWeather() {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: "52.52",
    longitude: "13.405",
    current: "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code",
    timezone: "Europe/Berlin",
  });
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { current } = await response.json();
    $("weatherNow").textContent = `${current.temperature_2m} °C`;

    const cards = document.createElement("div");
    cards.className = "cards";
    cards.append(
      weatherCard("Temperature", `${current.temperature_2m} °C`),
      weatherCard("Humidity", `${current.relative_humidity_2m}%`),
      weatherCard("Wind", `${current.wind_speed_10m} km/h`),
    );
    const updated = document.createElement("p");
    updated.className = "muted";
    updated.textContent = `Updated ${current.time}`;
    $("weatherDetail").replaceChildren(cards, updated);
  } catch (error) {
    console.error("weather_failed", error);
    $("weatherDetail").textContent = "Weather unavailable.";
  }
}

function utcTime(epoch) { return epoch ? new Date(epoch * 1000).toLocaleString(undefined, { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) + " UTC" : "—"; }
function knots(value) { return value == null ? "—" : `${value} kt`; }
function degrees(value) { return value == null ? "Variable" : `${value}°`; }
function cloudText(clouds) { return !clouds?.length ? "Clear / none reported" : clouds.map(c => c.base ? `${c.cover} ${c.base} ft` + (c.type ? ` ${c.type}` : "") : c.cover).join(", "); }
function tafPeriod(period) {
  const row = document.createElement("div"); row.className = "taf-row";
  const change = period.fcstChange || "BASE"; const prob = period.probability ? ` ${period.probability}%` : "";
  const wind = `${degrees(period.wdir)} ${knots(period.wspd)}${period.wgst ? ` G${period.wgst} kt` : ""}`;
  row.innerHTML = `<span class="wx-badge wx-${change.toLowerCase()}">${change}${prob}</span><span class="taf-time">${utcTime(period.timeFrom).replace(" UTC","")} → ${utcTime(period.timeTo).replace(" UTC","")}</span><span>${wind}</span><span>${period.visib ? `${period.visib} mi` : "—"}</span><span>${period.wxString || "NSW"}</span><span>${cloudText(period.clouds)}</span>`;
  return row;
}
const aviationState = {
  station: "EDDB",
  selected: null,
  map: null,
  markers: null,
  searchTimer: null,
  mapTimer: null,
  searchSequence: 0,
  mapSequence: 0,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function airportDisplayName(station) {
  if (!station) return "—";
  const codes = [station.icao || station.id, station.iata].filter(Boolean).join(" / ");
  return station.name && station.name !== station.id ? `${codes} · ${station.name}` : codes;
}

function airportLocationText(station) {
  return [station.state, station.country].filter(Boolean).join(" · ");
}

function renderAviationSearchResults(stations) {
  const root = $("airportResults");
  root.replaceChildren();
  if (!stations.length) {
    const empty = document.createElement("div");
    empty.className = "airport-result-empty";
    empty.textContent = "No matching airports.";
    root.append(empty);
    root.hidden = false;
    return;
  }
  for (const station of stations) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "airport-result";
    button.setAttribute("role", "option");
    const main = document.createElement("strong");
    main.textContent = airportDisplayName(station);
    const sub = document.createElement("span");
    const capabilities = [station.metar ? "METAR" : null, station.taf ? "TAF" : null].filter(Boolean).join(" + ");
    sub.textContent = [airportLocationText(station), capabilities].filter(Boolean).join(" · ");
    button.append(main, sub);
    button.addEventListener("click", () => selectAviationStation(station));
    root.append(button);
  }
  root.hidden = false;
}

async function searchAirports(query) {
  const q = query.trim();
  const root = $("airportResults");
  if (q.length < 2) {
    root.hidden = true;
    root.replaceChildren();
    $("airportSearchStatus").textContent = "";
    return;
  }
  const sequence = ++aviationState.searchSequence;
  $("airportSearchStatus").textContent = "…";
  try {
    const payload = await fetchJson("/api/v1/weather/airports", { q });
    if (sequence !== aviationState.searchSequence) return;
    renderAviationSearchResults(payload.stations || []);
    $("airportSearchStatus").textContent = "";
  } catch (error) {
    if (sequence !== aviationState.searchSequence) return;
    console.error("airport_search_failed", error);
    root.hidden = false;
    root.textContent = "Airport search unavailable.";
    $("airportSearchStatus").textContent = "!";
  }
}

function selectAviationStation(station, { focusMap = true } = {}) {
  aviationState.station = station.icao || station.id;
  aviationState.selected = station;
  $("airportSearch").value = airportDisplayName(station);
  $("airportResults").hidden = true;
  $("aviationSelected").textContent = aviationState.station;
  if (focusMap && aviationState.map && Number.isFinite(station.lat) && Number.isFinite(station.lon)) {
    aviationState.map.setView([station.lat, station.lon], Math.max(aviationState.map.getZoom(), 8));
  }
  loadAviationWeather(aviationState.station);
}

function metarPanel(m, info) {
  if (!m) {
    const panel = document.createElement("div");
    panel.className = "wx-panel aviation-no-report";
    panel.innerHTML = `<h3>Current conditions (METAR)</h3><p class="muted">No recent METAR is available for ${escapeHtml(info.icao || info.id)}.</p>`;
    return panel;
  }
  const summary = document.createElement("div");
  summary.className = "aviation-summary";
  summary.innerHTML = `<div class="wx-panel"><div class="panel-title"><h3>Current conditions (METAR)</h3><span class="flight-badge">${escapeHtml(m.fltCat || "—")}</span></div><p class="muted">Observed ${escapeHtml(utcTime(m.obsTime))}</p><div class="metric-strip"><div><small>Temperature</small><strong>${escapeHtml(m.temp)} °C</strong><span>Dew point ${escapeHtml(m.dewp)} °C</span></div><div><small>Wind</small><strong>${escapeHtml(degrees(m.wdir))} · ${escapeHtml(knots(m.wspd))}</strong><span>${m.wgst ? `Gust ${escapeHtml(m.wgst)} kt` : "No gust reported"}</span></div><div><small>Visibility</small><strong>${escapeHtml(m.visib)} mi</strong><span>${Number(m.visib) >= 6 ? "Good" : "Reported"}</span></div><div><small>Cloud</small><strong>${escapeHtml(cloudText(m.clouds))}</strong></div><div><small>QNH</small><strong>${Number.isFinite(Number(m.altim)) ? Math.round(m.altim) : "—"} hPa</strong></div></div><p class="wx-raw raw-strip">${escapeHtml(m.rawOb || "")}</p></div>`;
  const decoded = document.createElement("div");
  decoded.className = "wx-panel decoded-panel";
  decoded.innerHTML = `<h3>METAR decoded</h3><dl class="wx-details"><dt>Station</dt><dd>${escapeHtml(info.name || m.name || info.id)} (${escapeHtml(info.icao || info.id)})</dd><dt>Observed</dt><dd>${escapeHtml(utcTime(m.obsTime))}</dd><dt>Wind</dt><dd>${escapeHtml(degrees(m.wdir))} at ${escapeHtml(knots(m.wspd))}</dd><dt>Visibility</dt><dd>${escapeHtml(m.visib)} statute miles</dd><dt>Clouds</dt><dd>${escapeHtml(cloudText(m.clouds))}</dd><dt>Temperature / dew point</dt><dd>${escapeHtml(m.temp)} °C / ${escapeHtml(m.dewp)} °C</dd><dt>QNH</dt><dd>${Number.isFinite(Number(m.altim)) ? Math.round(m.altim) : "—"} hPa</dd><dt>Flight category</dt><dd>${escapeHtml(m.fltCat || "—")}</dd></dl>`;
  summary.append(decoded);
  return summary;
}

function tafPanel(t, info) {
  const taf = document.createElement("div");
  taf.className = "wx-panel taf-panel";
  if (!t) {
    taf.innerHTML = `<h3>Forecast (TAF)</h3><p class="muted">No current TAF is available for ${escapeHtml(info.icao || info.id)}.</p>`;
    return taf;
  }
  taf.innerHTML = `<h3>Forecast (TAF)</h3><p class="muted">Issued ${escapeHtml(utcTime(t.issueTime))} · valid ${escapeHtml(utcTime(t.validTimeFrom))} → ${escapeHtml(utcTime(t.validTimeTo))}</p><div class="taf-head"><span>Change</span><span>Period (UTC)</span><span>Wind</span><span>Visibility</span><span>Weather</span><span>Cloud</span></div>`;
  (t.fcsts || []).forEach((period) => taf.append(tafPeriod(period)));
  const raw = document.createElement("p");
  raw.className = "wx-raw raw-strip";
  raw.textContent = t.rawTAF || "";
  taf.append(raw);
  return taf;
}

async function loadAviationWeather(station = aviationState.station) {
  const root = $("aviationDetail");
  root.textContent = `Loading ${station}…`;
  try {
    const data = await fetchJson("/api/v1/weather/aviation", { station });
    if (station !== aviationState.station) return;
    const info = data.station_info || { id: station, icao: station, name: station };
    aviationState.selected = info;
    $("aviationSelected").textContent = info.icao || info.id;
    if (!$("airportSearch").matches(":focus")) $("airportSearch").value = airportDisplayName(info);
    const source = document.createElement("p");
    source.className = "muted wx-source";
    source.textContent = `Aviation Weather Center Data API · ${info.icao || info.id} · times in UTC.`;
    root.replaceChildren(metarPanel(data.metar, info), tafPanel(data.taf, info), source);
  } catch (error) {
    console.error("aviation_weather_failed", error);
    root.textContent = `${station} aviation weather unavailable.`;
  }
}

function renderAviationMapStations(stations) {
  if (!aviationState.markers) return;
  aviationState.markers.clearLayers();
  for (const station of stations) {
    const marker = L.circleMarker([station.lat, station.lon], {
      radius: station.taf ? 5.5 : 4.5,
      weight: 1.5,
      fillOpacity: 0.72,
    });
    marker.bindTooltip(airportDisplayName(station), { direction: "top" });
    marker.on("click", () => selectAviationStation(station, { focusMap: false }));
    marker.addTo(aviationState.markers);
  }
  $("aviationMapStatus").textContent = `${stations.length} airports in view`;
}

async function loadAviationMapStations() {
  const map = aviationState.map;
  if (!map) return;
  const bounds = map.getBounds();
  const latSpan = bounds.getNorth() - bounds.getSouth();
  const lonSpan = bounds.getEast() - bounds.getWest();
  if (latSpan > 20 || lonSpan > 30) {
    aviationState.markers?.clearLayers();
    $("aviationMapStatus").textContent = "Zoom in to show airports";
    return;
  }
  const bbox = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()]
    .map((value) => value.toFixed(4))
    .join(",");
  const sequence = ++aviationState.mapSequence;
  $("aviationMapStatus").textContent = "Loading airports…";
  try {
    const payload = await fetchJson("/api/v1/weather/airports", { bbox });
    if (sequence !== aviationState.mapSequence) return;
    renderAviationMapStations(payload.stations || []);
  } catch (error) {
    if (sequence !== aviationState.mapSequence) return;
    console.error("aviation_map_failed", error);
    $("aviationMapStatus").textContent = "Airport map data unavailable";
  }
}

function initAviationMap() {
  if (aviationState.map) return;
  aviationState.map = L.map("aviationMap", { zoomControl: true, fadeAnimation: false }).setView([51.0, 10.4], 6);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(aviationState.map);
  aviationState.markers = L.layerGroup().addTo(aviationState.map);
  L.control.scale({ imperial: false, position: "bottomleft" }).addTo(aviationState.map);
  aviationState.map.on("moveend zoomend", () => {
    clearTimeout(aviationState.mapTimer);
    aviationState.mapTimer = setTimeout(loadAviationMapStations, 220);
  });
  const station = aviationState.selected;
  if (station && Number.isFinite(station.lat) && Number.isFinite(station.lon)) {
    aviationState.map.setView([station.lat, station.lon], 7);
  }
  loadAviationMapStations();
}

function initAviationSearch() {
  const input = $("airportSearch");
  input.value = aviationState.station;
  input.addEventListener("input", () => {
    clearTimeout(aviationState.searchTimer);
    aviationState.searchTimer = setTimeout(() => searchAirports(input.value), 260);
  });
  input.addEventListener("focus", () => {
    if (input.value.trim().length >= 2 && $("airportResults").children.length) $("airportResults").hidden = false;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") $("airportResults").hidden = true;
    if (event.key === "Enter") {
      const first = $("airportResults").querySelector(".airport-result");
      if (first) first.click();
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".airport-search-control")) $("airportResults").hidden = true;
  });
}

const ICON_PRODUCTS = {
  win: { label: "10 m wind", suffix: "000010" },
  ttc: { label: "2 m temperature", suffix: "999999" },
  rsa: { label: "6 h accumulated precipitation", suffix: "999999" },
};
function updateIconChart() {
  const product = $("iconProduct").value; const period = $("iconPeriod").value; const meta = ICON_PRODUCTS[product];
  const base = "https://opendata.dwd.de/weather/charts/forecasts/icon/eu_nest/ce/";
  const name = `Z__C_EDZW_LATEST_nwv01%2Cicoeu_${product}_ce_N_${period}_${meta.suffix}_LATEST_WV11.png`;
  $("iconChart").src = base + name;
  $("iconChart").alt = `DWD ICON-EU ${meta.label} forecast for Central Europe`;
  $("iconCaption").textContent = `${meta.label} · ${$("iconPeriod").selectedOptions[0].textContent} · DWD ICON-EU. The PNG itself contains model initialization and valid times.`;
}

function iconTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date) + " UTC";
}

async function loadIconSynoptic() {
  const freshness = $("iconDerivedFreshness");
  try {
    const response = await fetch(`model/latest.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const meta = await response.json();
    $("iconDerivedChart").src = `model/synoptic.webp?t=${Date.now()}`;
    $("iconRunTime").textContent = iconTime(meta.run_at);
    $("iconLeadTime").textContent = `+${meta.forecast_hour ?? "—"} h`;
    $("iconValidTime").textContent = iconTime(meta.valid_at);
    $("iconSatelliteTime").textContent = iconTime(meta.satellite_observed_at);
    $("iconGridSpacing").textContent = meta.grid_spacing_degrees == null ? "—" : `${meta.grid_spacing_degrees}°`;
    $("iconDerivedCaption").textContent = `White contours: PMSL every ${meta.pressure_contour_interval_hpa ?? 4} hPa · black contours: 2 m temperature every ${meta.temperature_contour_interval_degrees_celsius ?? 2} degrees_celsius · arrows: 10 m wind · ICON valid ${iconTime(meta.valid_at)} · satellite observed ${iconTime(meta.satellite_observed_at)}.`;
    const valid = new Date(meta.valid_at || "");
    const deltaMinutes = Number.isNaN(valid.getTime()) ? NaN : Math.round((valid.getTime() - Date.now()) / 60000);
    const absMinutes = Math.abs(deltaMinutes);
    if (!Number.isFinite(deltaMinutes)) {
      freshness.textContent = "Loaded";
    } else if (absMinutes < 5) {
      freshness.textContent = "Valid now";
    } else if (absMinutes < 60) {
      freshness.textContent = deltaMinutes > 0 ? `Valid in ${absMinutes} min` : `Valid ${absMinutes} min ago`;
    } else {
      const hours = (absMinutes / 60).toFixed(1);
      freshness.textContent = deltaMinutes > 0 ? `Valid in ${hours} h` : `Valid ${hours} h ago`;
    }
    freshness.className = `status ${Number.isFinite(deltaMinutes) && absMinutes <= 240 ? "ok" : "warning"}`;
  } catch (error) {
    console.error("icon_synoptic_failed", error);
    freshness.textContent = "Unavailable";
    freshness.className = "status error";
    $("iconDerivedCaption").textContent = "Quantitative ICON-EU overlay unavailable.";
  }
}
function initIconCharts() {
  $("iconProduct").addEventListener("change", updateIconChart);
  $("iconPeriod").addEventListener("change", updateIconChart);
  updateIconChart();
  loadIconSynoptic();
  setInterval(loadIconSynoptic, 15 * 60 * 1000);
}


let satelliteMeta = null;
let satelliteProduct = "geocolour";

function satelliteTimes(value) {
  if (!value) return { local: "—", utc: "—" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { local: "—", utc: "—" };
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: CPU_TIME_ZONE, day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short",
  }).format(date);
  const utc = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC", day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date) + " UTC";
  return { local, utc };
}

function renderSatelliteTime(localId, utcId, value) {
  const times = satelliteTimes(value);
  $(localId).textContent = times.local;
  $(utcId).textContent = times.utc === "—" ? "—" : `(${times.utc})`;
}

function updateSatelliteFreshness() {
  const freshness = $("satelliteFreshness");
  const product = satelliteMeta?.products?.[satelliteProduct];
  const observedAt = new Date(product?.observed_at || "");
  if (Number.isNaN(observedAt.getTime())) {
    freshness.textContent = "Data age unavailable";
    freshness.className = "satellite-freshness unavailable";
    freshness.removeAttribute("title");
    return;
  }

  const ageMin = Math.max(0, Math.floor((Date.now() - observedAt.getTime()) / 60000));
  const cadenceMin = Number(satelliteMeta.nominal_cadence_minutes) || 10;
  const staleAfterMin = Math.max(35, cadenceMin * 3);
  const stale = ageMin > staleAfterMin;
  freshness.textContent = `Data age · ${ageMin} min${stale ? " · stale" : ""}`;
  freshness.className = `satellite-freshness${stale ? " stale" : ""}`;
  freshness.title = stale
    ? `Observation is older than the ${staleAfterMin}-minute freshness threshold.`
    : "Age of the selected satellite observation.";
}

function renderSatellite() {
  if (!satelliteMeta) return;
  const product = satelliteMeta.products?.[satelliteProduct];
  if (!product) return;
  document.querySelectorAll("[data-sat-product]").forEach((button) => {
    button.classList.toggle("active", button.dataset.satProduct === satelliteProduct);
  });
  const version = encodeURIComponent(product.observed_at || satelliteMeta.generated_at || Date.now());
  $("satelliteImage").src = `satellite/${product.file}?v=${version}`;
  $("satelliteTitle").textContent = `${satelliteMeta.platform} · ${satelliteMeta.instrument} · ${product.title}`;
  $("satelliteCaption").textContent = product.subtitle;
  renderSatelliteTime("satObserved", "satObservedUtc", product.observed_at);
  renderSatelliteTime("satGenerated", "satGeneratedUtc", satelliteMeta.generated_at);
  $("satCadence").textContent = `~${satelliteMeta.nominal_cadence_minutes || 10} min`;
  $("satProcessing").textContent = satelliteMeta.boundary_overlay || "Image + grid + Natural Earth 1:50m Admin-0 country geometry fitted to CRS:84 extent";
  updateSatelliteFreshness();
}

async function loadSatellite() {
  try {
    const response = await fetch(`satellite/latest.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    satelliteMeta = await response.json();
    renderSatellite();
  } catch (error) {
    console.error("satellite_failed", error);
    $("satelliteFreshness").textContent = "Satellite render unavailable";
    $("satelliteFreshness").className = "satellite-freshness unavailable";
  }
}

function initSatellite() {
  document.querySelectorAll("[data-sat-product]").forEach((button) => {
    button.addEventListener("click", () => {
      satelliteProduct = button.dataset.satProduct;
      renderSatellite();
    });
  });
  loadSatellite();
}

function setSensorMode(mode) {
  const validModes = new Set(["overview", "chart"]);
  if (!validModes.has(mode)) return;
  document.querySelectorAll("[data-sensor-mode]").forEach((button) => {
    const active = button.dataset.sensorMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll(".sensor-mode-view").forEach((view) => view.classList.remove("active"));
  $(`sensorView${mode[0].toUpperCase()}${mode.slice(1)}`)?.classList.add("active");
  if (mode === "chart") {
    if (state.chart) state.chart.resize();
    if (state.distributionChart) state.distributionChart.resize();
  }
}

function initSensorModes() {
  document.querySelectorAll("[data-sensor-mode]").forEach((button) => {
    button.addEventListener("click", () => setSensorMode(button.dataset.sensorMode));
  });
}

function initTabs() {
  document.querySelectorAll("nav button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab, nav button").forEach((element) =>
        element.classList.remove("active"),
      );
      button.classList.add("active");
      $(button.dataset.tab).classList.add("active");
      if (button.dataset.tab === "map") {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!state.map) {
            initMap();
          } else {
            state.map.invalidateSize({ pan: false, animate: false });
            refreshMapDecorations();
          }
        }));
      }
      if (button.dataset.tab === "aviation") {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!aviationState.map) initAviationMap();
          else aviationState.map.invalidateSize({ pan: false, animate: false });
        }));
      }
    });
  });
}

function mapGridStep(span, pixels, minPixelSpacing) {
  const maxIntervals = Math.max(2, Math.floor(pixels / minPixelSpacing));
  const target = Math.max(span / maxIntervals, 0.00001);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    const step = factor * magnitude;
    if (step >= target - 1e-12) return step;
  }
  return 10 * magnitude;
}

function formatLongitude(value, step) {
  let wrapped = ((value + 180) % 360 + 360) % 360 - 180;
  if (Math.abs(wrapped) < 1e-10) wrapped = 0;
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  if (Math.abs(Math.abs(wrapped) - 180) < 1e-8) return `180°`;
  return `${Math.abs(wrapped).toFixed(decimals)}°${wrapped < 0 ? "W" : wrapped > 0 ? "E" : ""}`;
}

function formatLatitude(value, step) {
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
  if (Math.abs(value) < 1e-10) return `0°`;
  return `${Math.abs(value).toFixed(decimals)}°${value < 0 ? "S" : "N"}`;
}

function refreshMapDecorations() {
  if (!state.map) return;
  const map = state.map;
  const bounds = map.getBounds();
  const size = map.getSize();
  if (!size.x || !size.y) return;

  const latSpan = Math.max(0.000001, bounds.getNorth() - bounds.getSouth());
  const lonSpan = Math.max(0.000001, bounds.getEast() - bounds.getWest());
  // Keep labels readable at every zoom. The grid density is driven by screen
  // space, not by a fixed geographic interval.
  const latStep = mapGridStep(latSpan, size.y, 58);
  const lonStep = mapGridStep(lonSpan, size.x, 92);

  state.mapGrid.clearLayers();
  const lonRoot = $("lonLabels"); const latRoot = $("latLabels");
  lonRoot.replaceChildren(); latRoot.replaceChildren();

  const firstLon = Math.ceil((bounds.getWest() - 1e-10) / lonStep) * lonStep;
  for (let lon = firstLon, guard = 0; lon <= bounds.getEast() + 1e-9 && guard < 40; lon += lonStep, guard += 1) {
    L.polyline([[bounds.getSouth(), lon], [bounds.getNorth(), lon]], {
      color: "#57606a", weight: 1, opacity: .30, dashArray: "3 5", interactive: false,
    }).addTo(state.mapGrid);
    const xPx = map.latLngToContainerPoint([map.getCenter().lat, lon]).x;
    if (xPx >= 34 && xPx <= size.x - 34) {
      const label = document.createElement("span");
      label.textContent = formatLongitude(lon, lonStep);
      label.style.left = `${xPx / size.x * 100}%`;
      lonRoot.append(label);
    }
  }

  const firstLat = Math.ceil((bounds.getSouth() - 1e-10) / latStep) * latStep;
  for (let lat = firstLat, guard = 0; lat <= bounds.getNorth() + 1e-9 && guard < 40; lat += latStep, guard += 1) {
    if (lat < -90 || lat > 90) continue;
    L.polyline([[lat, bounds.getWest()], [lat, bounds.getEast()]], {
      color: "#57606a", weight: 1, opacity: .30, dashArray: "3 5", interactive: false,
    }).addTo(state.mapGrid);
    const yPx = map.latLngToContainerPoint([lat, map.getCenter().lng]).y;
    if (yPx >= 18 && yPx <= size.y - 18) {
      const label = document.createElement("span");
      label.textContent = formatLatitude(lat, latStep);
      label.style.top = `${yPx / size.y * 100}%`;
      latRoot.append(label);
    }
  }

  const c = map.getCenter();
  $("mapMeta").textContent = `Center ${Math.abs(c.lat).toFixed(3)}° ${c.lat < 0 ? "S" : "N"}, ${Math.abs((((c.lng + 180) % 360 + 360) % 360) - 180).toFixed(3)}° ${((((c.lng + 180) % 360 + 360) % 360) - 180) < 0 ? "W" : "E"} · Zoom ${map.getZoom()}`;
}

function initMap() {
  state.map = L.map("leafletMap", { zoomControl: true, fadeAnimation: false }).setView([52.52, 13.405], 10);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(state.map);
  state.mapGrid = L.layerGroup().addTo(state.map);
  window.GeometryUI?.attachToMap(state.map);
  L.circleMarker([52.52, 13.405], {radius:7,weight:2,fillOpacity:.9}).addTo(state.map).bindPopup("Berlin");
  L.circleMarker([52.3667,13.5033], {radius:6,weight:2,fillOpacity:.9}).addTo(state.map).bindPopup("BER · EDDB");
  L.control.scale({imperial:false, position:"bottomleft"}).addTo(state.map);
  state.map.on("moveend zoomend resize", refreshMapDecorations);
  refreshMapDecorations();
}
async function init() {
  initTabs();
  initSensorModes();
  initSensorChartControls();
  initDistributionControls();
  initAviationSearch();
  initIconCharts();
  initSatellite();
  window.GeometryUI?.init();
  $("deviceSelect").addEventListener("change", async (event) => {
    state.device = event.target.value;
    state.readings = [];
    await loadHistory();
  });

  await Promise.all([loadWeather(), loadAviationWeather(), loadDevices()]);
  await loadHistory();
  setInterval(updateAge, 30000);
  setInterval(updateSatelliteFreshness, 30000);
  setInterval(pollLatest, 60000);
  setInterval(loadWeather, 300000);
  setInterval(loadDevices, 300000);
  setInterval(loadSatellite, 300000);
}

init();
