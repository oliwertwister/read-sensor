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
    selectedPressureLevels: null,
    layerPreferences: new Map(),
    layerGroupOpen: new Map(),
    layerFieldOpen: new Map(),
    switchSerial: 0,
    animationPlaying: false,
    animationTimer: null,
    animationSerial: 0,
    prefetchedSteps: new Set(),
    cubeState: null,
    archiveRuns: [],
    archiveMode: false,
    archiveRun: null,
    archiveTimeIndex: 0,
    archiveGrid: null,
    archiveSerial: 0,
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
    if (enabled && !layerAvailable(def)) {
      if (checkbox) checkbox.checked = false;
      setMapStatus("Night · no daylight coverage", "warning");
      updateLayerPanelSummary();
      return;
    }
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
      if (checkbox) checkbox.disabled = !layerAvailable(def);
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

  function layerAvailable(def) {
    if (!def.daylight_only || def.daylight_coverage_fraction == null) return true;
    const coverage = Number(def.daylight_coverage_fraction);
    return !Number.isFinite(coverage) || coverage > 0.001;
  }

  function layerEnabled(def) {
    if (!layerAvailable(def)) return false;
    const preference = iconModelState.layerPreferences.get(def.id);
    return preference?.enabled ?? Boolean(def.default);
  }

  function updateLayerPanelSummary() {
    const badge = iconEl("iconLayerActiveCount");
    if (!badge || !iconModelState.meta) return;
    const visibleDefs = iconModelState.meta.layers.filter((def) => (
      def.pressure_level_hpa == null
      || iconModelState.selectedPressureLevels?.has(Number(def.pressure_level_hpa))
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
    if (def.kind === "satellite" && def.definition) return def.definition;
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
    if (iconModelState.archiveMode) {
      count.textContent = iconModelState.archiveGrid ? "1" : "0";
      list.replaceChildren();
      const item = document.createElement("div");
      item.className = "icon-active-layer-item";
      const title = document.createElement("strong");
      title.textContent = "2 m temperature · R2 archive query";
      const description = document.createElement("small");
      const validAt = iconModelState.archiveRun?.valid_times?.[iconModelState.archiveTimeIndex];
      description.textContent = validAt
        ? `Numerical Zarr field · valid ${compactModelTime(validAt)}`
        : "Loading archived numerical field…";
      item.append(title, description);
      list.append(item);
      return;
    }
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
      const active = Boolean(iconModelState.selectedPressureLevels?.has(Number(button.dataset.pressureLevel)));
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  function layerSection(def) {
    if (def.group === "Satellite") {
      return { key: "satellite", label: "Satellite observation", order: 0 };
    }
    if (def.diagnostic_group === "cross-level") {
      return { key: "cross-level", label: "Cross-level diagnostics", order: 3 };
    }
    if (def.pressure_level_hpa == null) {
      return { key: "surface", label: "Surface fields", order: 1 };
    }
    const level = Number(def.pressure_level_hpa);
    return { key: `pressure-${level}`, label: `${level} hPa upper air`, order: 2, level };
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

  function layerRepresentationInfo(def) {
    if (def.kind === "raster") {
      return "Colour raster rendered from the numerical grid with Matplotlib; Leaflet displays the 2× bilinear image, while map queries read the underlying Float32 grid.";
    }
    if (def.kind === "contours") {
      return "Isolines extracted from the same numerical grid with Matplotlib ax.contour() and stored as GeoJSON.";
    }
    if (def.kind === "vectors") {
      return "Wind U/V components are spatially sampled and converted to speed/direction in Python, then drawn as vectors in Leaflet.";
    }
    if (def.kind === "satellite") {
      return def.field
        ? "WebP image overlay for display; map queries use a separate calibrated Float32 brightness-temperature grid."
        : "WebP image overlay for display; this layer itself is not a numerical grid.";
    }
    return "Displayed directly from the generated layer product.";
  }

  function layerOriginLabel(def, field) {
    const method = String(def.method || field?.method || "");
    if (def.source_kind === "native-derived") return "Native FCI";
    if (def.source_kind === "rendered-image") return "WMS image";
    if (/MetPy/i.test(method)) return "Calculated · MetPy";
    if (/NumPy hypot/i.test(method)) return "Calculated · NumPy";
    if (/Derived/i.test(method)) return "Derived";
    if (/Direct DWD/i.test(method)) return "Direct DWD";
    return "Processed";
  }

  function layerInformation(def) {
    const field = def.field ? iconModelState.meta.fields[def.field] : null;
    return {
      definition: def.definition || field?.definition || activeLayerDescription(def),
      method: def.method || field?.method || def.source_label || "Generated from the current layer source.",
      representation: layerRepresentationInfo(def),
      origin: layerOriginLabel(def, field),
    };
  }

  function closeOtherLayerInfoPanels(exceptPanel = null) {
    for (const panel of document.querySelectorAll(".model-layer-info-panel:not([hidden])")) {
      if (panel === exceptPanel) continue;
      panel.hidden = true;
      const button = document.querySelector(`[aria-controls="${panel.id}"]`);
      if (button) button.setAttribute("aria-expanded", "false");
    }
  }

  function buildLayerInfoPanel(def, button) {
    const info = layerInformation(def);
    const panel = document.createElement("div");
    panel.className = "model-layer-info-panel";
    panel.id = `layer-info-${def.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    panel.hidden = true;

    const origin = document.createElement("span");
    origin.className = "model-layer-info-origin";
    origin.textContent = info.origin;
    panel.append(origin);

    for (const [labelText, value] of [
      ["Definition", info.definition],
      ["Source / method", info.method],
      ["Display", info.representation],
    ]) {
      const line = document.createElement("div");
      line.className = "model-layer-info-line";
      const label = document.createElement("strong");
      label.textContent = labelText;
      const text = document.createElement("span");
      text.textContent = value;
      line.append(label, text);
      panel.append(line);
    }

    button.setAttribute("aria-controls", panel.id);
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => {
      const opening = panel.hidden;
      closeOtherLayerInfoPanels(opening ? panel : null);
      panel.hidden = !opening;
      button.setAttribute("aria-expanded", opening ? "true" : "false");
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || panel.hidden) return;
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
      event.stopPropagation();
    });
    return panel;
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
    const available = layerAvailable(def);
    checkbox.checked = available && (preference?.enabled ?? Boolean(def.default));
    checkbox.disabled = !available;
    row.classList.toggle("is-unavailable", !available);
    const name = document.createElement("span");
    name.textContent = def.kind === "satellite" ? def.label : layerKindLabel(def);
    label.append(checkbox, name);

    const infoButton = document.createElement("button");
    infoButton.type = "button";
    infoButton.className = "model-layer-info-button";
    infoButton.textContent = "i";
    infoButton.title = "Layer information";
    infoButton.setAttribute("aria-label", `Layer information: ${def.label}`);

    const opacityText = document.createElement("output");
    opacityText.className = "model-layer-opacity-value";
    opacityText.textContent = `${Math.round((def.opacity ?? 1) * 100)}%`;

    const rowActions = document.createElement("div");
    rowActions.className = "model-layer-row-actions";
    rowActions.append(infoButton, opacityText);
    top.append(label, rowActions);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "5";
    slider.value = String(Math.round((preference?.opacity ?? def.opacity ?? 1) * 100));
    slider.className = "model-layer-opacity";
    slider.disabled = !available;
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
      if (!available && def.daylight_only) {
        const availabilityBadge = document.createElement("span");
        availabilityBadge.className = "model-availability-badge";
        availabilityBadge.textContent = "Night · no daylight coverage";
        source.append(availabilityBadge);
      }
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
    row.append(buildLayerInfoPanel(def, infoButton));
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
    const headerActions = document.createElement("div");
    headerActions.className = "model-layer-panel-actions";
    const active = document.createElement("span");
    active.id = "iconLayerActiveCount";
    active.className = "model-layer-active-count";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "model-layer-clear";
    clear.textContent = "Uncheck all";
    clear.addEventListener("click", disableAllLayers);
    headerActions.append(active, clear);
    header.append(headingText, headerActions);
    container.append(header);

    const sections = new Map();
    for (const def of iconModelState.meta.layers) {
      if (def.pressure_level_hpa != null && !iconModelState.selectedPressureLevels?.has(Number(def.pressure_level_hpa))) continue;
      const info = layerSection(def);
      if (!sections.has(info.key)) sections.set(info.key, { ...info, defs: [] });
      sections.get(info.key).defs.push(def);
    }

    const orderedSections = [...sections.values()].sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      if (a.level != null || b.level != null) return Number(b.level || 0) - Number(a.level || 0);
      return a.label.localeCompare(b.label);
    });
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
    const levels = (iconModelState.meta?.pressure_levels_hpa || []).map(Number);
    if (!(iconModelState.selectedPressureLevels instanceof Set)) {
      iconModelState.selectedPressureLevels = new Set(levels);
    } else {
      for (const level of [...iconModelState.selectedPressureLevels]) {
        if (!levels.includes(Number(level))) iconModelState.selectedPressureLevels.delete(level);
      }
    }
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
        button.addEventListener("click", () => togglePressureLevel(level));
        buttons.append(button);
      }
    }
    updatePressureButtons();
  }

  async function togglePressureLevel(level) {
    const next = Number(level);
    const levels = (iconModelState.meta?.pressure_levels_hpa || []).map(Number);
    if (!Number.isFinite(next) || !levels.includes(next)) return;
    if (!(iconModelState.selectedPressureLevels instanceof Set)) {
      iconModelState.selectedPressureLevels = new Set(levels);
    }
    captureLayerPreferences();
    const turningOff = iconModelState.selectedPressureLevels.has(next);
    if (turningOff) {
      iconModelState.selectedPressureLevels.delete(next);
      for (const [id, instance] of iconModelState.instances.entries()) {
        const def = iconModelState.meta.layers.find((item) => item.id === id);
        if (Number(def?.pressure_level_hpa) === next && iconModelState.map.hasLayer(instance)) {
          iconModelState.map.removeLayer(instance);
        }
      }
    } else {
      iconModelState.selectedPressureLevels.add(next);
    }
    updatePressureButtons();
    iconModelState.rows.clear();
    const layerPanel = document.querySelector(".icon-layer-panel");
    const layerScrollTop = layerPanel?.scrollTop ?? 0;
    buildLayerPanel();
    if (layerPanel) layerPanel.scrollTop = layerScrollTop;
    if (!turningOff) {
      for (const def of iconModelState.meta.layers) {
        if (Number(def.pressure_level_hpa) !== next) continue;
        const row = iconModelState.rows.get(def.id);
        if (row?.querySelector('input[type="checkbox"]')?.checked) await setLayerEnabled(def, true);
      }
    }
    updateActiveLayersSummary();
    const selected = [...iconModelState.selectedPressureLevels].sort((a, b) => b - a);
    setMapStatus(
      selected.length ? `Upper-air levels shown: ${selected.join(", ")} hPa` : "Surface fields only",
      "ok",
    );
  }

  function captureLayerPreferences() {
    for (const def of iconModelState.meta?.layers || []) {
      const row = iconModelState.rows.get(def.id);
      if (!row) continue;
      const checkbox = row.querySelector('input[type="checkbox"]');
      const slider = row.querySelector('input[type="range"]');
      const previous = iconModelState.layerPreferences.get(def.id) || {};
      iconModelState.layerPreferences.set(def.id, {
        enabled: layerAvailable(def) ? Boolean(checkbox?.checked) : (previous.enabled ?? Boolean(def.default)),
        opacity: slider ? Number(slider.value) / 100 : Number(def.opacity ?? 1),
      });
    }
  }

  function disableAllLayers() {
    for (const def of iconModelState.meta?.layers || []) {
      const current = iconModelState.layerPreferences.get(def.id) || {};
      iconModelState.layerPreferences.set(def.id, {
        ...current,
        enabled: false,
        opacity: current.opacity ?? Number(def.opacity ?? 1),
      });
      const row = iconModelState.rows.get(def.id);
      const checkbox = row?.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = false;
      const instance = iconModelState.instances.get(def.id);
      if (instance && iconModelState.map?.hasLayer(instance)) {
        iconModelState.map.removeLayer(instance);
      }
    }
    updateLayerPanelSummary();
    updateActiveLayersSummary();
    setMapStatus("All layers unchecked", "ok");
  }

  function setRenderedLayersVisible(visible) {
    for (const def of iconModelState.meta?.layers || []) {
      const instance = iconModelState.instances.get(def.id);
      if (!instance || !iconModelState.map) continue;
      if (!visible && iconModelState.map.hasLayer(instance)) {
        iconModelState.map.removeLayer(instance);
      } else if (visible && layerEnabled(def) && !iconModelState.map.hasLayer(instance)) {
        instance.addTo(iconModelState.map);
        applyOpacity(instance, def);
      }
    }
  }

  function setArchiveUi(active) {
    const notice = iconEl("iconArchiveNotice");
    if (notice) notice.hidden = !active;
    document.querySelector(".icon-layer-panel")?.classList.toggle("is-archive-mode", active);
    const pressure = document.querySelector(".icon-pressure-strip");
    if (pressure) pressure.classList.toggle("is-archive-mode", active);
  }

  function gridAxisStep(axis) {
    return axis.count > 1 ? (axis.last - axis.first) / (axis.count - 1) : 0;
  }

  function normalizeArchiveGrid(grid) {
    const latStep = gridAxisStep(grid.latitude);
    const lonStep = gridAxisStep(grid.longitude);
    return {
      latitude: grid.latitude,
      longitude: grid.longitude,
      lat_start: grid.latitude.first,
      lat_step: latStep,
      lon_start: grid.longitude.first,
      lon_step: lonStep,
      shape: [grid.latitude.count, grid.longitude.count],
      bounds: [
        [
          Math.min(grid.latitude.first, grid.latitude.last) - Math.abs(latStep) / 2,
          Math.min(grid.longitude.first, grid.longitude.last) - Math.abs(lonStep) / 2,
        ],
        [
          Math.max(grid.latitude.first, grid.latitude.last) + Math.abs(latStep) / 2,
          Math.max(grid.longitude.first, grid.longitude.last) + Math.abs(lonStep) / 2,
        ],
      ],
    };
  }

  function updateAnimationControls() {
    const timeline = iconModelState.timeline;
    const play = iconEl("iconAnimPlay");
    const range = iconEl("iconAnimRange");
    const label = iconEl("iconAnimTime");
    if (iconModelState.archiveMode) {
      if (play) {
        play.disabled = true;
        play.textContent = "▶ Play";
      }
      if (range) {
        range.disabled = true;
        range.value = String(iconModelState.archiveTimeIndex);
      }
      const valid = iconModelState.archiveRun?.valid_times?.[iconModelState.archiveTimeIndex];
      const lead = iconModelState.archiveRun?.forecast_hours?.[iconModelState.archiveTimeIndex];
      if (label) label.textContent = valid ? `+${lead ?? "—"} h · ${compactModelTime(valid)}` : "—";
      return;
    }
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
      const selectedPressures = iconModelState.selectedPressureLevels instanceof Set
        ? iconModelState.selectedPressureLevels
        : new Set();
      const assets = meta.layers.filter((def) => {
        if (!enabledIds.has(def.id)) return false;
        return def.pressure_level_hpa == null || selectedPressures.has(Number(def.pressure_level_hpa));
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

  function setSelectOptions(select, options, selected) {
    if (!select) return;
    select.replaceChildren(...options.map(({ value, label }) => {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = label;
      return option;
    }));
    select.value = String(selected);
  }

  function populateForecastTimeControl() {
    const select = iconEl("iconForecastTime");
    const steps = iconModelState.timeline?.steps || [];
    if (!steps.length) return;
    setSelectOptions(
      select,
      steps.map((step, index) => ({
        value: index,
        label: `+${step.forecast_hour} h · ${compactModelTime(step.valid_at)}`,
      })),
      iconModelState.currentStepIndex,
    );
    updateAnimationControls();
  }

  function populateModelRunControl() {
    const select = iconEl("iconModelRun");
    if (!select || !iconModelState.meta) return;
    const currentRunAt = iconModelState.meta.run_at;
    const options = [
      { value: "pages-current", label: `Current rendered · ${compactModelTime(currentRunAt)}` },
      ...iconModelState.archiveRuns
        .filter((run) => run?.id && run.run_at !== currentRunAt)
        .map((run) => ({ value: run.id, label: compactModelTime(run.run_at) })),
    ];
    const selected = iconModelState.archiveMode
      ? iconModelState.archiveRun?.id || "pages-current"
      : "pages-current";
    setSelectOptions(select, options, selected);
  }

  function populateArchiveTimeControl(run) {
    const select = iconEl("iconForecastTime");
    const validTimes = run?.valid_times || [];
    const leads = run?.forecast_hours || [];
    setSelectOptions(
      select,
      validTimes.map((validAt, index) => ({
        value: index,
        label: `+${leads[index] ?? "—"} h · ${compactModelTime(validAt)}`,
      })),
      iconModelState.archiveTimeIndex,
    );
    if (select) select.disabled = !validTimes.length;
    updateAnimationControls();
  }

  function updateArchiveMetaCards(run, grid) {
    if (iconEl("iconMapRun")) iconEl("iconMapRun").textContent = modelTime(run?.run_at);
    if (iconEl("iconMapSatellite")) iconEl("iconMapSatellite").textContent = "— · not archived";
    if (iconEl("iconMapGrid") && grid) {
      const step = Math.abs(gridAxisStep(grid.longitude));
      iconEl("iconMapGrid").textContent = step ? `${step.toFixed(4)}°` : "—";
    }
  }

  async function prepareArchiveTime(timeIndex) {
    const run = iconModelState.archiveRun;
    if (!run || !window.ReadSensorCube?.readGrid) return;
    const validAt = run.valid_times?.[timeIndex];
    const lead = run.forecast_hours?.[timeIndex];
    if (!validAt) return;
    const serial = ++iconModelState.archiveSerial;
    const timeSelect = iconEl("iconForecastTime");
    const runSelect = iconEl("iconModelRun");
    if (timeSelect) timeSelect.disabled = true;
    if (runSelect) runSelect.disabled = true;
    setMapStatus(`Opening archived +${lead ?? "—"} h query mode…`);
    try {
      const grid = await window.ReadSensorCube.readGrid(run.cube_url);
      if (serial !== iconModelState.archiveSerial || !iconModelState.archiveMode) return;
      iconModelState.archiveGrid = normalizeArchiveGrid(grid);
      iconModelState.archiveTimeIndex = timeIndex;
      if (timeSelect) timeSelect.value = String(timeIndex);
      updateArchiveMetaCards(run, grid);
      updateAnimationControls();
      updateActiveLayersSummary();
      setMapStatus(`R2 archive query · 2 m temperature · +${lead ?? "—"} h · ${compactModelTime(validAt)}`, "ok");
    } catch (error) {
      console.error("icon_archive_prepare_failed", error);
      setMapStatus("Could not open archived model run", "warning");
    } finally {
      if (timeSelect) timeSelect.disabled = false;
      if (runSelect) runSelect.disabled = false;
    }
  }

  async function enterArchiveRun(runId) {
    const run = iconModelState.archiveRuns.find((item) => item.id === runId);
    if (!run) return;
    stopAnimation();
    captureLayerPreferences();
    setRenderedLayersVisible(false);
    iconModelState.archiveGrid = null;
    iconModelState.archiveMode = true;
    iconModelState.archiveRun = run;
    iconModelState.archiveTimeIndex = Math.min(1, (run.valid_times?.length || 1) - 1);
    setArchiveUi(true);
    populateModelRunControl();
    populateArchiveTimeControl(run);
    updateActiveLayersSummary();
    await prepareArchiveTime(iconModelState.archiveTimeIndex);
  }

  function exitArchiveMode() {
    if (!iconModelState.archiveMode) return;
    iconModelState.archiveSerial += 1;
    iconModelState.archiveGrid = null;
    iconModelState.archiveMode = false;
    iconModelState.archiveRun = null;
    iconModelState.archiveTimeIndex = 0;
    setArchiveUi(false);
    populateModelRunControl();
    populateForecastTimeControl();
    updateModelMetaCards();
    setRenderedLayersVisible(true);
    updateLayerPanelSummary();
    updateActiveLayersSummary();
    setMapStatus("Interactive fields ready", "ok");
  }

  async function loadArchiveRuns() {
    if (!window.ReadSensorCube?.listRuns) return;
    try {
      const payload = await window.ReadSensorCube.listRuns(8);
      iconModelState.archiveRuns = payload.runs || [];
    } catch (error) {
      console.warn("model_runs_load_failed", error);
      iconModelState.archiveRuns = [];
    }
    populateModelRunControl();
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

  function interpolationCell(fx, fy, width, height) {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    return {
      x0, y0,
      x1: Math.min(width - 1, x0 + 1),
      y1: Math.min(height - 1, y0 + 1),
      tx: fx - x0,
      ty: fy - y0,
    };
  }

  function bilinearValue(q00, q10, q01, q11, tx, ty, fallback) {
    if (![q00, q10, q01, q11].every(Number.isFinite)) return fallback;
    return (
      q00 * (1 - tx) * (1 - ty) +
      q10 * tx * (1 - ty) +
      q01 * (1 - tx) * ty +
      q11 * tx * ty
    );
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

    const { x0, y0, x1, y1, tx, ty } = interpolationCell(fx, fy, width, height);
    const q00 = at(y0, x0);
    const q10 = at(y0, x1);
    const q01 = at(y1, x0);
    const q11 = at(y1, x1);
    return bilinearValue(
      q00, q10, q01, q11, tx, ty,
      at(Math.round(fy), Math.round(fx)),
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

  async function archiveTemperatureAt(lat, lon, sampling) {
    const grid = iconModelState.archiveGrid;
    const run = iconModelState.archiveRun;
    if (!grid || !run || !window.ReadSensorCube?.readWindow2d) return NaN;

    const [height, width] = grid.shape;
    const fy = (lat - grid.lat_start) / grid.lat_step;
    const fx = (lon - grid.lon_start) / grid.lon_step;
    if (fx < 0 || fy < 0 || fx > width - 1 || fy > height - 1) return NaN;

    if (sampling === "nearest") {
      const y = Math.round(fy);
      const x = Math.round(fx);
      const result = await window.ReadSensorCube.readWindow2d(
        run.cube_url,
        "temperature_2m",
        [iconModelState.archiveTimeIndex],
        y, y + 1, x, x + 1,
      );
      return Number(result.data[0]);
    }

    const { x0, y0, x1, y1, tx, ty } = interpolationCell(fx, fy, width, height);
    const result = await window.ReadSensorCube.readWindow2d(
      run.cube_url,
      "temperature_2m",
      [iconModelState.archiveTimeIndex],
      y0, y1 + 1, x0, x1 + 1,
    );
    const localWidth = result.shape[1];
    const at = (y, x) => result.data[(y - y0) * localWidth + (x - x0)];
    const q00 = at(y0, x0);
    const q10 = at(y0, x1);
    const q01 = at(y1, x0);
    const q11 = at(y1, x1);
    return bilinearValue(
      q00, q10, q01, q11, tx, ty,
      Number(at(Math.round(fy), Math.round(fx))),
    );
  }

  async function queryMapPoint(event) {
    const latlng = event.latlng;
    const popup = L.popup({ maxWidth: 330 })
      .setLatLng(latlng)
      .setContent(popupShell(latlng, '<p class="muted">Reading active numerical fields…</p>'))
      .openOn(iconModelState.map);

    if (iconModelState.archiveMode) {
      const grid = iconModelState.archiveGrid;
      if (!grid) {
        popup.setContent(popupShell(
          latlng,
          '<p class="muted">Archived numerical field is still loading.</p>',
        ));
        return;
      }
      const sampling = iconEl("iconSampling")?.value || "bilinear";
      const validAt = iconModelState.archiveRun?.valid_times?.[iconModelState.archiveTimeIndex];
      try {
        const kelvin = await archiveTemperatureAt(latlng.lat, latlng.lng, sampling);
        const value = Number.isFinite(kelvin) ? kelvin - 273.15 : NaN;
        const body = Number.isFinite(value)
          ? `<table><tr><th>2 m temperature</th><td>${value.toFixed(1)} °C</td></tr></table>
             <p class="model-query-note">R2 Zarr archive · sampling: ${sampling}</p>
             <p class="model-query-note">Valid ${modelTime(validAt)}</p>`
          : '<p class="muted">Point is outside the archived ICON-EU grid.</p>';
        popup.setContent(popupShell(latlng, body));
      } catch (error) {
        console.error("icon_archive_query_failed", error);
        popup.setContent(popupShell(
          latlng,
          '<p class="muted">Could not read the archived numerical value.</p>',
        ));
      }
      return;
    }

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
        forecastSelect?.addEventListener("change", () => {
          const index = Number(forecastSelect.value);
          if (iconModelState.archiveMode) void prepareArchiveTime(index);
          else void switchForecastTime(index);
        });
        iconEl("iconModelRun")?.addEventListener("change", (event) => {
          const runId = event.target.value;
          if (runId === "pages-current") exitArchiveMode();
          else void enterArchiveRun(runId);
        });
        iconEl("iconAnimPlay")?.addEventListener("click", toggleAnimation);
        iconEl("iconAnimRange")?.addEventListener("change", (event) => {
          if (iconModelState.archiveMode) return;
          void switchForecastTime(Number(event.target.value));
        });
        iconEl("iconAnimSpeed")?.addEventListener("change", () => {
          if (!iconModelState.animationPlaying) return;
          const serial = iconModelState.animationSerial;
          if (iconModelState.animationTimer !== null) clearTimeout(iconModelState.animationTimer);
          iconModelState.animationTimer = setTimeout(() => animationTick(serial), animationDelay());
        });
        buildLayerPanel();
        const map = makeMap();
        const defaults = rootMeta.interactive.layers.filter((def) => def.default);
        await Promise.all(defaults.map((def) => setLayerEnabled(def, true)));
        updateActiveLayersSummary();

        iconEl("iconMapReset").addEventListener("click", () => {
          const bounds = iconModelState.archiveMode && iconModelState.archiveGrid?.bounds
            ? iconModelState.archiveGrid.bounds
            : iconModelState.meta.bounds;
          map.fitBounds(bounds, { padding: [8, 8] });
        });
        setMapStatus("Interactive fields ready", "ok");
        if (iconModelState.timeline?.steps?.length > 1) {
          void prefetchForecastStep((iconModelState.currentStepIndex + 1) % iconModelState.timeline.steps.length);
        }
        void probeCubeStorage();
        void loadArchiveRuns();
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
