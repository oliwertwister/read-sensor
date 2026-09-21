(() => {
  "use strict";

  const iconModelState = {
    map: null,
    meta: null,
    instances: new Map(),
    grids: new Map(),
    rows: new Map(),
    timeline: null,
    currentStepIndex: 0,
    selectedPressureLevel: null,
    layerPreferences: new Map(),
    layerGroupOpen: new Map(),
    layerFieldOpen: new Map(),
    switchSerial: 0,
    animationPlaying: false,
    animationTimer: null,
    animationSerial: 0,
    prefetchedSteps: new Set(),
    cubeState: null,
    assetVersion: null,
    initializing: null,
  };

  const iconEl = (id) => document.getElementById(id);
  const FIELD_ORDER = ["t2m", "dewpoint2m", "pmsl", "rh2m", "cloud", "precip", "wind"];

  function modelTime(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC", day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date) + " UTC";
  }

  function compactModelTime(value) {
    const date = new Date(value || "");
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date) + " UTC";
  }

  function updateModelMetaCards() {
    const meta = iconModelState.meta;
    if (!meta) return;
    if (iconEl("iconMapRun")) iconEl("iconMapRun").textContent = modelTime(meta.run_at);
    if (iconEl("iconMapSatellite")) iconEl("iconMapSatellite").textContent = modelTime(meta.satellite_observed_at);
    if (iconEl("iconMapGrid")) iconEl("iconMapGrid").textContent = `${meta.native_grid.spacing_degrees}°`;
  }

  function versioned(path) {
    const version = iconModelState.assetVersion || iconModelState.meta?.valid_at || Date.now();
    return `${path}?v=${encodeURIComponent(version)}`;
  }

  async function fetchModelJson(path) {
    const response = await fetch(versioned(path), { cache: "force-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
    return await response.json();
  }
  function setMapStatus(message, kind = "") {
    const target = iconEl("iconMapStatus");
    if (!target) return;
    target.textContent = message;
    target.className = `status ${kind}`.trim();
  }

  function makePanes(map) {
    const panes = [
      ["modelSatellite", 220],
      ["modelRaster", 260],
      ["modelContours", 360],
      ["modelVectors", 410],
    ];
    for (const [name, zIndex] of panes) {
      const pane = map.createPane(name);
      pane.style.zIndex = String(zIndex);
      pane.style.pointerEvents = name === "modelRaster" || name === "modelSatellite" ? "none" : "auto";
    }
  }

  function makeMap() {
    const meta = iconModelState.meta;
    const map = L.map("iconInteractiveMap", {
      zoomControl: true,
      fadeAnimation: false,
      preferCanvas: true,
      worldCopyJump: false,
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(map);
    makePanes(map);
    map.fitBounds(meta.bounds, { padding: [8, 8] });
    map.on("mousemove", (event) => {
      iconEl("iconMapCursor").textContent =
        `${event.latlng.lat.toFixed(3)}°N · ${event.latlng.lng.toFixed(3)}°E`;
    });
    map.on("mouseout", () => {
      iconEl("iconMapCursor").textContent = "Move over map to inspect coordinates";
    });
    map.on("click", queryMapPoint);
    iconModelState.map = map;
    return map;
  }

  function layerOpacity(def) {
    const row = iconModelState.rows.get(def.id);
    const slider = row?.querySelector('input[type="range"]');
    return slider ? Number(slider.value) / 100 : Number(def.opacity ?? 1);
  }

  function applyOpacity(instance, def) {
    const opacity = layerOpacity(def);
    if (def.kind === "raster" || def.kind === "satellite") {
      instance.setOpacity(opacity);
      return;
    }
    if (def.kind === "contours") {
      instance.setStyle({ opacity });
      return;
    }
    if (def.kind === "vectors") {
      instance.eachLayer((layer) => {
        if (typeof layer.setOpacity === "function") layer.setOpacity(opacity);
      });
    }
  }

  function contourStyle(def) {
    return {
      color: def.line_color || "#111111",
      weight: 1.7,
      opacity: layerOpacity(def),
      className: "model-contour-path",
    };
  }
  async function createLayer(def) {
    if (def.kind === "raster" || def.kind === "satellite") {
      const pane = def.kind === "satellite" ? "modelSatellite" : "modelRaster";
      return L.imageOverlay(versioned(def.file), def.bounds, {
        opacity: layerOpacity(def),
        pane,
        interactive: false,
      });
    }

    const data = await fetchModelJson(def.file);
    if (def.kind === "contours") {
      return L.geoJSON(data, {
        pane: "modelContours",
        style: () => contourStyle(def),
        onEachFeature(feature, layer) {
          const text = feature.properties?.text;
          if (!text) return;
          if (feature.properties?.label) {
            layer.bindTooltip(text, {
              permanent: true,
              direction: "center",
              className: "model-contour-label",
              opacity: 0.92,
            });
          } else {
            layer.bindTooltip(text, {
              sticky: true,
              className: "model-contour-hover",
            });
          }
        },
      });
    }

    if (def.kind === "vectors") {
      return L.geoJSON(data, {
        pane: "modelVectors",
        pointToLayer(feature, latlng) {
          const props = feature.properties || {};
          const degrees = Number(props.to_degrees || 0);
          const icon = L.divIcon({
            className: "model-wind-icon",
            html: `<span style="transform:rotate(${degrees}deg)">↑</span>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          });
          const marker = L.marker(latlng, {
            pane: "modelVectors",
            icon,
            opacity: layerOpacity(def),
            keyboard: false,
            bubblingMouseEvents: true,
          });
          marker.bindTooltip(
            `${Number(props.speed).toFixed(1)} m/s · u ${props.u} · v ${props.v}`,
            { direction: "top", className: "model-vector-tooltip" },
          );
          return marker;
        },
      });
    }

    throw new Error(`Unsupported model layer kind: ${def.kind}`);
  }

  async function setLayerEnabled(def, enabled) {
    const row = iconModelState.rows.get(def.id);
    const checkbox = row?.querySelector('input[type="checkbox"]');
    if (checkbox) checkbox.disabled = true;
    try {
      let instance = iconModelState.instances.get(def.id);
      if (enabled && !instance) {
        setMapStatus(`Loading ${def.label}…`);
        instance = await createLayer(def);
        iconModelState.instances.set(def.id, instance);
      }
      if (enabled && instance && !iconModelState.map.hasLayer(instance)) {
        instance.addTo(iconModelState.map);
        applyOpacity(instance, def);
      }
      if (!enabled && instance && iconModelState.map.hasLayer(instance)) {
        iconModelState.map.removeLayer(instance);
      }
      setMapStatus("Interactive fields ready", "ok");
    } catch (error) {
      console.error("icon_layer_failed", def.id, error);
      if (checkbox) checkbox.checked = false;
      setMapStatus(`Could not load ${def.label}`, "warning");
    } finally {
      if (checkbox) checkbox.disabled = false;
      updateActiveLayersSummary();
    }
  }
  function colorLegend(field) {
    const legend = document.createElement("div");
    legend.className = "model-layer-legend";
    const bar = document.createElement("span");
    bar.className = "model-layer-gradient";
    const colors = field.color_stops.map((stop) => `${stop.color}`).join(", ");
    bar.style.background = `linear-gradient(90deg, ${colors})`;
    const min = document.createElement("small");
    min.textContent = `${field.range[0]} ${field.unit}`;
    const max = document.createElement("small");
    max.textContent = `${field.range[1]} ${field.unit}`;
    legend.append(min, bar, max);
    return legend;
  }

  function layerEnabled(def) {
    const preference = iconModelState.layerPreferences.get(def.id);
    return preference?.enabled ?? Boolean(def.default);
  }

  function updateLayerPanelSummary() {
    const badge = iconEl("iconLayerActiveCount");
    if (!badge || !iconModelState.meta) return;
    const visibleDefs = iconModelState.meta.layers.filter((def) => (
      def.pressure_level_hpa == null
      || Number(def.pressure_level_hpa) === Number(iconModelState.selectedPressureLevel)
    ));
    const active = visibleDefs.filter((def) => layerEnabled(def)).length;
    badge.textContent = `${active} active`;

    for (const group of document.querySelectorAll(".model-layer-group")) {
      const key = group.dataset.layerGroup;
      const defs = visibleDefs.filter((def) => layerSection(def).key === key);
      const enabled = defs.filter((def) => layerEnabled(def)).length;
      const count = group.querySelector(":scope > summary small");
      if (count) count.textContent = enabled ? `${enabled} on` : `${defs.length} layers`;
    }

    for (const fieldGroup of document.querySelectorAll(".model-field-group")) {
      const [sectionKey, ...fieldParts] = fieldGroup.dataset.fieldGroup.split(":");
      const fieldKey = fieldParts.join(":");
      const defs = visibleDefs.filter((def) => (
        layerSection(def).key === sectionKey && layerFieldKey(def) === fieldKey
      ));
      const enabledKinds = defs.filter((def) => layerEnabled(def)).map(layerKindLabel);
      const state = fieldGroup.querySelector(":scope > summary small");
      if (state) state.textContent = enabledKinds.length ? enabledKinds.join(" + ") : "Off";
    }
    updateActiveLayersSummary();
  }

  function layerKindLabel(def) {
    if (def.kind === "raster") return "Colour";
    if (def.kind === "contours") return "Lines";
    if (def.kind === "vectors") return "Vectors";
    if (def.kind === "satellite") return "Image";
    return def.kind;
  }

  function layerIsVisible(def) {
    const instance = iconModelState.instances.get(def.id);
    return Boolean(instance && iconModelState.map?.hasLayer(instance));
  }

  function activeLayerDescription(def) {
    if (def.id === "satellite_geocolour") {
      return def.source_kind === "native-derived"
        ? "Natural-colour image derived from FCI Level-1c data."
        : "Natural-colour satellite display image.";
    }
    if (def.id === "satellite_ir105") {
      return def.field === "sat_ir105_bt"
        ? "Infrared image with queryable 10.5 µm brightness temperature."
        : "Infrared 10.5 µm satellite display image.";
    }
    const descriptions = {
      t2m: "Air temperature 2 m above ground.",
      dewpoint2m: "Dew point 2 m above ground.",
      pmsl: "Mean sea-level pressure.",
      rh2m: "Relative humidity 2 m above ground.",
      cloud: "Total cloud cover.",
      precip: "Accumulated precipitation from model initialization.",
      wind: "Wind speed and direction near the surface.",
    };
    if (def.field && descriptions[def.field]) return descriptions[def.field];
    const upperAir = {
      temperature: "Air temperature on the selected pressure surface.",
      geopotential_height: "Height of the selected pressure surface.",
      relative_humidity: "Relative humidity on the selected pressure surface.",
      wind: "Wind on the selected pressure surface.",
      theta: "Potential temperature on the selected pressure surface.",
      vorticity: "Relative vorticity on the selected pressure surface.",
      divergence: "Horizontal divergence on the selected pressure surface.",
    };
    if (def.pressure_variable && upperAir[def.pressure_variable]) return upperAir[def.pressure_variable];
    return layerFieldLabel(def);
  }

  function updateActiveLayersSummary() {
    const list = iconEl("iconActiveLayersList");
    const count = iconEl("iconActiveLayersCount");
    if (!list || !count || !iconModelState.meta) return;
    const active = iconModelState.meta.layers.filter(layerIsVisible);
    count.textContent = String(active.length);
    list.replaceChildren();
    if (!active.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No layers enabled.";
      list.append(empty);
      return;
    }
    for (const def of active) {
      const item = document.createElement("div");
      item.className = "icon-active-layer-item";
      const title = document.createElement("strong");
      const fieldName = def.kind === "satellite" ? def.label : layerFieldLabel(def);
      title.textContent = `${fieldName} · ${layerKindLabel(def)}`;
      const description = document.createElement("small");
      description.textContent = activeLayerDescription(def);
      item.append(title, description);
      list.append(item);
    }
  }

  function updatePressureButtons() {
    const container = iconEl("iconPressureLevels");
    if (!container) return;
    for (const button of container.querySelectorAll("button[data-pressure-level]")) {
      const active = Number(button.dataset.pressureLevel) === Number(iconModelState.selectedPressureLevel);
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  function layerSection(def) {
    if (def.group === "Satellite") {
      return { key: "satellite", label: "Satellite observation", order: 0 };
    }
    if (def.pressure_level_hpa == null) {
      return { key: "surface", label: "Surface fields", order: 1 };
    }
    const diagnostic = ["theta", "vorticity", "divergence"].includes(def.pressure_variable);
    return diagnostic
      ? { key: "diagnostics", label: `Diagnostics · ${def.pressure_level_hpa} hPa`, order: 3 }
      : { key: "upper-air", label: `Upper air · ${def.pressure_level_hpa} hPa`, order: 2 };
  }

  function layerFieldKey(def) {
    return def.field || `layer:${def.id}`;
  }

  function layerFieldLabel(def) {
    const field = def.field ? iconModelState.meta.fields[def.field] : null;
    if (field?.label) {
      const prefix = def.pressure_level_hpa != null ? `${def.pressure_level_hpa} hPa ` : "";
      return field.label.startsWith(prefix) ? field.label.slice(prefix.length) : field.label;
    }
    return def.label;
  }

  function buildLayerRow(def) {
    const row = document.createElement("div");
    row.className = "model-layer-row";
    row.dataset.layerId = def.id;

    const top = document.createElement("div");
    top.className = "model-layer-row-top";
    const label = document.createElement("label");
    label.className = "model-layer-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const preference = iconModelState.layerPreferences.get(def.id);
    checkbox.checked = preference?.enabled ?? Boolean(def.default);
    const name = document.createElement("span");
    name.textContent = def.kind === "satellite" ? def.label : layerKindLabel(def);
    label.append(checkbox, name);

    const opacityText = document.createElement("output");
    opacityText.className = "model-layer-opacity-value";
    opacityText.textContent = `${Math.round((def.opacity ?? 1) * 100)}%`;
    top.append(label, opacityText);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "5";
    slider.value = String(Math.round((preference?.opacity ?? def.opacity ?? 1) * 100));
    slider.className = "model-layer-opacity";
    slider.setAttribute("aria-label", `${def.label} opacity`);

    checkbox.addEventListener("change", () => {
      const current = iconModelState.layerPreferences.get(def.id) || {};
      iconModelState.layerPreferences.set(def.id, { ...current, enabled: checkbox.checked });
      updateLayerPanelSummary();
      setLayerEnabled(def, checkbox.checked);
    });
    slider.addEventListener("input", () => {
      opacityText.textContent = `${slider.value}%`;
      const current = iconModelState.layerPreferences.get(def.id) || {};
      iconModelState.layerPreferences.set(def.id, { ...current, opacity: Number(slider.value) / 100 });
      const instance = iconModelState.instances.get(def.id);
      if (instance) applyOpacity(instance, def);
    });

    row.append(top, slider);
    if (def.kind === "satellite" && def.source_label) {
      const source = document.createElement("div");
      source.className = "model-layer-source";
      const sourceBadge = document.createElement("span");
      sourceBadge.className = `model-source-badge ${def.source_kind || ""}`.trim();
      sourceBadge.textContent = def.source_kind === "native-derived" ? "Native Level-1c → Satpy" : "Published image";
      const sourceText = document.createElement("small");
      sourceText.textContent = def.source_label;
      source.append(sourceBadge, sourceText);
      if (def.query_label) {
        const queryBadge = document.createElement("span");
        queryBadge.className = "model-query-badge";
        queryBadge.textContent = `Query: ${def.query_label}`;
        source.append(queryBadge);
      }
      row.append(source);
    }
    if (def.kind === "raster" && def.field) {
      const field = iconModelState.meta.fields[def.field];
      if (field) row.append(colorLegend(field));
    }
    iconModelState.rows.set(def.id, row);
    return row;
  }

  function buildLayerPanel() {
    const container = iconEl("iconLayerList");
    container.replaceChildren();

    const header = document.createElement("div");
    header.className = "model-layer-panel-heading";
    const headingText = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = "Layers";
    const hint = document.createElement("small");
    hint.textContent = "Expand a field for colour, lines or vectors";
    headingText.append(heading, hint);
    const active = document.createElement("span");
    active.id = "iconLayerActiveCount";
    active.className = "model-layer-active-count";
    header.append(headingText, active);
    container.append(header);

    const sections = new Map();
    for (const def of iconModelState.meta.layers) {
      if (def.pressure_level_hpa != null && Number(def.pressure_level_hpa) !== Number(iconModelState.selectedPressureLevel)) continue;
      const info = layerSection(def);
      if (!sections.has(info.key)) sections.set(info.key, { ...info, defs: [] });
      sections.get(info.key).defs.push(def);
    }

    const orderedSections = [...sections.values()].sort((a, b) => a.order - b.order);
    for (const section of orderedSections) {
      const details = document.createElement("details");
      details.className = "model-layer-group";
      details.dataset.layerGroup = section.key;
      const storedOpen = iconModelState.layerGroupOpen.get(section.key);
      details.open = storedOpen ?? (section.key === "satellite");
      details.addEventListener("toggle", () => {
        iconModelState.layerGroupOpen.set(section.key, details.open);
      });

      const summary = document.createElement("summary");
      const title = document.createElement("span");
      title.textContent = section.label;
      const sectionActive = section.defs.filter((def) => layerEnabled(def)).length;
      const count = document.createElement("small");
      count.textContent = sectionActive ? `${sectionActive} on` : `${section.defs.length} layers`;
      summary.append(title, count);
      details.append(summary);

      if (section.key === "satellite") {
        for (const def of section.defs) details.append(buildLayerRow(def));
      } else {
        const fields = new Map();
        for (const def of section.defs) {
          const key = layerFieldKey(def);
          if (!fields.has(key)) fields.set(key, []);
          fields.get(key).push(def);
        }

        for (const [fieldKey, defs] of fields) {
          const fieldDetails = document.createElement("details");
          fieldDetails.className = "model-field-group";
          fieldDetails.dataset.fieldGroup = `${section.key}:${fieldKey}`;
          const storedFieldOpen = iconModelState.layerFieldOpen.get(fieldDetails.dataset.fieldGroup);
          fieldDetails.open = storedFieldOpen ?? false;
          fieldDetails.addEventListener("toggle", () => {
            iconModelState.layerFieldOpen.set(fieldDetails.dataset.fieldGroup, fieldDetails.open);
          });

          const fieldSummary = document.createElement("summary");
          const fieldName = document.createElement("span");
          fieldName.textContent = layerFieldLabel(defs[0]);
          const enabledKinds = defs.filter((def) => layerEnabled(def)).map(layerKindLabel);
          const fieldState = document.createElement("small");
          fieldState.textContent = enabledKinds.length ? enabledKinds.join(" + ") : "Off";
          fieldSummary.append(fieldName, fieldState);
          fieldDetails.append(fieldSummary);

          const options = document.createElement("div");
          options.className = "model-field-options";
          for (const def of defs) options.append(buildLayerRow(def));
          fieldDetails.append(options);
          details.append(fieldDetails);
        }
      }
      container.append(details);
    }
    updateLayerPanelSummary();
  }

  function populatePressureControl() {
    const select = iconEl("iconPressureLevel");
    const buttons = iconEl("iconPressureLevels");
    const levels = iconModelState.meta?.pressure_levels_hpa || [];
    if (select) select.replaceChildren();
    if (buttons) buttons.replaceChildren();
    for (const level of levels) {
      if (select) {
        const option = document.createElement("option");
        option.value = String(level);
        option.textContent = `${level} hPa`;
        select.append(option);
      }
      if (buttons) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.pressureLevel = String(level);
        button.textContent = `${level} hPa`;
        button.setAttribute("aria-pressed", "false");
        button.addEventListener("click", () => switchPressureLevel(level));
        buttons.append(button);
      }
    }
    const fallback = iconModelState.meta?.default_pressure_level_hpa ?? levels[0] ?? null;
    if (iconModelState.selectedPressureLevel == null || !levels.includes(Number(iconModelState.selectedPressureLevel))) {
      iconModelState.selectedPressureLevel = fallback;
    }
    if (select && iconModelState.selectedPressureLevel != null) select.value = String(iconModelState.selectedPressureLevel);
    updatePressureButtons();
  }

  async function switchPressureLevel(level) {
    const next = Number(level);
    if (!Number.isFinite(next) || next === Number(iconModelState.selectedPressureLevel)) return;
    captureLayerPreferences();
    for (const [id, instance] of [...iconModelState.instances.entries()]) {
      const def = iconModelState.meta.layers.find((item) => item.id === id);
      if (def?.pressure_level_hpa != null && iconModelState.map.hasLayer(instance)) {
        iconModelState.map.removeLayer(instance);
        iconModelState.instances.delete(id);
      }
    }
    iconModelState.selectedPressureLevel = next;
    const select = iconEl("iconPressureLevel");
    if (select) select.value = String(next);
    updatePressureButtons();
    iconModelState.rows.clear();
    const layerPanel = document.querySelector(".icon-layer-panel");
    const layerScrollTop = layerPanel?.scrollTop ?? 0;
    buildLayerPanel();
    if (layerPanel) layerPanel.scrollTop = layerScrollTop;
    for (const def of iconModelState.meta.layers) {
      if (Number(def.pressure_level_hpa) !== next) continue;
      const row = iconModelState.rows.get(def.id);
      if (row?.querySelector('input[type="checkbox"]')?.checked) await setLayerEnabled(def, true);
    }
    updateActiveLayersSummary();
    setMapStatus(`Pressure level ${next} hPa ready`, "ok");
  }

  function captureLayerPreferences() {
    for (const def of iconModelState.meta?.layers || []) {
      const row = iconModelState.rows.get(def.id);
      if (!row) continue;
      const checkbox = row.querySelector('input[type="checkbox"]');
      const slider = row.querySelector('input[type="range"]');
      iconModelState.layerPreferences.set(def.id, {
        enabled: Boolean(checkbox?.checked),
        opacity: slider ? Number(slider.value) / 100 : Number(def.opacity ?? 1),
      });
    }
  }

  function updateAnimationControls() {
    const timeline = iconModelState.timeline;
    const play = iconEl("iconAnimPlay");
    const range = iconEl("iconAnimRange");
    const label = iconEl("iconAnimTime");
    if (!timeline?.steps?.length) {
      if (play) play.disabled = true;
      if (range) range.disabled = true;
      if (label) label.textContent = "—";
      return;
    }
    const step = timeline.steps[iconModelState.currentStepIndex];
    if (play) {
      play.disabled = timeline.steps.length < 2;
      play.textContent = iconModelState.animationPlaying ? "❚❚ Pause" : "▶ Play";
      play.setAttribute("aria-label", iconModelState.animationPlaying ? "Pause forecast animation" : "Play forecast animation");
    }
    if (range) {
      range.disabled = timeline.steps.length < 2;
      range.max = String(Math.max(0, timeline.steps.length - 1));
      range.value = String(iconModelState.currentStepIndex);
    }
    if (label) label.textContent = `+${step.forecast_hour} h · ${compactModelTime(step.valid_at)}`;
  }

  function stopAnimation() {
    iconModelState.animationPlaying = false;
    iconModelState.animationSerial += 1;
    if (iconModelState.animationTimer !== null) {
      clearTimeout(iconModelState.animationTimer);
      iconModelState.animationTimer = null;
    }
    updateAnimationControls();
  }

  function animationDelay() {
    const value = Number(iconEl("iconAnimSpeed")?.value);
    return Number.isFinite(value) && value >= 250 ? value : 1000;
  }

  async function prefetchForecastStep(index) {
    const timeline = iconModelState.timeline;
    const step = timeline?.steps?.[index];
    if (!step || iconModelState.prefetchedSteps.has(step.valid_at)) return;
    try {
      const meta = await fetchModelJson(step.meta_file);
      const enabledIds = new Set(
        [...iconModelState.layerPreferences.entries()]
          .filter(([, preference]) => preference?.enabled)
          .map(([id]) => id),
      );
      const selectedPressure = Number(iconModelState.selectedPressureLevel);
      const assets = meta.layers.filter((def) => {
        if (!enabledIds.has(def.id)) return false;
        return def.pressure_level_hpa == null || Number(def.pressure_level_hpa) === selectedPressure;
      });
      await Promise.allSettled(assets.map((def) => {
        const url = versioned(def.file);
        if (def.kind === "raster" || def.kind === "satellite") {
          return new Promise((resolve) => {
            const image = new Image();
            image.onload = image.onerror = resolve;
            image.src = url;
          });
        }
        return fetch(url, { cache: "force-cache" });
      }));
      iconModelState.prefetchedSteps.add(step.valid_at);
    } catch (error) {
      console.debug("icon_animation_prefetch_failed", error);
    }
  }

  async function animationTick(serial) {
    if (!iconModelState.animationPlaying || serial !== iconModelState.animationSerial) return;
    const steps = iconModelState.timeline?.steps || [];
    if (steps.length < 2) {
      stopAnimation();
      return;
    }
    let next = iconModelState.currentStepIndex + 1;
    if (next >= steps.length) {
      if (!iconEl("iconAnimLoop")?.checked) {
        stopAnimation();
        return;
      }
      next = 0;
    }
    void prefetchForecastStep(next);
    await switchForecastTime(next, { fromAnimation: true });
    if (!iconModelState.animationPlaying || serial !== iconModelState.animationSerial) return;
    const following = (next + 1) % steps.length;
    void prefetchForecastStep(following);
    iconModelState.animationTimer = setTimeout(() => animationTick(serial), animationDelay());
  }

  function startAnimation() {
    const steps = iconModelState.timeline?.steps || [];
    if (steps.length < 2 || iconModelState.animationPlaying) return;
    iconModelState.animationPlaying = true;
    iconModelState.animationSerial += 1;
    const serial = iconModelState.animationSerial;
    updateAnimationControls();
    void prefetchForecastStep((iconModelState.currentStepIndex + 1) % steps.length);
    iconModelState.animationTimer = setTimeout(() => animationTick(serial), 150);
  }

  function toggleAnimation() {
    if (iconModelState.animationPlaying) stopAnimation();
    else startAnimation();
  }

  function populateForecastTimeControl() {
    const select = iconEl("iconForecastTime");
    const timeline = iconModelState.timeline;
    if (!select || !timeline?.steps?.length) return;
    select.replaceChildren();
    timeline.steps.forEach((step, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `+${step.forecast_hour} h · ${compactModelTime(step.valid_at)}`;
      select.append(option);
    });
    select.value = String(iconModelState.currentStepIndex);
    updateAnimationControls();
  }

  async function switchForecastTime(index, options = {}) {
    const timeline = iconModelState.timeline;
    if (!options.fromAnimation) stopAnimation();
    if (!timeline?.steps?.[index]) return;
    if (index === iconModelState.currentStepIndex) {
      updateAnimationControls();
      return;
    }
    const serial = ++iconModelState.switchSerial;
    const select = iconEl("iconForecastTime");
    if (select) select.disabled = true;
    setMapStatus("Switching forecast time…");
    captureLayerPreferences();
    try {
      const nextMeta = await fetchModelJson(timeline.steps[index].meta_file);
      if (serial !== iconModelState.switchSerial) return;
      for (const instance of iconModelState.instances.values()) {
        if (iconModelState.map.hasLayer(instance)) iconModelState.map.removeLayer(instance);
      }
      iconModelState.instances.clear();
      iconModelState.grids.clear();
      iconModelState.rows.clear();
      iconModelState.meta = nextMeta;
      iconModelState.currentStepIndex = index;
      if (select) select.value = String(index);
      updateModelMetaCards();
      updateAnimationControls();
      populatePressureControl();
      const layerPanel = document.querySelector(".icon-layer-panel");
      const layerScrollTop = layerPanel?.scrollTop ?? 0;
      const pageScrollX = window.scrollX;
      const pageScrollY = window.scrollY;
      buildLayerPanel();
      if (layerPanel) layerPanel.scrollTop = layerScrollTop;
      if (window.scrollX !== pageScrollX || window.scrollY !== pageScrollY) {
        window.scrollTo({ left: pageScrollX, top: pageScrollY, behavior: "instant" });
      }
      const enabledLayers = nextMeta.layers.filter((def) => {
        const row = iconModelState.rows.get(def.id);
        return Boolean(row?.querySelector('input[type="checkbox"]')?.checked);
      });
      await Promise.all(enabledLayers.map((def) => setLayerEnabled(def, true)));
      updateActiveLayersSummary();
      setMapStatus("Interactive fields ready", "ok");
    } catch (error) {
      console.error("icon_time_switch_failed", error);
      setMapStatus("Could not switch forecast time", "warning");
      if (select) select.value = String(iconModelState.currentStepIndex);
    } finally {
      if (select) select.disabled = false;
      updateAnimationControls();
    }
  }

  async function loadGrid(fieldId) {
    if (iconModelState.grids.has(fieldId)) return iconModelState.grids.get(fieldId);
    const field = iconModelState.meta.fields[fieldId];
    if (!field) throw new Error(`Unknown field ${fieldId}`);
    const response = await fetch(versioned(field.grid_file), { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${field.grid_file}`);
    let buffer;
    if (field.grid_file.endsWith(".gz")) {
      if (!("DecompressionStream" in window) || !response.body) {
        throw new Error("This browser cannot decompress the numerical query grid");
      }
      const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
      buffer = await new Response(stream).arrayBuffer();
    } else {
      buffer = await response.arrayBuffer();
    }
    const data = new Float32Array(buffer);
    const expected = field.shape[0] * field.shape[1];
    if (data.length !== expected) {
      throw new Error(`Grid size mismatch for ${fieldId}: ${data.length} != ${expected}`);
    }
    const grid = { field, data };
    iconModelState.grids.set(fieldId, grid);
    return grid;
  }

  function gridValue(grid, lat, lon, sampling) {
    const { field, data } = grid;
    const height = field.shape[0];
    const width = field.shape[1];
    const fy = (lat - field.lat_start) / field.lat_step;
    const fx = (lon - field.lon_start) / field.lon_step;
    if (fx < 0 || fy < 0 || fx > width - 1 || fy > height - 1) return NaN;

    const at = (y, x) => data[y * width + x];
    if (sampling === "nearest") {
      return at(Math.round(fy), Math.round(fx));
    }

    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const q00 = at(y0, x0);
    const q10 = at(y0, x1);
    const q01 = at(y1, x0);
    const q11 = at(y1, x1);
    if (![q00, q10, q01, q11].every(Number.isFinite)) {
      return at(Math.round(fy), Math.round(fx));
    }
    return (
      q00 * (1 - tx) * (1 - ty) +
      q10 * tx * (1 - ty) +
      q01 * (1 - tx) * ty +
      q11 * tx * ty
    );
  }

  function activeFieldIds() {
    const ids = new Set();
    for (const def of iconModelState.meta.layers) {
      if (!def.field) continue;
      const row = iconModelState.rows.get(def.id);
      const checked = row?.querySelector('input[type="checkbox"]')?.checked;
      if (checked) ids.add(def.field);
    }
    const surface = FIELD_ORDER.filter((fieldId) => ids.has(fieldId));
    const extras = [...ids].filter((fieldId) => {
      const field = iconModelState.meta.fields[fieldId];
      return field && field.pressure_level_hpa == null && !FIELD_ORDER.includes(fieldId);
    }).sort((a, b) => {
      const al = iconModelState.meta.fields[a]?.label || a;
      const bl = iconModelState.meta.fields[b]?.label || b;
      return al.localeCompare(bl);
    });
    const pressure = [...ids].filter((fieldId) => {
      const field = iconModelState.meta.fields[fieldId];
      return field?.pressure_level_hpa != null;
    }).sort((a, b) => {
      const av = iconModelState.meta.fields[a]?.pressure_variable || "";
      const bv = iconModelState.meta.fields[b]?.pressure_variable || "";
      return av.localeCompare(bv);
    });
    return [...surface, ...extras, ...pressure];
  }

  function formatPointCoordinate(latlng) {
    const lat = `${Math.abs(latlng.lat).toFixed(4)}°${latlng.lat < 0 ? "S" : "N"}`;
    const lon = `${Math.abs(latlng.lng).toFixed(4)}°${latlng.lng < 0 ? "W" : "E"}`;
    return `${lat} · ${lon}`;
  }

  function popupShell(latlng, body) {
    return `
      <div class="model-query-popup">
        <strong>${formatPointCoordinate(latlng)}</strong>
        ${body}
      </div>`;
  }

  async function queryMapPoint(event) {
    const latlng = event.latlng;
    const popup = L.popup({ maxWidth: 330 })
      .setLatLng(latlng)
      .setContent(popupShell(latlng, '<p class="muted">Reading active numerical fields…</p>'))
      .openOn(iconModelState.map);

    const fields = activeFieldIds();
    if (!fields.length) {
      popup.setContent(popupShell(
        latlng,
        '<p class="muted">Enable at least one ICON-EU numerical layer to query values.</p>',
      ));
      return;
    }

    const sampling = iconEl("iconSampling").value;
    try {
      const grids = await Promise.all(fields.map(loadGrid));
      const rows = [];
      for (let index = 0; index < fields.length; index += 1) {
        const fieldId = fields[index];
        const field = iconModelState.meta.fields[fieldId];
        const value = gridValue(grids[index], latlng.lat, latlng.lng, sampling);
        if (!Number.isFinite(value)) continue;
        rows.push(
          `<tr><th>${field.label}</th><td>${value.toFixed(field.decimals)} ${field.unit}</td></tr>`,
        );
      }
      const table = rows.length
        ? `<table>${rows.join("")}</table>`
        : '<p class="muted">Point is outside the ICON-EU grid.</p>';
      const note = fields.includes("precip")
        ? '<p class="model-query-note">Precipitation is accumulated from model initialization.</p>'
        : "";
      popup.setContent(popupShell(
        latlng,
        `${table}
         <p class="model-query-note">Sampling: ${sampling} · native grid ${iconModelState.meta.native_grid.spacing_degrees}°</p>
         ${note}
         <p class="model-query-note">Valid ${modelTime(iconModelState.meta.valid_at)}</p>`,
      ));
    } catch (error) {
      console.error("icon_query_failed", error);
      popup.setContent(popupShell(
        latlng,
        '<p class="muted">Could not load the numerical query grid.</p>',
      ));
    }
  }
  async function probeCubeStorage() {
    if (!window.ReadSensorCube?.connect) return;
    const state = await window.ReadSensorCube.connect();
    iconModelState.cubeState = state;
    if (state.available) {
      console.info("model_cube_ready", { run_at: state.latest?.run_at, shape: state.latest?.shape });
    } else {
      console.info("model_cube_unavailable", state.reason);
    }
  }

  async function initializeModelMap() {
    if (iconModelState.map) {
      iconModelState.map.invalidateSize({ pan: false, animate: false });
      return;
    }
    if (iconModelState.initializing) return iconModelState.initializing;

    iconModelState.initializing = (async () => {
      try {
        setMapStatus("Loading ICON-EU layer catalogue…");
        const response = await fetch(`model/latest.json?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const rootMeta = await response.json();
        if (!rootMeta.interactive) throw new Error("Interactive metadata missing");
        iconModelState.assetVersion = rootMeta.generated_at || rootMeta.interactive.valid_at || String(Date.now());
        iconModelState.meta = rootMeta.interactive;
        iconModelState.timeline = rootMeta.interactive.timeline || null;
        iconModelState.currentStepIndex = Number(iconModelState.timeline?.current_index ?? 0);
        updateModelMetaCards();
        populateForecastTimeControl();
        populatePressureControl();
        const forecastSelect = iconEl("iconForecastTime");
        forecastSelect?.addEventListener("change", () => switchForecastTime(Number(forecastSelect.value)));
        iconEl("iconAnimPlay")?.addEventListener("click", toggleAnimation);
        iconEl("iconAnimRange")?.addEventListener("change", (event) => switchForecastTime(Number(event.target.value)));
        iconEl("iconAnimSpeed")?.addEventListener("change", () => {
          if (!iconModelState.animationPlaying) return;
          const serial = iconModelState.animationSerial;
          if (iconModelState.animationTimer !== null) clearTimeout(iconModelState.animationTimer);
          iconModelState.animationTimer = setTimeout(() => animationTick(serial), animationDelay());
        });
        const pressureSelect = iconEl("iconPressureLevel");
        pressureSelect?.addEventListener("change", () => switchPressureLevel(pressureSelect.value));

        buildLayerPanel();
        const map = makeMap();
        const defaults = rootMeta.interactive.layers.filter((def) => def.default);
        await Promise.all(defaults.map((def) => setLayerEnabled(def, true)));
        updateActiveLayersSummary();

        iconEl("iconMapReset").addEventListener("click", () => {
          map.fitBounds(iconModelState.meta.bounds, { padding: [8, 8] });
        });
        setMapStatus("Interactive fields ready", "ok");
        if (iconModelState.timeline?.steps?.length > 1) {
          void prefetchForecastStep((iconModelState.currentStepIndex + 1) % iconModelState.timeline.steps.length);
        }
        void probeCubeStorage();
      } catch (error) {
        console.error("icon_map_init_failed", error);
        setMapStatus("Interactive map unavailable", "error");
        const mapNode = iconEl("iconInteractiveMap");
        if (mapNode) mapNode.textContent = "Interactive ICON-EU products could not be loaded.";
      } finally {
        iconModelState.initializing = null;
      }
    })();

    return iconModelState.initializing;
  }
  function setupModelMap() {
    const modelButton = document.querySelector('nav button[data-tab="models"]');
    if (!modelButton || !iconEl("iconInteractiveMap")) return;
    modelButton.addEventListener("click", () => {
      requestAnimationFrame(() => requestAnimationFrame(initializeModelMap));
    });
    if (document.querySelector("#models.tab.active")) initializeModelMap();
  }

  setupModelMap();
})();
