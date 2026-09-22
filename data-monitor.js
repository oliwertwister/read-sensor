(() => {
  "use strict";

  const el = (id) => document.getElementById(id);
  let loaded = false;

  function bytes(value) {
    const n = Number(value) || 0;
    const units = ["B", "KiB", "MiB", "GiB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v >= 100 || i === 0 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
  }

  function duration(seconds) {
    const n = Number(seconds) || 0;
    if (n < 60) return `${n.toFixed(1)} s`;
    const min = Math.floor(n / 60);
    const sec = Math.round(n % 60);
    return `${min}m ${sec}s`;
  }

  function pct(value) {
    return `${(100 * Number(value || 0)).toFixed(1)}%`;
  }

  function setText(id, value) {
    const node = el(id);
    if (node) node.textContent = value;
  }

  function tableBody(id, rows, columns) {
    const body = el(id);
    if (!body) return;
    body.replaceChildren();
    for (const row of rows) {
      const tr = document.createElement("tr");
      for (const col of columns) {
        const td = document.createElement("td");
        td.textContent = typeof col === "function" ? col(row) : (row[col] ?? "—");
        tr.append(td);
      }
      body.append(tr);
    }
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = columns.length;
      td.textContent = "No data recorded for this deployment.";
      td.className = "muted";
      tr.append(td);
      body.append(tr);
    }
  }

  function meter(id, used, limit, soft = false) {
    const root = el(id);
    if (!root) return;
    const ratio = limit > 0 ? used / limit : 0;
    const bar = root.querySelector(".monitor-meter-fill");
    const label = root.querySelector(".monitor-meter-label");
    if (bar) {
      bar.style.width = `${Math.min(100, ratio * 100)}%`;
      bar.classList.toggle("warn", ratio >= 0.8);
      bar.classList.toggle("over", ratio >= 1);
    }
    if (label) label.textContent = `${bytes(used)} / ${bytes(limit)} · ${pct(ratio)}${soft ? " target" : ""}`;
  }

  function render(data) {
    const s = data.summary || {};
    setText("monitorGenerated", data.generated_at ? `Deployment report · ${new Date(data.generated_at).toLocaleString()}` : "Deployment report");
    setText("monitorPages", bytes(s.pages_bytes));
    setText("monitorDownloads", bytes(s.download_bytes));
    setText("monitorRuntime", duration(s.pipeline_wall_seconds ?? s.recorded_processing_seconds));
    setText("monitorRuntimeDetail", `heavy-step total ${duration(s.recorded_processing_seconds)}`);
    setText("monitorPeakRam", `${Number(s.peak_step_rss_mib || 0).toFixed(0)} MiB`);
    setText("monitorFiles", String(s.pages_files ?? "—"));
    setText("monitorCube", `${bytes(s.cube_bytes)} · ${s.cube_objects ?? 0} objects`);
    setText(
      "monitorProducts",
      `${s.interactive_fields ?? 0} fields · ${s.interactive_layers ?? 0} layers · ${s.satellite_products ?? 0} satellite · ${s.satellite_history_snapshots ?? 0} snapshots (${bytes(s.satellite_history_bytes || 0)})`,
    );
    const issueParts = [];
    if (s.failed_processing_steps) issueParts.push(`${s.failed_processing_steps} failed step(s)`);
    if (s.satellite_composite_warnings) issueParts.push(`${s.satellite_composite_warnings} composite warning(s)`);
    issueParts.push(`satellite: ${s.satellite_backend || "unknown"}`);
    setText("monitorWarnings", issueParts.join(" · "));

    const limits = data.limits || {};
    meter("monitorPagesHard", s.pages_bytes || 0, limits.pages_hard_bytes || 0);
    meter("monitorPagesSoft", s.pages_bytes || 0, limits.pages_soft_target_bytes || 0, true);
    meter("monitorR2Run", s.cube_bytes || 0, limits.r2_run_bytes || 0);
    const objectRoot = el("monitorR2Objects");
    if (objectRoot) {
      const used = Number(s.cube_objects || 0);
      const max = Number(limits.r2_objects_per_run || 0);
      const ratio = max ? used / max : 0;
      const fill = objectRoot.querySelector(".monitor-meter-fill");
      const label = objectRoot.querySelector(".monitor-meter-label");
      if (fill) {
        fill.style.width = `${Math.min(100, ratio * 100)}%`;
        fill.classList.toggle("warn", ratio >= 0.8);
      }
      if (label) label.textContent = `${used} / ${max} objects · ${pct(ratio)}`;
    }
    setText("monitorObjectLimit", bytes(limits.r2_single_object_bytes));

    tableBody("monitorDownloadsBody", data.downloads || [], [
      "source",
      (r) => bytes(r.bytes),
      (r) => String(r.requests ?? 0),
      (r) => duration(r.elapsed_seconds),
    ]);
    tableBody("monitorProcessingBody", data.processing_steps || [], [
      "name",
      (r) => duration(r.elapsed_seconds),
      (r) => `${Number(r.peak_rss_mib || 0).toFixed(0)} MiB`,
      (r) => `${Number((r.user_cpu_seconds || 0) + (r.system_cpu_seconds || 0)).toFixed(1)} s`,
      (r) => r.exit_code === 0 ? "OK" : `exit ${r.exit_code}`,
    ]);
    tableBody("monitorStorageBody", data.storage_by_type || [], [
      "type",
      (r) => bytes(r.bytes),
      (r) => String(r.files ?? 0),
    ]);
    tableBody("monitorAreaBody", data.storage_by_area || [], [
      "area",
      (r) => bytes(r.bytes),
      (r) => String(r.files ?? 0),
    ]);
    tableBody("monitorSatelliteStorageBody", data.satellite_product_storage || [], [
      "product",
      (r) => bytes(r.bytes),
      (r) => bytes(r.raw_bytes),
      (r) => bytes(r.decorated_bytes),
    ]);
    tableBody("monitorLargestBody", data.largest_files || [], [
      "path",
      (r) => bytes(r.bytes),
    ]);

    const runner = data.runner || {};
    setText(
      "monitorRunner",
      `${runner.logical_cpus ?? "—"} logical CPU · ${runner.memory_total_mib ? Number(runner.memory_total_mib).toFixed(0) + " MiB RAM" : "RAM unknown"} · Python ${runner.python || "—"}`
    );
    const deploy = data.deployment || {};
    setText("monitorDeployId", deploy.run_number ? `GitHub Actions #${deploy.run_number} · ${String(deploy.sha || "").slice(0, 7)}` : "Local / unknown deployment");

    const notes = el("monitorNotes");
    if (notes) {
      notes.replaceChildren();
      for (const note of data.notes || []) {
        const li = document.createElement("li");
        li.textContent = note;
        notes.append(li);
      }
    }
  }

  async function loadMonitor(force = false) {
    if (loaded && !force) return;
    setText("monitorStatus", "Loading deployment metrics…");
    try {
      const response = await fetch(`monitor/latest.json?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      render(data);
      setText("monitorStatus", "Current deployment metrics");
      loaded = true;
    } catch (error) {
      console.error("data_monitor_failed", error);
      setText("monitorStatus", "Monitor data unavailable");
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll('nav button[data-tab="data-monitor"]').forEach((button) => {
      button.addEventListener("click", () => loadMonitor(true));
    });
    el("monitorRefresh")?.addEventListener("click", () => loadMonitor(true));
  });
})();
