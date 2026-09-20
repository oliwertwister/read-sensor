const DEFAULT_DEVICE = "sensor-node-01";
const DEFAULT_METRIC = "cpu_temperature";
const DEFAULT_HISTORY_LIMIT = 288;
const MAX_HISTORY_LIMIT = 10000;
const MAX_BODY_BYTES = 4096;
const DEFAULT_RETENTION_DAYS = 30;
const GITHUB_API_VERSION = "2026-03-10";

const validName = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value);

const validUnit = (value) =>
  typeof value === "string" && /^[A-Za-z0-9%_+./\u00b0-]{0,16}$/u.test(value);

function allowedOrigins(env) {
  return (env.CORS_ORIGINS || "https://oliwertwister.github.io")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const allowed = allowedOrigins(env);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function json(request, env, data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function bearerToken(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(
    request.headers.get("authorization") || "",
  );
  return match?.[1] || null;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function retentionDays(env) {
  const configured = Number(env.RETENTION_DAYS);
  if (!Number.isInteger(configured) || configured < 1 || configured > 365) {
    return DEFAULT_RETENTION_DAYS;
  }
  return configured;
}

function normalizedTimestamp(value, env) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;

  const now = Date.now();
  const oldest = now - retentionDays(env) * 24 * 60 * 60 * 1000;
  if (timestamp < oldest || timestamp > now + 5 * 60 * 1000) return null;
  return new Date(timestamp).toISOString();
}

async function parseIngestBody(request) {
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    return { error: "content_type_must_be_json", status: 415 };
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { error: "payload_too_large", status: 413 };
  }

  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { error: "invalid_payload", status: 400 };
    }
    return { body };
  } catch {
    return { error: "invalid_json", status: 400 };
  }
}

function historyLimit(value) {
  if (value === null) return DEFAULT_HISTORY_LIMIT;
  if (!/^\d+$/.test(value)) return null;
  return Math.min(Math.max(Number(value), 1), MAX_HISTORY_LIMIT);
}

function historyTimestamp(value) {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

async function ingest(request, env) {
  const token = bearerToken(request);
  if (!token) return json(request, env, { error: "unauthorized" }, 401);

  const tokenHash = await sha256Hex(token);
  const credential = await env.DB.prepare(
    "SELECT device_id FROM devices WHERE token_hash = ? AND enabled = 1",
  )
    .bind(tokenHash)
    .first();
  if (!credential) return json(request, env, { error: "unauthorized" }, 401);

  const parsed = await parseIngestBody(request);
  if (parsed.error) {
    return json(request, env, { error: parsed.error }, parsed.status);
  }

  const body = parsed.body;
  const recordedAt = normalizedTimestamp(body.recorded_at, env);
  if (
    !validName(body.device_id) ||
    body.device_id !== credential.device_id ||
    !validName(body.metric) ||
    typeof body.value !== "number" ||
    !Number.isFinite(body.value) ||
    Math.abs(body.value) > 1e12 ||
    !validUnit(body.unit || "") ||
    !recordedAt
  ) {
    return json(request, env, { error: "invalid_payload" }, 400);
  }

  const unit = body.unit || "";
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO readings(device_id, metric, value, unit, recorded_at) VALUES(?, ?, ?, ?, ?)",
  )
    .bind(body.device_id, body.metric, body.value, unit, recordedAt)
    .run();

  await env.DB.prepare(
    `INSERT INTO latest_readings(device_id, metric, value, unit, recorded_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(device_id, metric) DO UPDATE SET
       value = excluded.value,
       unit = excluded.unit,
       recorded_at = excluded.recorded_at
     WHERE excluded.recorded_at >= latest_readings.recorded_at`,
  )
    .bind(body.device_id, body.metric, body.value, unit, recordedAt)
    .run();

  const cutoff = new Date(
    Date.now() - retentionDays(env) * 24 * 60 * 60 * 1000,
  ).toISOString();
  await env.DB.prepare(
    "DELETE FROM readings WHERE device_id = ? AND metric = ? AND recorded_at < ?",
  )
    .bind(body.device_id, body.metric, cutoff)
    .run();

  const stored = (inserted.meta?.changes || 0) > 0;
  return json(
    request,
    env,
    { ok: true, stored, device_id: body.device_id, recorded_at: recordedAt },
    stored ? 201 : 200,
  );
}

