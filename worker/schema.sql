CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL
);

DROP INDEX IF EXISTS idx_readings_lookup;
CREATE UNIQUE INDEX IF NOT EXISTS idx_readings_unique
  ON readings(device_id, metric, recorded_at);

CREATE TABLE IF NOT EXISTS latest_readings (
  device_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (device_id, metric)
);
