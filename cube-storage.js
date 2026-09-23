(() => {
  const API_BASE = (window.READ_SENSOR_CONFIG?.apiBase || "").replace(/\/$/, "");
  const READ_PREFIX = `${API_BASE}/api/v1/model-cube`;
  let statePromise = null;
  let workerPromise = null;
  let requestId = 0;
  const pending = new Map();

  function cubeUrl(relative) {
    return `${READ_PREFIX}/${relative}`;
  }

  function ensureWorker() {
    if (workerPromise) return workerPromise;
    workerPromise = Promise.resolve().then(() => {
      const worker = new Worker("cube-reader-worker.js?v=blosc-worker-2");
      worker.addEventListener("message", (event) => {
        const message = event.data || {};
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.ok) request.resolve(message);
        else request.reject(new Error(message.cause ? `${message.error}: ${message.cause}` : message.error));
      });
      worker.addEventListener("error", (event) => {
        const error = new Error(event.message || "Cube worker failed");
        console.warn("model_cube_worker_error", error);
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        worker.terminate();
        workerPromise = null;
      });
      return worker;
    }).catch((error) => {
      workerPromise = null;
      throw error;
    });
    return workerPromise;
  }

  async function workerRequest(op, cubeRelative, payload = {}) {
    const worker = await ensureWorker();
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, op, cubeUrl: cubeUrl(cubeRelative), ...payload });
    });
  }

  async function listRuns(limit = 8) {
    const bounded = Number(limit);
    if (!Number.isInteger(bounded) || bounded < 1 || bounded > 16) {
      throw new RangeError("Model run limit must be an integer from 1 to 16");
    }
    if (!API_BASE) return { version: 1, count: 0, runs: [], reason: "api_base_missing" };
    const response = await fetch(`${API_BASE}/api/v1/model-runs?limit=${bounded}`, { cache: "no-store" });
    if (response.status === 503) return { version: 1, count: 0, runs: [], reason: "cube_not_published" };
    if (!response.ok) throw new Error(`Model runs HTTP ${response.status}`);
    return response.json();
  }

  async function connect() {
    if (statePromise) return statePromise;
    statePromise = (async () => {
      if (!API_BASE) return { available: false, reason: "api_base_missing" };
      const response = await fetch(`${READ_PREFIX}/latest.json`, { cache: "no-store" });
      if (response.status === 503 || response.status === 404) {
        return { available: false, reason: "cube_not_published" };
      }
      if (!response.ok) throw new Error(`Cube pointer HTTP ${response.status}`);
      const latest = await response.json();
      return { available: true, latest };
    })().catch((error) => {
      console.warn("model_cube_connect_failed", error);
      return { available: false, reason: "connect_failed", error };
    });
    return statePromise;
  }

  async function readWindow2d(cubeRelative, variable, prefix, yStart, yStop, xStart, xStop) {
    const response = await workerRequest("window2d", cubeRelative, {
      variable, prefix, yStart, yStop, xStart, xStop,
    });
    return {
      shape: response.shape,
      data: new Float32Array(response.data),
    };
  }

  async function readGrid(cubeRelative) {
    const response = await workerRequest("grid", cubeRelative);
    return {
      latitude: response.latitude,
      longitude: response.longitude,
    };
  }

  window.ReadSensorCube = Object.freeze({
    connect,
    listRuns,
    readWindow2d,
    readGrid,
    readPrefix: READ_PREFIX,
  });
})();
