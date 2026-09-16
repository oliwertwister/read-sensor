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

function initTabs() {
  document.querySelectorAll("nav button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab, nav button").forEach((element) =>
        element.classList.remove("active"),
      );
      button.classList.add("active");
      $(button.dataset.tab).classList.add("active");
      if (button.dataset.tab === "map" && state.map) {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          state.map.invalidateSize({ pan: false, animate: false });
          state.map.setView([52.52, 13.405], 11, { animate: false });
          addCoordinateGrid(state.map);
        }));
      }
    });
  });
}

function initMap() {
  state.map = L.map("leafletMap", { zoomControl: true }).setView([52.52, 13.405], 11);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  }).addTo(state.map);
  L.marker([52.52, 13.405]).addTo(state.map).bindPopup("Berlin");
  L.control.scale({ imperial: false, position: "bottomleft" }).addTo(state.map);
  addCoordinateGrid(state.map);
  state.map.on("moveend zoomend", () => addCoordinateGrid(state.map));
}

function addCoordinateGrid(map) {
  if (state.coordinateGrid) state.coordinateGrid.remove();
  const group = L.layerGroup().addTo(map);
  state.coordinateGrid = group;
  const b = map.getBounds();
  const step = map.getZoom() >= 12 ? 0.02 : map.getZoom() >= 10 ? 0.05 : 0.1;
  const firstLat = Math.ceil(b.getSouth() / step) * step;
  const firstLon = Math.ceil(b.getWest() / step) * step;
  for (let lat = firstLat; lat <= b.getNorth(); lat += step) {
    L.polyline([[lat,b.getWest()],[lat,b.getEast()]], {className:"coord-grid-line", interactive:false}).addTo(group);
    L.marker([lat,b.getWest()], {icon: coordinateLabel(`${lat.toFixed(2)}° N`, "lat"), interactive:false}).addTo(group);
  }
  for (let lon = firstLon; lon <= b.getEast(); lon += step) {
    L.polyline([[b.getSouth(),lon],[b.getNorth(),lon]], {className:"coord-grid-line", interactive:false}).addTo(group);
    L.marker([b.getSouth(),lon], {icon: coordinateLabel(`${lon.toFixed(2)}° E`, "lon"), interactive:false}).addTo(group);
  }
}

function coordinateLabel(text, axis) {
  return L.divIcon({className:`coord-label coord-label-${axis}`, html:text, iconSize:null});
}

async function init() {
  initTabs();
  initMap();
  const healthUrl = apiUrl("/health");
  $("apiLink").href = healthUrl;
  $("apiLink").textContent = healthUrl.origin;

  $("deviceSelect").addEventListener("change", async (event) => {
    state.device = event.target.value;
    state.readings = [];
    await loadHistory();
  });

  await Promise.all([loadWeather(), loadDevices()]);
  await loadHistory();
  setInterval(updateAge, 30000);
  setInterval(pollLatest, 60000);
  setInterval(loadWeather, 300000);
  setInterval(loadDevices, 300000);
}

init();
