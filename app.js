"use strict";

const config = window.READ_SENSOR_CONFIG;
const $ = (id) => document.getElementById(id);
const state = {
  device: config.defaultDevice,
  metric: config.defaultMetric,
  readings: [],
  chart: null,
  map: null,
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

  const labels = state.readings.map((reading) =>
    readingTime(reading).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  );
  const values = state.readings.map((reading) => reading.value);
  if (state.chart) {
    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = values;
    state.chart.update("none");
    return;
  }

  state.chart = new Chart($("chart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "CPU °C",
          data: values,
          borderColor: "#58a6ff",
          backgroundColor: "rgba(88, 166, 255, 0.14)",
          fill: true,
          tension: 0.25,
          pointRadius: 1.5,
        },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      scales: {
        x: { ticks: { maxTicksLimit: 10 } },
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
      updateAge();
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

function mapGridStep(span) {
  if (span > 2) return 0.5;
  if (span > 1) return 0.2;
  if (span > 0.45) return 0.1;
  if (span > 0.2) return 0.05;
  return 0.02;
}

function refreshMapDecorations() {
  if (!state.map) return;
  const map = state.map;
  const bounds = map.getBounds();
  const size = map.getSize();
  if (!size.x || !size.y) return;
  const latStep = mapGridStep(bounds.getNorth() - bounds.getSouth());
  const lonStep = mapGridStep(bounds.getEast() - bounds.getWest());
  state.mapGrid.clearLayers();
  const lonRoot = $("lonLabels"); const latRoot = $("latLabels");
  lonRoot.replaceChildren(); latRoot.replaceChildren();
  for (let lon = Math.ceil(bounds.getWest()/lonStep)*lonStep; lon <= bounds.getEast()+1e-9; lon += lonStep) {
    L.polyline([[bounds.getSouth(),lon],[bounds.getNorth(),lon]], {color:"#57606a",weight:1,opacity:.34,dashArray:"3 5",interactive:false}).addTo(state.mapGrid);
    const x = map.latLngToContainerPoint([map.getCenter().lat,lon]).x / size.x * 100;
    const label=document.createElement("span"); label.textContent=`${lon.toFixed(lonStep < .1 ? 2 : 1)}°E`; label.style.left=`${x}%`; lonRoot.append(label);
  }
  for (let lat = Math.ceil(bounds.getSouth()/latStep)*latStep; lat <= bounds.getNorth()+1e-9; lat += latStep) {
    L.polyline([[lat,bounds.getWest()],[lat,bounds.getEast()]], {color:"#57606a",weight:1,opacity:.34,dashArray:"3 5",interactive:false}).addTo(state.mapGrid);
    const y = map.latLngToContainerPoint([lat,map.getCenter().lng]).y / size.y * 100;
    const label=document.createElement("span"); label.textContent=`${lat.toFixed(latStep < .1 ? 2 : 1)}°N`; label.style.top=`${y}%`; latRoot.append(label);
  }
  const c=map.getCenter(); $("mapMeta").textContent=`Center ${c.lat.toFixed(3)}° N, ${c.lng.toFixed(3)}° E · Zoom ${map.getZoom()}`;
}

function initMap() {
  state.map = L.map("leafletMap", { zoomControl: true, fadeAnimation: false }).setView([52.52, 13.405], 10);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(state.map);
  state.mapGrid = L.layerGroup().addTo(state.map);
  L.circleMarker([52.52, 13.405], {radius:7,weight:2,fillOpacity:.9}).addTo(state.map).bindPopup("Berlin");
  L.circleMarker([52.3667,13.5033], {radius:6,weight:2,fillOpacity:.9}).addTo(state.map).bindPopup("BER · EDDB");
  L.control.scale({imperial:false, position:"bottomleft"}).addTo(state.map);
  state.map.on("moveend zoomend resize", refreshMapDecorations);
  refreshMapDecorations();
}
async function init() {
  initTabs();
  initIconCharts();
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
  setInterval(pollLatest, 60000);
  setInterval(loadWeather, 300000);
  setInterval(loadDevices, 300000);
}

init();
