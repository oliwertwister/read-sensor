"use strict";

(() => {
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  const MAX_EXPANDED_BYTES = 20 * 1024 * 1024;
  const MAX_FEATURES = 20000;
  const decoder = new TextDecoder("utf-8");
  const scriptPromises = new Map();

  function loadScript(src) {
    if (scriptPromises.has(src)) return scriptPromises.get(src);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load ${src}.`));
      document.head.append(script);
    });
    scriptPromises.set(src, promise);
    return promise;
  }

  const extension = (name) => {
    const match = name.toLowerCase().match(/\.([^.\/]+)$/);
    return match ? match[1] : "";
  };

  const cleanName = (name) => name.split(/[\\/]/).pop() || name;
  const stem = (name) => cleanName(name).replace(/\.[^.]+$/, "");
  const exactBuffer = (bytes) => bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );

  function countFeatures(geojson) {
    if (!geojson) return 0;
    if (geojson.type === "FeatureCollection") return geojson.features?.length || 0;
    if (geojson.type === "Feature") return 1;
    return 1;
  }

  function enforceFeatureLimit(datasets) {
    const count = datasets.reduce((sum, item) => sum + countFeatures(item.geojson), 0);
    if (count > MAX_FEATURES) {
      throw new Error(`Too many features (${count.toLocaleString()}); limit is ${MAX_FEATURES.toLocaleString()}.`);
    }
    return count;
  }

  function normalizeShp(result, fallbackName) {
    const list = Array.isArray(result) ? result : [result];
    return list.filter(Boolean).map((geojson, index) => ({
      name: geojson.fileName || (list.length > 1 ? `${fallbackName} ${index + 1}` : fallbackName),
      geojson,
    }));
  }

  function parseGeoJson(name, bytes) {
    let geojson;
    try {
      geojson = JSON.parse(decoder.decode(bytes));
    } catch {
      throw new Error(`${cleanName(name)} is not valid GeoJSON/JSON.`);
    }
    if (!geojson?.type) throw new Error(`${cleanName(name)} has no GeoJSON type.`);
    return [{ name: stem(name), geojson }];
  }

  async function parseShapeParts(entries) {
    if (!window.shp) await loadScript("vendor/shp.min.js");
    const groups = new Map();
    for (const [name, bytes] of Object.entries(entries)) {
      const ext = extension(name);
      if (!["shp", "dbf", "prj", "cpg"].includes(ext)) continue;
      const key = stem(name).toLowerCase();
      if (!groups.has(key)) groups.set(key, { label: stem(name) });
      groups.get(key)[ext] = bytes;
    }
    const datasets = [];
    for (const group of groups.values()) {
      if (!group.shp) continue;
      const input = { shp: exactBuffer(group.shp) };
      if (group.dbf) input.dbf = exactBuffer(group.dbf);
      if (group.prj) input.prj = exactBuffer(group.prj);
      if (group.cpg) input.cpg = exactBuffer(group.cpg);
      const result = await window.shp(input);
      datasets.push(...normalizeShp(result, group.label));
    }
    return datasets;
  }

  function expandedSize(entries) {
    return Object.values(entries).reduce((sum, bytes) => sum + (bytes?.byteLength || 0), 0);
  }

  async function parseGeoPackage(name, bytes) {
    if (!window.GeoPackage) await loadScript("vendor/geopackage.min.js");
    const G = window.GeoPackage;
    if (!G?.GeoPackageAPI || !G?.GeoPackage) throw new Error("GeoPackage parser is unavailable.");
    G.setSqljsWasmLocateFile(() => "vendor/sql-wasm.wasm");
    const gp = await G.GeoPackageAPI.open(new Uint8Array(bytes));
    const datasets = [];
    try {
      for (const table of gp.getFeatureTables()) {
        const dao = gp.getFeatureDao(table);
        const info = gp.getInfoForTable(dao);
        const features = [];
        const rows = dao.queryForEach();
        for (const rawRow of rows) {
          const row = dao.getRow(rawRow);
          const feature = G.GeoPackage.parseFeatureRowIntoGeoJSON(row, dao.srs, info.columnMap);
          if (feature?.geometry) features.push(feature);
          if (features.length > MAX_FEATURES) {
            throw new Error(`GeoPackage layer ${table} exceeds ${MAX_FEATURES.toLocaleString()} features.`);
          }
        }
        datasets.push({ name: `${stem(name)} · ${table}`, geojson: { type: "FeatureCollection", features } });
      }
    } finally {
      gp.close?.();
    }
    if (!datasets.length) throw new Error("GeoPackage contains no feature layers.");
    return datasets;
  }

  async function parseArchiveEntries(entries) {
    if (expandedSize(entries) > MAX_EXPANDED_BYTES) {
      throw new Error("Expanded archive exceeds the 20 MiB safety limit.");
    }
    const datasets = await parseShapeParts(entries);
    for (const [name, bytes] of Object.entries(entries)) {
      const ext = extension(name);
      if (ext === "geojson" || ext === "json") {
        datasets.push(...parseGeoJson(name, bytes));
      } else if (ext === "gpkg") {
        datasets.push(...await parseGeoPackage(name, bytes));
      } else if (ext === "zip") {
        datasets.push(...await parseZipBytes(name, exactBuffer(bytes)));
      }
    }
    if (!datasets.length) {
      throw new Error("Archive contains no supported geometry (Shapefile, GeoJSON, or GeoPackage).");
    }
    return datasets;
  }

  async function parseZipBytes(name, buffer) {
    if (!window.fflate) await loadScript("vendor/fflate.min.js");
    if (!window.fflate) throw new Error("ZIP parser is unavailable.");
    let entries;
    try {
      entries = window.fflate.unzipSync(new Uint8Array(buffer));
    } catch {
      throw new Error(`${cleanName(name)} is not a readable ZIP archive.`);
    }
    return parseArchiveEntries(entries);
  }

  async function parseRarBytes(name, buffer) {
    const files = await new Promise((resolve, reject) => {
      const worker = new Worker("rar-worker.js", { type: "module" });
      worker.onmessage = (event) => {
        worker.terminate();
        if (!event.data?.ok) reject(new Error(event.data?.error || "RAR extraction failed."));
        else resolve(event.data.files || []);
      };
      worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message || "RAR worker failed.")); };
      worker.postMessage({ buffer, maxExpandedBytes: MAX_EXPANDED_BYTES }, [buffer]);
    });
    const entries = {};
    for (const file of files) entries[file.name] = new Uint8Array(file.buffer);
    if (!Object.keys(entries).length) throw new Error(`${cleanName(name)} contains no files.`);
    return parseArchiveEntries(entries);
  }

  async function loadFiles(files) {
    const list = [...(files || [])];
    if (!list.length) return { datasets: [], featureCount: 0 };

    for (const file of list) {
      if (file.size > MAX_UPLOAD_BYTES) {
        throw new Error(`${file.name} is ${(file.size / 1048576).toFixed(1)} MiB; maximum is 3 MiB per file.`);
      }
    }

    const shapeExts = new Set(["shp", "dbf", "shx", "prj", "cpg"]);
    const shapeGroups = new Map();
    const regular = [];
    for (const file of list) {
      const ext = extension(file.name);
      if (!shapeExts.has(ext)) { regular.push(file); continue; }
      const key = stem(file.name).toLowerCase();
      if (!shapeGroups.has(key)) shapeGroups.set(key, []);
      shapeGroups.get(key).push(file);
    }

    const datasets = [];
    for (const filesForShape of shapeGroups.values()) {
      const entries = {};
      for (const file of filesForShape) entries[file.name] = new Uint8Array(await file.arrayBuffer());
      const hasShp = filesForShape.some((file) => extension(file.name) === "shp");
      if (!hasShp) throw new Error(`Shapefile selection is missing .shp for ${stem(filesForShape[0].name)}.`);
      datasets.push(...await parseShapeParts(entries));
    }

    for (const file of regular) {
      const result = await load(file);
      datasets.push(...result.datasets);
    }
    const featureCount = enforceFeatureLimit(datasets);
    return { datasets, featureCount };
  }

  async function load(file) {
    if (!file) return { datasets: [], featureCount: 0 };
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new Error(`File is ${(file.size / 1048576).toFixed(1)} MiB; maximum is 10 MiB.`);
    }
    const ext = extension(file.name);
    const buffer = await file.arrayBuffer();
    let datasets;
    if (ext === "geojson" || ext === "json") {
      datasets = parseGeoJson(file.name, new Uint8Array(buffer));
    } else if (ext === "zip") {
      datasets = await parseZipBytes(file.name, buffer);
    } else if (ext === "rar") {
      datasets = await parseRarBytes(file.name, buffer);
    } else if (ext === "gpkg") {
      datasets = await parseGeoPackage(file.name, new Uint8Array(buffer));
    } else {
      throw new Error("Supported files: GeoJSON/JSON, GeoPackage, ZIP or RAR containing a Shapefile.");
    }
    const featureCount = enforceFeatureLimit(datasets);
    return { datasets, featureCount };
  }

  window.GeometryLoader = Object.freeze({
    load,
    loadFiles,
    limits: Object.freeze({ uploadMiB: 5, expandedMiB: 20, features: MAX_FEATURES }),
  });
})();