async function history(request, env, url) {
  const device = url.searchParams.get("device") || DEFAULT_DEVICE;
  const metric = url.searchParams.get("metric") || DEFAULT_METRIC;
  const limit = historyLimit(url.searchParams.get("limit"));
  const since = historyTimestamp(url.searchParams.get("since"));
  const until = historyTimestamp(url.searchParams.get("until"));
  if (
    !validName(device) || !validName(metric) || limit === null ||
    since === undefined || until === undefined ||
    (since && until && since > until)
  ) {
    return json(request, env, { error: "invalid_query" }, 400);
  }

  const clauses = ["device_id = ?", "metric = ?"];
  const values = [device, metric];
  if (since) { clauses.push("recorded_at >= ?"); values.push(since); }
  if (until) { clauses.push("recorded_at <= ?"); values.push(until); }
  values.push(limit);

  const { results } = await env.DB.prepare(
    `SELECT device_id, metric, value, unit, recorded_at
     FROM readings
     WHERE ${clauses.join(" AND ")}
     ORDER BY recorded_at DESC
     LIMIT ?`,
  )
    .bind(...values)
    .all();

  return json(request, env, {
    device_id: device,
    metric,
    since,
    until,
    readings: results.reverse(),
  });
}

async function latest(request, env, url) {
  const device = url.searchParams.get("device") || DEFAULT_DEVICE;
  const metric = url.searchParams.get("metric") || DEFAULT_METRIC;
  if (!validName(device) || !validName(metric)) {
    return json(request, env, { error: "invalid_query" }, 400);
  }

  const reading = await env.DB.prepare(
    `SELECT device_id, metric, value, unit, recorded_at
     FROM latest_readings
     WHERE device_id = ? AND metric = ?`,
  )
    .bind(device, metric)
    .first();
  return json(request, env, { reading: reading || null });
}

