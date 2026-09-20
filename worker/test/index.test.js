import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker from "../src/index.js";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const TOKEN = "a".repeat(64);
const DEVICE = "sensor-node-01";
const GITHUB_TOKEN = `github_pat_${"b".repeat(64)}`;
const MODEL_UPLOAD_TOKEN = "m".repeat(64);

class D1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new D1Statement(this.database, this.sql, values);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }
}

class D1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1Statement(this.database, sql);
  }
}


class R2Object {
  constructor(key, bytes, metadata = {}, range = null, fullSize = null) {
    this.key = key;
    this.bytes = bytes;
    this.body = bytes;
    this.size = fullSize ?? bytes.byteLength;
    this.etag = `"etag-${key.length}-${this.size}"`;
    this.httpMetadata = metadata.httpMetadata || {};
    this.range = range;
  }
}

class R2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, body, options = {}) {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, { bytes, httpMetadata: options.httpMetadata || {} });
    return new R2Object(key, bytes, { httpMetadata: options.httpMetadata || {} });
  }

  async head(key) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return new R2Object(key, stored.bytes, { httpMetadata: stored.httpMetadata });
  }

  async list(options = {}) {
    const prefix = options.prefix || "";
    const entries = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b));
    const limit = options.limit || 1000;
    const start = options.cursor ? Number(options.cursor) : 0;
    const page = entries.slice(start, start + limit);
    const next = start + page.length;
    return {
      objects: page.map(([key, stored]) => ({ key, size: stored.bytes.byteLength })),
      truncated: next < entries.length,
      cursor: next < entries.length ? String(next) : undefined,
    };
  }

  async get(key, options = {}) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const fullSize = stored.bytes.byteLength;
    if (!options?.range) return new R2Object(key, stored.bytes, { httpMetadata: stored.httpMetadata });
    const offset = options.range.offset || 0;
    const length = options.range.length ?? (fullSize - offset);
    if (offset >= fullSize) return null;
    const bytes = stored.bytes.slice(offset, Math.min(fullSize, offset + length));
    return new R2Object(key, bytes, { httpMetadata: stored.httpMetadata }, { offset, length: bytes.byteLength }, fullSize);
  }
}


function latestStandardRunKey(now = new Date()) {
  const date = new Date(now);
  date.setUTCMinutes(0, 0, 0);
  date.setUTCHours(Math.floor(date.getUTCHours() / 6) * 6);
  return date.toISOString().replace(/[-:]/g, "").replace(/\.000Z$/, "Z");
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}

function request(path, options = {}) {
  return new Request(`https://api.example.test${path}`, options);
}

function ingestRequest(body, token = TOKEN) {
  return request("/api/v1/ingest", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let sqlite;
let env;

beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  sqlite
    .prepare("INSERT INTO devices(device_id, label, token_hash) VALUES(?, ?, ?)")
    .run(DEVICE, "Sensor node", await sha256(TOKEN));
  env = {
    DB: new D1Database(sqlite),
    CORS_ORIGINS: "https://oliwertwister.github.io",
    RETENTION_DAYS: "30",
  };
});

afterEach(() => sqlite.close());

test("health and route-specific CORS", async () => {
  const health = await worker.fetch(request("/health"), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { service: "read-sensor-api", ok: true });

  const allowed = await worker.fetch(
    request("/api/v1/history", {
      method: "OPTIONS",
      headers: { origin: "https://oliwertwister.github.io" },
    }),
    env,
  );
  assert.equal(allowed.status, 204);
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    "https://oliwertwister.github.io",
  );

  const denied = await worker.fetch(
    request("/api/v1/history", {
      method: "OPTIONS",
      headers: { origin: "https://example.invalid" },
    }),
    env,
  );
  assert.equal(denied.status, 403);
});

