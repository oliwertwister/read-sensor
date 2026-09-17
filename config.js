window.READ_SENSOR_CONFIG = Object.freeze({
  apiBase: "https://read-sensor-api.read-sensor.workers.dev",
  defaultDevice: "sensor-node-01",
  defaultMetric: "cpu_temperature",
  // Fetch enough history to construct an exact rolling 24-hour window even
  // when long outages mean there are far fewer than 288 samples in that day.
  historyLimit: 2016,
});
