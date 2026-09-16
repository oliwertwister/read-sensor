"use strict";

(() => {
  let map = null;
  let group = null;
  let combinedBounds = null;
  const $ = (id) => document.getElementById(id);

  function popupNode(properties = {}) {
    const root = document.createElement("div");
    root.className = "geometry-popup";
    const entries = Object.entries(properties).slice(0, 20);
    if (!entries.length) {
      root.textContent = "Geometry feature";
      return root;
    }
    const table = document.createElement("table");
    for (const [key, value] of entries) {
      const row = document.createElement("tr");
      const th = document.createElement("th");
      const td = document.createElement("td");
      th.textContent = key;
      td.textContent = value == null ? "" : String(value);
      row.append(th, td);
      table.append(row);
    }
    root.append(table);
    return root;
  }

  function makeLayer(dataset) {
    return L.geoJSON(dataset.geojson, {
      style: () => ({ weight: 3, opacity: 0.9, fillOpacity: 0.18 }),
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
        radius: 5,
        weight: 2,
        fillOpacity: 0.75,
      }),
      onEachFeature: (feature, layer) => {
        layer.bindPopup(popupNode(feature.properties || {}), { maxWidth: 420 });
      },
    });
  }

  function updateButtons() {
    const hasGeometry = !!(group && group.getLayers().length);
    $("geometryFit").disabled = !hasGeometry;
    $("geometryClear").disabled = !hasGeometry;
  }

  function fitGeometry() {
    if (!map || !combinedBounds?.isValid()) return;
    map.fitBounds(combinedBounds.pad(0.08), { maxZoom: 15 });
  }

  function clearGeometry() {
    group?.clearLayers();
    combinedBounds = null;
    $("geometryStatus").textContent = "GeoJSON · GPKG · SHP (+ DBF/PRJ) · ZIP/RAR · max 10 MiB";
    updateButtons();
  }

  async function addFile(file) {
    const result = await window.GeometryLoader.load(file);
    for (const dataset of result.datasets) {
      const layer = makeLayer(dataset);
      layer.addTo(group);
      const b = layer.getBounds?.();
      if (b?.isValid()) {
        combinedBounds = combinedBounds?.isValid()
          ? combinedBounds.extend(b)
          : L.latLngBounds(b);
      }
    }
    return result;
  }

  async function addFiles(files) {
    if (!map || !group) throw new Error("Open Berlin Map before adding geometry.");
    const list = [...files];
    if (!list.length) return;
    const names = list.length === 1 ? list[0].name : `${list.length} files`;
    $("geometryStatus").textContent = `Reading ${names} locally…`;
    const result = window.GeometryLoader.loadFiles
      ? await window.GeometryLoader.loadFiles(list)
      : await window.GeometryLoader.load(list[0]);
    for (const dataset of result.datasets) {
      const layer = makeLayer(dataset);
      layer.addTo(group);
      const b = layer.getBounds?.();
      if (b?.isValid()) {
        combinedBounds = combinedBounds?.isValid() ? combinedBounds.extend(b) : L.latLngBounds(b);
      }
    }
    updateButtons();
    fitGeometry();
    const layers = result.datasets.length;
    $("geometryStatus").textContent = `${names} · ${layers} layer${layers === 1 ? "" : "s"} · ${result.featureCount.toLocaleString()} features · local only`;
  }

  function attachToMap(nextMap) {
    map = nextMap;
    if (!group) group = L.featureGroup().addTo(map);
    updateButtons();
  }

  function init() {
    $("geometryFit").addEventListener("click", fitGeometry);
    $("geometryClear").addEventListener("click", clearGeometry);
    $("geometryFile").addEventListener("change", async (event) => {
      const files = [...(event.target.files || [])];
      event.target.value = "";
      if (!files.length) return;
      try {
        await addFiles(files);
      } catch (error) {
        console.error("geometry_load_failed", error);
        $("geometryStatus").textContent = error?.message || "Geometry could not be loaded.";
      }
    });

    const frame = document.querySelector(".map-frame");
    for (const type of ["dragenter", "dragover"]) {
      frame.addEventListener(type, (event) => {
        event.preventDefault();
        frame.classList.add("geometry-drop-active");
      });
    }
    for (const type of ["dragleave", "drop"]) {
      frame.addEventListener(type, (event) => {
        event.preventDefault();
        frame.classList.remove("geometry-drop-active");
      });
    }
    frame.addEventListener("drop", async (event) => {
      const files = [...(event.dataTransfer?.files || [])];
      if (!files.length) return;
      try { await addFiles(files); }
      catch (error) {
        console.error("geometry_drop_failed", error);
        $("geometryStatus").textContent = error?.message || "Geometry could not be loaded.";
      }
    });
  }

  window.GeometryUI = Object.freeze({ init, attachToMap, clear: clearGeometry });
})();
