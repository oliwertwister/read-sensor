"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const DEFAULT_WMO = "10384";
  const SOURCE_URL = "https://www.ogimet.com/getsynop_help.phtml.en";
  const LICENSE_URL = "https://www.ogimet.com/license.phtml";
  let feed = null;

  const esc = (value) => String(value ?? "—")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  function utc(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC", day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date) + " UTC";
  }

  function observationAge(value) {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return { label: "Observation time unavailable", className: "unavailable" };
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    const label = minutes < 60 ? `${minutes} min old`
      : minutes < 1440 ? `${Math.floor(minutes / 60)} h old`
        : `${Math.floor(minutes / 1440)} d old`;
    return { label, className: minutes > 120 ? "stale" : "" };
  }

  function pressure(group) {
    if (!/^\d{5}$/.test(group)) return null;
    let value = Number(group.slice(1)) / 10;
    if (value < 500) value += 1000;
    return value;
  }

  function signedTemp(group) {
    if (!/^[12][01]\d{3}$/.test(group)) return null;
    const value = Number(group.slice(2)) / 10;
    return group[1] === "1" ? -value : value;
  }

  function visibility(code) {
    if (!/^\d{2}$/.test(code)) return "—";
    const n = Number(code);
    if (n === 0) return "< 0.1 km";
    if (n <= 50) return (n / 10).toFixed(1) + " km";
    if (n >= 56 && n <= 80) return (n - 50) + " km";
    const special = {81:"35 km",82:"40 km",83:"45 km",84:"50 km",85:"55 km",
      86:"60 km",87:"65 km",88:"70 km",89:"> 70 km",90:"< 0.05 km",
      91:"0.05 km",92:"0.2 km",93:"0.5 km",94:"1 km",95:"2 km",
      96:"4 km",97:"10 km",98:"20 km",99:">= 50 km"};
    return special[n] || "WMO code " + code;
  }
  function cloudBase(code) {
    return ({
      "0":"0–50 m","1":"50–100 m","2":"100–200 m","3":"200–300 m",
      "4":"300–600 m","5":"600–1000 m","6":"1000–1500 m",
      "7":"1500–2000 m","8":"2000–2500 m","9":"> 2500 m","/":"—",
    })[code] || "—";
  }

  function cloudCover(code) {
    if (code === "/") return "—";
    if (code === "9") return "Sky obscured";
    return /^[0-8]$/.test(code) ? code + "/8 oktas" : "—";
  }

  function precipitation(group) {
    if (!/^6\d{4}$/.test(group)) return null;
    const rrr = Number(group.slice(1, 4));
    const periods = {"1":"6 h","2":"12 h","3":"18 h","4":"24 h",
      "5":"1 h","6":"2 h","7":"3 h","8":"9 h","9":"15 h"};
    let amount = rrr <= 988 ? rrr + " mm" : rrr === 989 ? ">= 989 mm"
      : rrr === 990 ? "trace" : ((rrr - 990) / 10).toFixed(1) + " mm";
    return amount + (periods[group[4]] ? " / " + periods[group[4]] : "");
  }

  function weather(code) {
    if (!Number.isFinite(code)) return "—";
    if (code <= 3) return ["No significant weather","Clouds dissolving",
      "Sky unchanged","Clouds developing"][code];
    if (code <= 9) return "Visibility phenomenon";
    const local = {10:"Mist",11:"Shallow fog patches",12:"Continuous shallow fog",
      13:"Lightning visible",14:"Precipitation not reaching ground",
      15:"Distant precipitation",16:"Nearby precipitation",
      17:"Thunderstorm without precipitation",18:"Squalls",19:"Funnel cloud"};
    if (code <= 19) return local[code] || "—";
    if (code <= 29) return "Recent weather";
    if (code <= 39) return "Dust / sand";
    if (code <= 49) return "Fog / ice fog";
    if (code <= 59) return "Drizzle";
    if (code <= 69) return "Rain";
    if (code <= 79) return "Snow / solid precipitation";
    if (code <= 89) return "Showers";
    return "Thunderstorm";
  }

  function decode(raw) {
    const tokens = String(raw || "").replaceAll("=", " = ")
      .trim().split(/\s+/).filter(Boolean);
    const start = tokens.indexOf("AAXX");
    if (start < 0 || tokens.length < start + 5) throw new Error("AAXX header missing");
    const time = tokens[start + 1];
    const station = tokens[start + 2];
    const control = tokens[start + 3];
    const wind = tokens[start + 4];
    const groups = tokens.slice(start + 5).filter((g) => g !== "=");
    const markers = new Set(["222", "333", "444", "555"]);
    const firstMarker = groups.findIndex((group) => markers.has(group));
    const section1 = groups.slice(0, firstMarker >= 0 ? firstMarker : groups.length);
    const section3Start = groups.indexOf("333");
    const section3End = groups.findIndex((group, index) => index > section3Start && markers.has(group));
    const section3 = section3Start < 0 ? [] : groups.slice(
      section3Start + 1,
      section3End < 0 ? groups.length : section3End,
    );
    const out = {
      station, day: time.slice(0,2), hour: time.slice(2,4),
      windUnit: ["0","1"].includes(time[4]) ? "m/s" : ["3","4"].includes(time[4]) ? "kt" : "—",
      visibility: control.length === 5 ? visibility(control.slice(3)) : "—",
      cloudBase: control.length === 5 ? cloudBase(control[2]) : "—",
      cloudCover: wind.length === 5 ? cloudCover(wind[0]) : "—",
      windDir: null, windSpeed: null, temp: null, dew: null, rh: null,
      stationPressure: null, mslPressure: null, tendency: null,
      precipitation: null, presentWeather: "—", pastWeather: "—",
      lowCloudAmount: null, cloudTypes: null, groups: [],
    };
    if (/^[0-9/]\d{4}$/.test(wind)) {
      const dd = wind.slice(1,3), ff = wind.slice(3);
      if (/^\d{2}$/.test(dd) && !["00","99"].includes(dd)) out.windDir = Number(dd) * 10;
      if (/^\d{2}$/.test(ff)) out.windSpeed = Number(ff);
    }

    for (const group of section1) {
      if (/^1[01]\d{3}$/.test(group)) out.temp = signedTemp(group);
      else if (/^2[01]\d{3}$/.test(group)) out.dew = signedTemp(group);
      else if (/^29\d{3}$/.test(group)) {
        const humidity = Number(group.slice(2));
        if (humidity <= 100) out.rh = humidity;
      }
      else if (/^3\d{4}$/.test(group)) out.stationPressure = pressure(group);
      else if (/^4\d{4}$/.test(group)) out.mslPressure = pressure(group);
      else if (/^5\d{4}$/.test(group)) {
        const a = Number(group[1]), change = Number(group.slice(2)) / 10;
        out.tendency = (a <= 3 ? change : a === 4 ? 0 : -change);
      } else if (/^6\d{4}$/.test(group)) out.precipitation = precipitation(group);
      else if (/^7\d{4}$/.test(group)) {
        const ww = Number(group.slice(1,3));
        out.presentWeather = weather(ww);
        out.pastWeather = group[3] + " / " + group[4] + " (WMO codes)";
      } else if (/^8[0-9/]{4}$/.test(group)) {
        out.lowCloudAmount = cloudCover(group[1]);
        out.cloudTypes = "CL " + group[2] + " · CM " + group[3] + " · CH " + group[4];
      }
    }
    if (!out.precipitation) {
      const precipitationGroup = section3.find((group) => /^6\d{4}$/.test(group));
      if (precipitationGroup) out.precipitation = precipitation(precipitationGroup);
    }

    const describe = (group, section) => {
      if (section !== 1) {
        if (section === 3 && /^6\d{4}$/.test(group)) return ["6RRRtr", "Section 3 precipitation"];
        return [`Section ${section}`, "Supplementary or regional group"];
      }
      if (/^1[01]\d{3}$/.test(group)) return ["1snTTT", "Air temperature"];
      if (/^2[01]\d{3}$/.test(group)) return ["2snTdTdTd", "Dew-point temperature"];
      if (/^29\d{3}$/.test(group)) return ["29UUU", "Relative humidity"];
      if (/^3\d{4}$/.test(group)) return ["3P0P0P0P0", "Station pressure"];
      if (/^4\d{4}$/.test(group)) return ["4PPPP", "Sea-level pressure"];
      if (/^5\d{4}$/.test(group)) return ["5appp", "3-hour pressure tendency"];
      if (/^6\d{4}$/.test(group)) return ["6RRRtr", "Precipitation"];
      if (/^7\d{4}$/.test(group)) return ["7wwW1W2", "Present / past weather"];
      if (/^8[0-9/]{4}$/.test(group)) return ["8NhCLCMCH", "Cloud types"];
      return ["", "Additional SYNOP group"];
    };
    let section = 1;
    const describedGroups = groups.map((group) => {
      if (markers.has(group)) {
        section = Number(group[0]);
        return [group, group, `Section ${section} begins`];
      }
      return [group, ...describe(group, section)];
    });
    out.groups = [
      [time, "YYGGiw", "Observation day/hour and wind-unit indicator"],
      [station, "IIiii", "WMO station identifier"],
      [control, "iRiXhVV", "Precip/weather indicators, cloud base, visibility"],
      [wind, "Nddff", "Cloud cover, wind direction and speed"],
      ...describedGroups,
    ];
    return out;
  }
  function metric(label, value, sub = "") {
    return `<div><small>${esc(label)}</small><strong>${esc(value)}</strong>${sub ? `<span>${esc(sub)}</span>` : ""}</div>`;
  }

  function sourceCredit() {
    return `<p class="muted wx-source">Raw reports via <a href="${SOURCE_URL}" target="_blank" rel="noreferrer">OGIMET getsynop</a> · <a href="${LICENSE_URL}" target="_blank" rel="noreferrer">source and usage notes</a> · WMO FM-12 SYNOP · UTC. Educational decoding only; not for safety-critical use.</p>`;
  }

  function renderStation(record) {
    const root = $("synopDetail");
    if (!record?.raw) {
      root.innerHTML = `<div class="wx-panel"><h3>No recent raw SYNOP</h3><p class="muted">${esc(record?.error || "No report returned.")}</p></div>${sourceCredit()}`;
      return;
    }
    let d;
    try { d = decode(record.raw); }
    catch (error) {
      root.innerHTML = `<div class="wx-panel"><h3>Decode failed</h3><pre class="synop-raw">${esc(record.raw)}</pre><p class="muted">${esc(error.message)}</p></div>`;
      return;
    }

    const freshness = observationAge(record.observation_time);
    const wind = d.windSpeed == null ? "—" :
      `${d.windDir == null ? "VRB" : d.windDir + "°"} · ${d.windSpeed} ${d.windUnit}`;
    const metrics = [
      metric("Temperature", d.temp == null ? "—" : d.temp.toFixed(1) + " °C"),
      metric("Dew point", d.dew == null ? "—" : d.dew.toFixed(1) + " °C",
        d.rh == null ? "" : `RH ${d.rh}%`),
      metric("Wind", wind),
      metric("MSL pressure", d.mslPressure == null ? "—" : d.mslPressure.toFixed(1) + " hPa"),
      metric("Visibility", d.visibility),
    ].join("");

    const groupRows = d.groups.map(([group, syntax, meaning]) =>
      `<div><code>${esc(group)}</code><span>${esc(syntax)}</span><strong>${esc(meaning)}</strong></div>`
    ).join("");

    root.innerHTML = `
      <div class="wx-panel synop-raw-panel">
        <div class="panel-title">
          <div><h3>Raw SYNOP</h3><p class="muted">${esc(record.name)} · WMO ${esc(record.wmo)} · ${esc(utc(record.observation_time))}</p></div>
          <span class="synop-freshness ${freshness.className}">${esc(freshness.label)}</span>
          <button id="copySynop" type="button">Copy raw</button>
        </div>
        <pre class="synop-raw">${esc(record.raw)}</pre>
      </div>
      <div class="wx-panel">
        <h3>Decoded</h3>
        <div class="metric-strip synop-metrics">${metrics}</div>
        <dl class="wx-details synop-details">
          <dt>Station pressure</dt><dd>${d.stationPressure == null ? "—" : d.stationPressure.toFixed(1) + " hPa"}</dd>
          <dt>3 h pressure tendency</dt><dd>${d.tendency == null ? "—" : (d.tendency > 0 ? "+" : "") + d.tendency.toFixed(1) + " hPa"}</dd>
          <dt>Total cloud cover</dt><dd>${esc(d.cloudCover)}</dd>
          <dt>Lowest cloud base</dt><dd>${esc(d.cloudBase)}</dd>
          <dt>Low-cloud amount</dt><dd>${esc(d.lowCloudAmount || "—")}</dd>
          <dt>Cloud types</dt><dd>${esc(d.cloudTypes || "—")}</dd>
          <dt>Present weather</dt><dd>${esc(d.presentWeather)}</dd>
          <dt>Past weather</dt><dd>${esc(d.pastWeather)}</dd>
          <dt>Precipitation</dt><dd>${esc(d.precipitation || "—")}</dd>
        </dl>
      </div>
      <div class="wx-panel">
        <h3>Code groups</h3>
        <p class="muted">The decoded values above cover the standard Section 1 fields and Section 3 precipitation. Other regional groups are preserved but not guessed.</p>
        <div class="synop-groups">${groupRows}</div>
      </div>
      ${sourceCredit()}`;

    $("copySynop")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(record.raw);
        $("copySynop").textContent = "Copied";
        setTimeout(() => { if ($("copySynop")) $("copySynop").textContent = "Copy raw"; }, 1200);
      } catch (_) { $("copySynop").textContent = "Copy failed"; }
    });
  }

  function renderSelected() {
    const wmo = $("synopStation")?.value || DEFAULT_WMO;
    renderStation(feed?.stations?.find((record) => record.wmo === wmo));
  }

  async function loadSynop() {
    const root = $("synopDetail");
    if (!root) return;
    try {
      const response = await fetch(`synop/latest.json?t=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      feed = await response.json();
      const select = $("synopStation");
      const stations = Array.isArray(feed.stations) ? feed.stations : [];
      const previous = select.dataset.loaded === "true" ? select.value : "";
      select.replaceChildren(...stations.map((record) => {
        const option = document.createElement("option");
        option.value = record.wmo;
        option.textContent = `${record.name} · ${record.wmo}`;
        return option;
      }));
      if ([...select.options].some((option) => option.value === previous)) select.value = previous;
      else {
        const newest = stations.filter((record) => record.raw && record.observation_time)
          .sort((a, b) => String(b.observation_time).localeCompare(String(a.observation_time)))[0];
        if (newest) select.value = newest.wmo;
        else if ([...select.options].some((option) => option.value === DEFAULT_WMO)) select.value = DEFAULT_WMO;
      }
      select.dataset.loaded = "true";
      const warning = Array.isArray(feed.errors) && feed.errors.length ? " · source refresh warning" : "";
      $("synopGenerated").textContent = feed.generated_at ? `Feed refreshed ${utc(feed.generated_at)}${warning}` : "Feed time unavailable";
      renderSelected();
    } catch (error) {
      console.error("synop_failed", error);
      root.innerHTML = `<div class="wx-panel"><h3>SYNOP unavailable</h3><p class="muted">${esc(error.message)}</p></div>`;
    }
  }

  function init() {
    const select = $("synopStation");
    if (!select) return;
    select.addEventListener("change", renderSelected);
    $("synopRefresh")?.addEventListener("click", loadSynop);
    loadSynop();
    setInterval(loadSynop, 5 * 60 * 1000);
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { decode, observationAge };
  if (typeof document !== "undefined") init();
})();
