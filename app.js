"use strict";

const config = window.READ_SENSOR_CONFIG;
const $ = (id) => document.getElementById(id);
const state = {
  device: config.defaultDevice,
  metric: config.defaultMetric,
  readings: [],
  chart: null,
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
  setStatus(
    `${stale ? "Stale" : "Live"} · ${state.device} · ${readingTime(latest).toLocaleString()}`,
    stale ? "warning" : "ok",
  );
}


const CPU_TIME_ZONE = "Europe/Berlin";
const CPU_WINDOW_MS = 24 * 60 * 60 * 1000;
const CPU_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
const CPU_GAP_THRESHOLD_MS = 7.5 * 60 * 1000;
const CPU_TICK_INTERVAL_MS = 3 * 60 * 60 * 1000;

function formatCpuTick(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "—";
  const datePart = new Intl.DateTimeFormat("en-GB", {
    timeZone: CPU_TIME_ZONE, day: "2-digit", month: "short",
  }).format(date);
  const timePart = new Intl.DateTimeFormat("en-GB", {
    timeZone: CPU_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
  return [datePart, timePart];
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
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

function cpuWindow(now = Date.now()) {
  const start = now - CPU_WINDOW_MS;
  const all = state.readings
    .map((reading) => ({ reading, time: readingTime(reading)?.getTime() }))
    .filter(({ time }) => Number.isFinite(time) && time <= now)
    .sort((a, b) => a.time - b.time);
  const visible = all.filter(({ time }) => time >= start);
  const previous = all.filter(({ time }) => time < start).at(-1);
  const gaps = [];

  if (!visible.length) {
    gaps.push({ from: start, to: now, open: true });
  } else {
    const first = visible[0];
    const firstAnchor = previous ? previous.time : start;
    if (first.time - firstAnchor > CPU_GAP_THRESHOLD_MS) {
      const gapStart = previous ? previous.time + CPU_SAMPLE_INTERVAL_MS : start;
      gaps.push({ from: Math.max(start, gapStart), to: first.time, open: false });
    }

    for (let index = 1; index < visible.length; index += 1) {
      const before = visible[index - 1];
      const after = visible[index];
      if (after.time - before.time > CPU_GAP_THRESHOLD_MS) {
        gaps.push({
          from: before.time + CPU_SAMPLE_INTERVAL_MS,
          to: after.time,
          open: false,
        });
      }
    }

    const last = visible.at(-1);
    if (now - last.time > CPU_GAP_THRESHOLD_MS) {
      gaps.push({
        from: last.time + CPU_SAMPLE_INTERVAL_MS,
        to: now,
        open: true,
      });
    }
  }

  const points = [];
  visible.forEach(({ reading, time }, index) => {
    const before = visible[index - 1];
    if (before && time - before.time > CPU_GAP_THRESHOLD_MS) {
      points.push({ x: before.time + ((time - before.time) / 2), y: null });
    }
    points.push({ x: time, y: Number(reading.value) });
  });

  return { start, end: now, visible, points, gaps };
}

function updateCpuRange(timeline) {
  const el = $("cpuRange");
  if (!el) return;
  const gapTotal = timeline.gaps.reduce((total, gap) => total + gap.to - gap.from, 0);
  const gapSummary = timeline.gaps.length
    ? `${timeline.gaps.length} no-data ${timeline.gaps.length === 1 ? "period" : "periods"} · ${formatDuration(gapTotal)} downtime`
    : "No downtime detected";
  el.textContent = `Sampling every 5 min · rolling 24 h · ${timeline.visible.length.toLocaleString()} readings received · ${gapSummary}`;
}

const cpuDowntimePlugin = {
  id: "cpuDowntime",
  beforeDatasetsDraw(chart, _args, options) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales.x || !options?.gaps?.length) return;
    ctx.save();
    ctx.fillStyle = "rgba(248, 81, 73, 0.14)";
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
    ctx.fillStyle = "#ff7b72";
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

function renderReadings() {
  const latest = latestReading();
  if (!latest) {
    $("cpuNow").textContent = "waiting";
    $("age").textContent = "—";
    $("raw").textContent = "No sensor data yet.";
    setStatus(`Waiting for ${state.device}`, "warning");
  } else {
    $("cpuNow").textContent = `${Number(latest.value).toFixed(1)} °C`;
    $("raw").textContent = JSON.stringify(latest, null, 2);
    updateAge();
  }

  const timeline = cpuWindow();
  updateCpuRange(timeline);
  if (state.chart) {
    state.chart.data.datasets[0].data = timeline.points;
    state.chart.options.scales.x.min = timeline.start;
    state.chart.options.scales.x.max = timeline.end;
    state.chart.options.plugins.cpuDowntime.gaps = timeline.gaps;
    state.chart.update("none");
    return;
  }

  state.chart = new Chart($("chart"), {
    type: "line",
    data: {
      datasets: [
        {
          label: "CPU °C",
          data: timeline.points,
          borderColor: "#58a6ff",
          backgroundColor: "rgba(88, 166, 255, 0.14)",
          fill: true,
          parsing: false,
          spanGaps: false,
          tension: 0.25,
          pointRadius: 1.5,
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
        tooltip: {
          callbacks: {
            title(items) {
              if (!items.length) return "";
              return formatCpuTimestamp(new Date(items[0].parsed.x));
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: timeline.start,
          max: timeline.end,
          title: { display: true, text: "Time (Europe/Berlin) · 3-hour intervals" },
          ticks: {
            stepSize: CPU_TICK_INTERVAL_MS,
            maxRotation: 0,
            autoSkip: true,
            autoSkipPadding: 14,
            callback(value) {
              return formatCpuTick(new Date(value));
            },
          },
        },
        y: { title: { display: true, text: "°C" } },
      },
    },
  });
}

async function loadHistory() {
  setStatus(`Loading ${state.device}…`);
  try {
    const payload = await fetchJson("/api/v1/history", {
      device: state.device,
      metric: state.metric,
      limit: config.historyLimit,
    });
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
      state.readings = state.readings.slice(-config.historyLimit);
      renderReadings();
    } else {
      renderReadings();
    }
  } catch (error) {
    console.error("latest_failed", error);
    setStatus("Telemetry API unavailable", "error");
  }
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
async function loadAviationWeather() {
  const root = $("aviationDetail");
  try {
    const data = await fetchJson("/api/v1/weather/aviation"); const m = data.metar; const t = data.taf;
    if (!m || !t) throw new Error("Missing EDDB report");
    const summary = document.createElement("div"); summary.className = "aviation-summary";
    summary.innerHTML = `<div class="wx-panel"><div class="panel-title"><h3>Current conditions (METAR)</h3><span class="flight-badge">${m.fltCat || "—"}</span></div><p class="muted">Observed ${utcTime(m.obsTime)}</p><div class="metric-strip"><div><small>Temperature</small><strong>${m.temp} °C</strong><span>Dew point ${m.dewp} °C</span></div><div><small>Wind</small><strong>${degrees(m.wdir)} · ${knots(m.wspd)}</strong><span>${m.wgst ? `Gust ${m.wgst} kt` : "No gust reported"}</span></div><div><small>Visibility</small><strong>${m.visib} mi</strong><span>${m.visib >= 6 ? "CAVOK / good" : "Reported"}</span></div><div><small>Cloud</small><strong>${cloudText(m.clouds)}</strong></div><div><small>QNH</small><strong>${Math.round(m.altim)} hPa</strong></div></div><p class="wx-raw raw-strip">${m.rawOb}</p></div>`;
    const decoded = document.createElement("div"); decoded.className="wx-panel decoded-panel";
    decoded.innerHTML=`<h3>METAR decoded</h3><dl class="wx-details"><dt>Station</dt><dd>${m.name} (EDDB)</dd><dt>Observed</dt><dd>${utcTime(m.obsTime)}</dd><dt>Wind</dt><dd>${degrees(m.wdir)} at ${knots(m.wspd)}</dd><dt>Visibility</dt><dd>${m.visib} statute miles</dd><dt>Clouds</dt><dd>${cloudText(m.clouds)}</dd><dt>Temperature / dew point</dt><dd>${m.temp} °C / ${m.dewp} °C</dd><dt>QNH</dt><dd>${Math.round(m.altim)} hPa</dd><dt>Flight category</dt><dd>${m.fltCat || "—"}</dd></dl>`;
    summary.append(decoded);
    const taf = document.createElement("div"); taf.className="wx-panel taf-panel"; taf.innerHTML=`<h3>Forecast (TAF)</h3><p class="muted">Issued ${utcTime(t.issueTime)} · valid ${utcTime(t.validTimeFrom)} → ${utcTime(t.validTimeTo)}</p><div class="taf-head"><span>Change</span><span>Period (UTC)</span><span>Wind</span><span>Visibility</span><span>Weather</span><span>Cloud</span></div>`; (t.fcsts||[]).forEach(x=>taf.append(tafPeriod(x))); const raw=document.createElement("p"); raw.className="wx-raw raw-strip"; raw.textContent=t.rawTAF; taf.append(raw);
    const source=document.createElement("p"); source.className="muted wx-source"; source.textContent="Source: Aviation Weather Center Data API · EDDB · times in UTC.";
    root.replaceChildren(summary, taf, source);
  } catch(e) { console.error("aviation_weather_failed",e); root.textContent="BER aviation weather unavailable."; }
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
function initIconCharts() {
  $("iconProduct").addEventListener("change", updateIconChart);
  $("iconPeriod").addEventListener("change", updateIconChart);
  updateIconChart();
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
  initIconCharts();
  initSatellite();
  window.GeometryUI?.init();
  const healthUrl = apiUrl("/health");
  $("apiLink").href = healthUrl;
  $("apiLink").textContent = healthUrl.origin;

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
