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
  const div = document.createElement("div"); div.className = "taf-period";
  const change = period.fcstChange || "BASE"; const prob = period.probability ? ` ${period.probability}%` : "";
  div.innerHTML = `<span class="wx-badge">${change}${prob}</span><strong>${utcTime(period.timeFrom)} → ${utcTime(period.timeTo)}</strong><br><span class="muted">Wind ${degrees(period.wdir)} ${knots(period.wspd)}${period.wgst ? ` gust ${period.wgst} kt` : ""} · visibility ${period.visib || "—"} mi · ${period.wxString || "NSW"} · ${cloudText(period.clouds)}</span>`;
  return div;
}
async function loadAviationWeather() {
  const root = $("aviationDetail");
  try {
    const data = await fetchJson("/api/v1/weather/aviation"); const m = data.metar; const t = data.taf;
    if (!m || !t) throw new Error("Missing EDDB report");
    const cards = document.createElement("div"); cards.className = "aviation-grid";
    [["Temperature", `${m.temp} °C`], ["Dew point", `${m.dewp} °C`], ["Wind", `${degrees(m.wdir)} · ${knots(m.wspd)}`], ["Visibility", `${m.visib} mi`], ["QNH", `${Math.round(m.altim)} hPa`], ["Flight category", m.fltCat || "—"]].forEach(([a,b]) => cards.append(weatherCard(a,b)));
    const metar = document.createElement("div"); metar.className="wx-panel"; metar.innerHTML=`<h3>METAR · current observation</h3><p class="wx-raw">${m.rawOb}</p><p><strong>Decoded:</strong> ${m.name}; observed ${utcTime(m.obsTime)}. Wind ${degrees(m.wdir)} at ${knots(m.wspd)}, visibility ${m.visib} statute miles, ${cloudText(m.clouds)}, temperature ${m.temp} °C, dew point ${m.dewp} °C, QNH ${Math.round(m.altim)} hPa. ${m.fltCat ? `Flight category ${m.fltCat}.` : ""}</p>`;
    const taf = document.createElement("div"); taf.className="wx-panel"; taf.innerHTML=`<h3>TAF · airport forecast</h3><p class="wx-raw">${t.rawTAF}</p><p class="muted">Issued ${utcTime(t.issueTime)} · valid ${utcTime(t.validTimeFrom)} → ${utcTime(t.validTimeTo)}</p>`; (t.fcsts||[]).forEach(x=>taf.append(tafPeriod(x)));
    const source=document.createElement("p"); source.className="muted"; source.textContent="Source: Aviation Weather Center Data API. No API key or login is required; the Cloudflare Worker fetches and relays EDDB METAR/TAF so browser CORS restrictions do not expose or block the source.";
    root.replaceChildren(cards, metar, taf, source);
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
      if (button.dataset.tab === "map" && state.map) {
        setTimeout(() => state.map.invalidateSize(), 50);
      }
    });
  });
}

function initMap() {
  state.map = L.map("leafletMap").setView([52.52, 13.405], 11);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(state.map);
  L.marker([52.52, 13.405]).addTo(state.map).bindPopup("Berlin");
}

async function init() {
  initTabs();
  initMap();
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