async function devices(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT l.device_id, d.label, l.metric, l.value, l.unit, l.recorded_at AS last_seen
     FROM latest_readings l
     JOIN devices d ON d.device_id = l.device_id
     WHERE d.enabled = 1
     ORDER BY d.label, l.metric`,
  ).all();
  return json(request, env, { devices: results });
}

const AVIATION_BASE = "https://aviationweather.gov/api/data";
const AVIATION_HEADERS = { "User-Agent": "read-sensor/1.1 weather-dashboard" };
const AVIATION_CATALOG_URL = "https://aviationweather.gov/data/cache/stations.cache.json.gz";
const AVIATION_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
let aviationCatalog = null;
let aviationCatalogLoadedAt = 0;

function validAviationStation(value) {
  return typeof value === "string" && /^[A-Z0-9]{3,8}$/.test(value);
}

function normalizedAviationStation(station) {
  if (!station || typeof station !== "object") return null;
  const id = String(station.icaoId || station.id || "").toUpperCase();
  const lat = Number(station.lat);
  const lon = Number(station.lon);
  if (!validAviationStation(id) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const siteType = Array.isArray(station.siteType) ? station.siteType : [];
  return {
    id,
    icao: station.icaoId || id,
    iata: station.iataId || null,
    name: station.site || station.name || id,
    state: station.state || null,
    country: station.country || null,
    lat,
    lon,
    elev: Number.isFinite(Number(station.elev)) ? Number(station.elev) : null,
    metar: siteType.includes("METAR"),
    taf: siteType.includes("TAF"),
  };
}

async function responseJsonOrEmpty(response) {
  if (response.status === 204) return [];
  if (!response.ok) throw new Error(`AWC HTTP ${response.status}`);
  return await response.json();
}

async function decodeGzipJson(response) {
  if (!response.ok) throw new Error(`AWC catalog HTTP ${response.status}`);
  const body = response.body;
  if (!body) return [];
  const stream = body.pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).json();
}

async function loadAviationCatalog() {
  const now = Date.now();
  if (aviationCatalog && now - aviationCatalogLoadedAt < AVIATION_CATALOG_TTL_MS) {
    return aviationCatalog;
  }
  const response = await fetch(AVIATION_CATALOG_URL, { headers: AVIATION_HEADERS });
  const source = await decodeGzipJson(response);
  aviationCatalog = source
    .map(normalizedAviationStation)
    .filter((station) => station && (station.metar || station.taf));
  aviationCatalogLoadedAt = now;
  return aviationCatalog;
}

function aviationSearchScore(station, query) {
  const fields = [station.icao, station.iata, station.name, station.state, station.country]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  const q = query.toLowerCase();
  let score = 0;
  for (const field of fields) {
    if (field === q) score = Math.max(score, 100);
    else if (field.startsWith(q)) score = Math.max(score, 70);
    else if (field.includes(q)) score = Math.max(score, 40);
  }
  if (score > 0) {
    if (station.taf) score += 3;
    if (station.metar) score += 2;
  }
  return score;
}

function parseAviationBbox(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [lat0, lon0, lat1, lon1] = parts;
  if (lat0 < -90 || lat1 > 90 || lon0 < -180 || lon1 > 180 || lat1 <= lat0 || lon1 <= lon0) return null;
  if (lat1 - lat0 > 20 || lon1 - lon0 > 30) return null;
  return parts;
}

async function aviationStations(request, env, url) {
  const query = (url.searchParams.get("q") || "").trim();
  const bboxValue = url.searchParams.get("bbox");
  try {
    if (bboxValue) {
      const bbox = parseAviationBbox(bboxValue);
      if (!bbox) return json(request, env, { error: "invalid_bbox" }, 400);
      const upstream = new URL(`${AVIATION_BASE}/stationinfo`);
      upstream.searchParams.set("bbox", bbox.join(","));
      upstream.searchParams.set("format", "json");
      const stations = await responseJsonOrEmpty(await fetch(upstream, { headers: AVIATION_HEADERS }));
      const normalized = stations
        .map(normalizedAviationStation)
        .filter((station) => station && (station.metar || station.taf))
        .slice(0, 300);
      return json(request, env, { stations: normalized });
    }

    if (query.length < 2 || query.length > 64) {
      return json(request, env, { error: "invalid_query" }, 400);
    }
    const catalog = await loadAviationCatalog();
    const matches = catalog
      .map((station) => ({ station, score: aviationSearchScore(station, query) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.station.icao.localeCompare(b.station.icao))
      .slice(0, 30)
      .map(({ station }) => station);
    return json(request, env, { stations: matches });
  } catch (error) {
    console.error("aviation_stations_upstream", error);
    return json(request, env, { error: "aviation_stations_upstream" }, 502);
  }
}

async function aviationWeather(request, env, url) {
  const station = (url.searchParams.get("station") || "EDDB").trim().toUpperCase();
  if (!validAviationStation(station)) {
    return json(request, env, { error: "invalid_station" }, 400);
  }
  const stationUrl = `${AVIATION_BASE}/stationinfo?ids=${encodeURIComponent(station)}&format=json`;
  const metarUrl = `${AVIATION_BASE}/metar?ids=${encodeURIComponent(station)}&format=json&hours=3`;
  const tafUrl = `${AVIATION_BASE}/taf?ids=${encodeURIComponent(station)}&format=json`;
  try {
    const [stationResponse, metarResponse, tafResponse] = await Promise.all([
      fetch(stationUrl, { headers: AVIATION_HEADERS }),
      fetch(metarUrl, { headers: AVIATION_HEADERS }),
      fetch(tafUrl, { headers: AVIATION_HEADERS }),
    ]);
    const [stationInfo, metars, tafs] = await Promise.all([
      responseJsonOrEmpty(stationResponse),
      responseJsonOrEmpty(metarResponse),
      responseJsonOrEmpty(tafResponse),
    ]);
    const info = normalizedAviationStation(stationInfo[0]) || { id: station, icao: station, name: station };
    return json(request, env, { station, station_info: info, metar: metars[0] || null, taf: tafs[0] || null });
  } catch (error) {
    console.error("aviation_weather_upstream", error);
    return json(request, env, { error: "aviation_weather_upstream" }, 502);
  }
}

const OGIMET_SYNOP_URL = "https://www.ogimet.com/cgi-bin/getsynop";
const SYNOP_CACHE_SECONDS = 10 * 60;

function validWmoStation(value) {
  return typeof value === "string" && /^\d{5}$/.test(value);
}

function compactUtc(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
}

function parseOgimetSynop(text, station) {
  let latest = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const columns = line.split(",");
    if (columns.length < 7 || columns[0].trim() !== station) continue;
    const raw = columns.slice(6).join(",").trim();
    if (!raw.startsWith("AAXX ")) continue;
    const [year, month, day, hour, minute] = columns.slice(1, 6).map((value) => Number(value));
    const timestamp = Date.UTC(year, month - 1, day, hour, minute);
    if (!Number.isFinite(timestamp)) continue;
    const record = {
      wmo: station,
      observation_time: new Date(timestamp).toISOString(),
      raw,
    };
    if (!latest || timestamp > Date.parse(latest.observation_time)) latest = record;
  }
  return latest;
}

async function synopWeather(request, env, url) {
  const station = (url.searchParams.get("station") || "10384").trim();
  if (!validWmoStation(station)) {
    return json(request, env, { error: "invalid_station" }, 400);
  }

  const cache = globalThis.caches?.default || null;
  const cacheKey = new Request(`https://read-sensor-cache.invalid/synop?station=${station}`);
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return json(request, env, await cached.json());
  }

  const end = new Date();
  const begin = new Date(end.getTime() - 12 * 60 * 60 * 1000);
  const upstream = new URL(OGIMET_SYNOP_URL);
  upstream.searchParams.set("block", station.slice(0, 3));
  upstream.searchParams.set("begin", compactUtc(begin));
  upstream.searchParams.set("end", compactUtc(end));
  upstream.searchParams.set("header", "yes");
  upstream.searchParams.set("lang", "eng");

  try {
    const response = await fetch(upstream, {
      headers: { "User-Agent": "read-sensor/1.2 SYNOP dashboard" },
    });
    if (!response.ok) throw new Error(`OGIMET HTTP ${response.status}`);
    const record = parseOgimetSynop(await response.text(), station);
    const payload = record || { wmo: station, observation_time: null, raw: null };
    if (cache) {
      await cache.put(cacheKey, new Response(JSON.stringify(payload), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${SYNOP_CACHE_SECONDS}`,
        },
      }));
    }
    return json(request, env, payload);
  } catch (error) {
    console.error("synop_weather_upstream", error);
    return json(request, env, { error: "synop_weather_upstream" }, 502);
  }
}

function githubDispatchSettings(env) {
  const owner = env.GITHUB_OWNER || "oliwertwister";
  const repository = env.GITHUB_REPOSITORY || "read-sensor";
  const workflow = env.GITHUB_WORKFLOW || "pages.yml";
  const reference = env.GITHUB_REF || "main";
  const safeComponent = /^[A-Za-z0-9_.-]{1,100}$/;
  if (
    !safeComponent.test(owner) ||
    !safeComponent.test(repository) ||
    !safeComponent.test(workflow) ||
    !safeComponent.test(reference)
  ) {
    throw new Error("invalid GitHub dispatch configuration");
  }
  if (typeof env.GITHUB_ACTIONS_TOKEN !== "string" || env.GITHUB_ACTIONS_TOKEN.length < 20) {
    throw new Error("GITHUB_ACTIONS_TOKEN is not configured");
  }
  return { owner, repository, workflow, reference };
}

async function dispatchSatelliteRefresh(env) {
  const { owner, repository, workflow, reference } = githubDispatchSettings(env);
  const endpoint = [
    "https://api.github.com/repos",
    encodeURIComponent(owner),
    encodeURIComponent(repository),
    "actions/workflows",
    encodeURIComponent(workflow),
    "dispatches",
  ].join("/");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "read-sensor-cloudflare-scheduler/1.0",
      "x-github-api-version": GITHUB_API_VERSION,
    },
    body: JSON.stringify({
      ref: reference,
      inputs: { satellite_only: true },
    }),
  });
  if (!response.ok) {
    throw new Error(`GitHub workflow dispatch failed with HTTP ${response.status}`);
  }
  return { status: response.status };
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        const headers = corsHeaders(request, env);
        if (!headers["access-control-allow-origin"]) {
          return new Response(null, { status: 403 });
        }
        return new Response(null, { status: 204, headers });
      }

      if (url.pathname === "/health" && request.method === "GET") {
        await env.DB.prepare("SELECT 1 AS ok").first();
        return json(request, env, { service: "read-sensor-api", ok: true });
      }
      if (url.pathname === "/api/v1/ingest" && request.method === "POST") {
        return await ingest(request, env);
      }
      if (url.pathname === "/api/v1/history" && request.method === "GET") {
        return await history(request, env, url);
      }
      if (url.pathname === "/api/v1/latest" && request.method === "GET") {
        return await latest(request, env, url);
      }
      if (url.pathname === "/api/v1/devices" && request.method === "GET") {
        return await devices(request, env);
      }
      if (url.pathname === "/api/v1/weather/aviation" && request.method === "GET") {
        return await aviationWeather(request, env, url);
      }
      if (url.pathname === "/api/v1/weather/airports" && request.method === "GET") {
        return await aviationStations(request, env, url);
      }
      if (url.pathname === "/api/v1/weather/synop" && request.method === "GET") {
        return await synopWeather(request, env, url);
      }

      return json(request, env, { error: "not_found" }, 404);
    } catch (error) {
      console.error("request_failed", error);
      return json(request, env, { error: "internal_error" }, 500);
    }
  },
  async scheduled(controller, env) {
    const result = await dispatchSatelliteRefresh(env);
    console.log(JSON.stringify({
      event: "satellite_refresh_dispatched",
      cron: controller.cron,
      scheduled_time: new Date(controller.scheduledTime).toISOString(),
      github_status: result.status,
    }));
  },
};