test("missing, malformed, and unknown bearer tokens are rejected", async () => {
  for (const authorization of [null, "Bearer undefined", `Bearer ${"b".repeat(64)}`]) {
    const headers = { "content-type": "application/json" };
    if (authorization) headers.authorization = authorization;
    const response = await worker.fetch(
      request("/api/v1/ingest", {
        method: "POST",
        headers,
        body: "{}",
      }),
      env,
    );
    assert.equal(response.status, 401);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM readings").get().count, 0);
});

test("valid samples are stored once and returned through history and devices", async () => {
  const recordedAt = new Date().toISOString();
  const sample = {
    device_id: DEVICE,
    metric: "cpu_temperature",
    value: 51.25,
    unit: "\u00b0C",
    recorded_at: recordedAt,
  };

  const created = await worker.fetch(ingestRequest(sample), env);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).stored, true);

  const duplicate = await worker.fetch(ingestRequest(sample), env);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).stored, false);

  const history = await worker.fetch(
    request(`/api/v1/history?device=${DEVICE}&metric=cpu_temperature&limit=10`, {
      headers: { origin: "https://oliwertwister.github.io" },
    }),
    env,
  );
  assert.equal(history.status, 200);
  assert.equal(
    history.headers.get("access-control-allow-origin"),
    "https://oliwertwister.github.io",
  );
  const historyBody = await history.json();
  assert.equal(historyBody.readings.length, 1);
  assert.equal(historyBody.readings[0].value, 51.25);

  const latest = await worker.fetch(
    request(`/api/v1/latest?device=${DEVICE}&metric=cpu_temperature`),
    env,
  );
  assert.equal(latest.status, 200);
  assert.equal((await latest.json()).reading.value, 51.25);

  const devices = await worker.fetch(request("/api/v1/devices"), env);
  assert.equal(devices.status, 200);
  const devicesBody = await devices.json();
  assert.equal(devicesBody.devices.length, 1);
  assert.equal(devicesBody.devices[0].label, "Sensor node");
});

test("history supports ranged queries and extended limits", async () => {
  const now = Date.now();
  const rows = [
    [41, new Date(now - 3 * 60 * 60 * 1000).toISOString()],
    [42, new Date(now - 45 * 60 * 1000).toISOString()],
    [43, new Date(now - 10 * 60 * 1000).toISOString()],
  ];
  for (const [value, recordedAt] of rows) {
    sqlite.prepare(
      "INSERT INTO readings(device_id, metric, value, unit, recorded_at) VALUES(?, ?, ?, ?, ?)",
    ).run(DEVICE, "cpu_temperature", value, "C", recordedAt);
  }

  const since = new Date(now - 60 * 60 * 1000).toISOString();
  const ranged = await worker.fetch(
    request(`/api/v1/history?device=${DEVICE}&metric=cpu_temperature&since=${encodeURIComponent(since)}&limit=10000`),
    env,
  );
  assert.equal(ranged.status, 200);
  const body = await ranged.json();
  assert.equal(body.readings.length, 2);
  assert.deepEqual(body.readings.map((reading) => reading.value), [42, 43]);
  assert.equal(body.since, since);

  const invalid = await worker.fetch(request("/api/v1/history?since=not-a-date"), env);
  assert.equal(invalid.status, 400);
});

test("a device token cannot impersonate another device", async () => {
  const response = await worker.fetch(
    ingestRequest({
      device_id: "raspberry-pi-1",
      metric: "cpu_temperature",
      value: 42,
      unit: "C",
      recorded_at: new Date().toISOString(),
    }),
    env,
  );
  assert.equal(response.status, 400);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM readings").get().count, 0);
});

