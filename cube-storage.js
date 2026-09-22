(() => {
  const API_BASE = (window.READ_SENSOR_CONFIG?.apiBase || "").replace(/\/$/, "");
  const READ_PREFIX = `${API_BASE}/api/v1/model-cube`;
  let libraryPromise = null;
  let statePromise = null;

  function loadLibrary() {
    if (window.ReadSensorZarr) return Promise.resolve(window.ReadSensorZarr);
    if (libraryPromise) return libraryPromise;
    libraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/zarrita-read-sensor.min.js?v=0.7.5";
      script.async = true;
      script.onload = () => window.ReadSensorZarr ? resolve(window.ReadSensorZarr) : reject(new Error("Zarrita bundle did not initialize"));
      script.onerror = () => reject(new Error("Could not load Zarrita bundle"));
      document.head.append(script);
    });
    return libraryPromise;
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
      if (response.status === 503 || response.status === 404) return { available: false, reason: "cube_not_published" };
      if (!response.ok) throw new Error(`Cube pointer HTTP ${response.status}`);
      const latest = await response.json();
      const zarr = await loadLibrary();
      const cube = await zarr.openCube(`${READ_PREFIX}/${latest.cube_url}`);
      return { available: true, latest, cube };
    })().catch((error) => {
      console.warn("model_cube_connect_failed", error);
      return { available: false, reason: "connect_failed", error };
    });
    return statePromise;
  }

  window.ReadSensorCube = Object.freeze({ connect, listRuns, readPrefix: READ_PREFIX });
})();
