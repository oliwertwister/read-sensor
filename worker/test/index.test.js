import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import worker from "../src/index.js";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const TOKEN = "a".repeat(64);
const DEVICE = "sensor-node-01";

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