test("bad JSON, timestamps, sizes, and fractional limits fail cleanly", async () => {
  const nullBody = await worker.fetch(ingestRequest("null"), env);
  assert.equal(nullBody.status, 400);

  const future = await worker.fetch(
    ingestRequest({
      device_id: DEVICE,
      metric: "cpu_temperature",
      value: 42,
      unit: "C",
      recorded_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
    env,
  );
  assert.equal(future.status, 400);

  const oversized = await worker.fetch(ingestRequest(`{"padding":"${"x".repeat(5000)}"}`), env);
  assert.equal(oversized.status, 413);

  const limit = await worker.fetch(request("/api/v1/history?limit=1.5"), env);
  assert.equal(limit.status, 400);
});


test("telemetry retention is hard-capped at 30 days", async () => {
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const response = await worker.fetch(ingestRequest({
    device_id: DEVICE,
    metric: "cpu_temperature",
    value: 41.0,
    unit: "degrees_celsius",
    recorded_at: old,
  }), { ...env, RETENTION_DAYS: "365" });
  assert.equal(response.status, 400);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM readings").get().count, 0);
});

test("model upload bearer parser accepts JWT shape without weakening ingest tokens", async () => {
  const fakeJwt = `${"a".repeat(48)}.${"b".repeat(320)}.${"c".repeat(86)}`;
  const cubeEnv = { ...env, MODEL_CUBE: new R2Bucket() };
  const response = await worker.fetch(request("/api/v1/model-cube-upload-auth-check", {
    method: "POST",
    headers: { authorization: `Bearer ${fakeJwt}` },
  }), cubeEnv);
  assert.equal(response.status, 401);
  const diagnostic = await response.json();
  assert.notEqual(diagnostic.reason, "missing_bearer");
  const ingest = await worker.fetch(ingestRequest({}, fakeJwt), env);
  assert.equal(ingest.status, 401);
});

test("model cube routes fail closed without R2 bindings", async () => {
  const read = await worker.fetch(request("/api/v1/model-cube/latest.json"), env);
  assert.equal(read.status, 503);
  const upload = await worker.fetch(request("/api/v1/model-cube-upload/runs/test/zarr.json", {
    method: "PUT",
    headers: { authorization: `Bearer ${MODEL_UPLOAD_TOKEN}` },
    body: "{}",
  }), env);
  assert.equal(upload.status, 503);
});

test("model cube upload and ranged reads use the R2 gateway", async () => {
  const r2 = new R2Bucket();
  const cubeEnv = { ...env, MODEL_CUBE: r2, MODEL_UPLOAD_TOKEN };
  const bytes = new TextEncoder().encode('{"zarr_format":3,"node_type":"group"}');
  const runKey = latestStandardRunKey();
  const upload = await worker.fetch(request(`/api/v1/model-cube-upload/runs/${runKey}/cube.zarr/zarr.json`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${MODEL_UPLOAD_TOKEN}`,
      "content-type": "application/json",
    },
    body: bytes,
  }), cubeEnv);
  assert.equal(upload.status, 201);

  const full = await worker.fetch(request(`/api/v1/model-cube/runs/${runKey}/cube.zarr/zarr.json`, {
    headers: { origin: "https://oliwertwister.github.io" },
  }), cubeEnv);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "application/json");
  assert.equal(full.headers.get("access-control-allow-origin"), "https://oliwertwister.github.io");
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);

  const ranged = await worker.fetch(request(`/api/v1/model-cube/runs/${runKey}/cube.zarr/zarr.json`, {
    headers: { range: "bytes=2-8" },
  }), cubeEnv);
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), `bytes 2-8/${bytes.byteLength}`);
  assert.equal((await ranged.arrayBuffer()).byteLength, 7);

  const head = await worker.fetch(request(`/api/v1/model-cube/runs/${runKey}/cube.zarr/zarr.json`, {
    method: "HEAD",
  }), cubeEnv);
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get("content-length")), bytes.byteLength);
});

test("model cube storage preflight enforces the project safety ceiling", async () => {
  const r2 = new R2Bucket();
  const cubeEnv = { ...env, MODEL_CUBE: r2, MODEL_UPLOAD_TOKEN };
  await r2.put("icon-eu/runs/seed/cube.zarr/c/0", new Uint8Array(1024));
  const ok = await worker.fetch(request("/api/v1/model-cube-upload-preflight?run_bytes=1048576&run_objects=100", {
    method: "POST",
    headers: { authorization: `Bearer ${MODEL_UPLOAD_TOKEN}` },
    body: "",
  }), cubeEnv);
  assert.equal(ok.status, 200);
  const budget = await ok.json();
  assert.equal(budget.ok, true);
  assert.equal(budget.current_bytes, 1024);
  assert.equal(budget.run_objects, 100);

  const tooLargeRun = await worker.fetch(request("/api/v1/model-cube-upload-preflight?run_bytes=125829121&run_objects=100", {
    method: "POST",
    headers: { authorization: `Bearer ${MODEL_UPLOAD_TOKEN}` },
    body: "",
  }), cubeEnv);
  assert.equal(tooLargeRun.status, 400);
});

test("model cube gateway rejects bad auth, traversal and malformed ranges", async () => {
  const cubeEnv = { ...env, MODEL_CUBE: new R2Bucket(), MODEL_UPLOAD_TOKEN };
  const unauthorized = await worker.fetch(request("/api/v1/model-cube-upload/latest.json", {
    method: "PUT",
    headers: { authorization: `Bearer ${"x".repeat(64)}` },
    body: "{}",
  }), cubeEnv);
  assert.equal(unauthorized.status, 401);

  const traversal = await worker.fetch(request("/api/v1/model-cube/runs//secret"), cubeEnv);
  assert.equal(traversal.status, 400);

  await cubeEnv.MODEL_CUBE.put("icon-eu/latest.json", "abcdef", { httpMetadata: { contentType: "application/json" } });
  const badRange = await worker.fetch(request("/api/v1/model-cube/latest.json", {
    headers: { range: "bytes=-10" },
  }), cubeEnv);
  assert.equal(badRange.status, 416);

  const stale = await worker.fetch(request("/api/v1/model-cube-upload/runs/20200101T000000Z/cube.zarr/zarr.json", {
    method: "PUT",
    headers: { authorization: `Bearer ${MODEL_UPLOAD_TOKEN}` },
    body: "{}",
  }), cubeEnv);
  assert.equal(stale.status, 400);

  const oversized = await worker.fetch(request(`/api/v1/model-cube-upload/runs/${latestStandardRunKey()}/cube.zarr/c/0/0/0`, {
    method: "PUT",
    headers: { authorization: `Bearer ${MODEL_UPLOAD_TOKEN}` },
    body: new Uint8Array(2 * 1024 * 1024 + 1),
  }), cubeEnv);
  assert.equal(oversized.status, 413);
});

test("scheduled events dispatch a satellite-only Pages workflow", async () => {
  const originalFetch = globalThis.fetch;
  let dispatched;
  globalThis.fetch = async (url, options) => {
    dispatched = { url, options };
    return new Response(JSON.stringify({ workflow_run_id: 123 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const staleAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  sqlite.prepare(
    "INSERT INTO readings(device_id, metric, value, unit, recorded_at) VALUES(?, ?, ?, ?, ?)",
  ).run(DEVICE, "cpu_temperature", 20, "degrees_celsius", staleAt);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM readings").get().count, 1);
  try {
    await worker.scheduled(
      { cron: "7,22,37,52 * * * *", scheduledTime: Date.now() },
      {
        ...env,
        GITHUB_ACTIONS_TOKEN: GITHUB_TOKEN,
        GITHUB_OWNER: "oliwertwister",
        GITHUB_REPOSITORY: "read-sensor",
        GITHUB_WORKFLOW: "pages.yml",
        GITHUB_REF: "main",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM readings").get().count, 0);
  assert.equal(
    dispatched.url,
    "https://api.github.com/repos/oliwertwister/read-sensor/actions/workflows/pages.yml/dispatches",
  );
  assert.equal(dispatched.options.method, "POST");
  assert.equal(dispatched.options.headers.authorization, `Bearer ${GITHUB_TOKEN}`);
  assert.equal(dispatched.options.headers["x-github-api-version"], "2026-03-10");
  assert.deepEqual(JSON.parse(dispatched.options.body), {
    ref: "main",
    inputs: { satellite_only: true },
  });
});

test("scheduled events fail closed without a GitHub token", async () => {
  await assert.rejects(
    worker.scheduled(
      { cron: "7,22,37,52 * * * *", scheduledTime: Date.now() },
      env,
    ),
    /GITHUB_ACTIONS_TOKEN is not configured/,
  );
});
