"use strict";

window.SweatyStats = (function () {
  const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Walk", "Hike"]);
  const RIDE_TYPES = new Set([
    "Ride", "GravelRide", "MountainBikeRide", "EBikeRide",
    "EMountainBikeRide", "VirtualRide", "Velomobile", "Handcycle",
  ]);
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // ---------- date helpers ----------
  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function addDays(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }

  // ---------- unit formatting ----------
  function distanceValue(meters, unit) {
    return unit === "mi" ? meters / 1609.344 : meters / 1000;
  }
  function formatDistance(meters, unit) {
    const v = distanceValue(meters, unit);
    return `${v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1)} ${unit}`;
  }
  function elevationValue(meters, unit) {
    return unit === "ft" ? meters * 3.28084 : meters;
  }
  function formatElevation(meters, unit) {
    return `${Math.round(elevationValue(meters, unit)).toLocaleString()} ${unit}`;
  }
  function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    if (h === 0) return `${m}m`;
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  function formatPace(secondsPerUnit, unit) {
    if (!Number.isFinite(secondsPerUnit) || secondsPerUnit <= 0) return null;
    const m = Math.floor(secondsPerUnit / 60);
    const s = Math.round(secondsPerUnit % 60);
    return `${m}:${String(s).padStart(2, "0")} /${unit}`;
  }
  function formatSpeed(metersPerSecond, unit) {
    if (!Number.isFinite(metersPerSecond) || metersPerSecond <= 0) return null;
    const v = unit === "mi" ? metersPerSecond * 2.23694 : metersPerSecond * 3.6;
    return `${v.toFixed(1)} ${unit === "mi" ? "mph" : "km/h"}`;
  }

  // ---------- data shaping ----------
  function flattenAggregates(payload) {
    const rows = [];
    const aggregates = payload.aggregates || {};
    Object.keys(aggregates).forEach((year) => {
      const byType = aggregates[year] || {};
      Object.keys(byType).forEach((type) => {
        const byDate = byType[type] || {};
        Object.keys(byDate).forEach((date) => {
          const cell = byDate[date] || {};
          rows.push({
            date,
            type,
            count: Number(cell.count) || 0,
            distance: Number(cell.distance) || 0,
            elevation: Number(cell.elevation_gain) || 0,
            movingTime: Number(cell.moving_time) || 0,
          });
        });
      });
    });
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return rows;
  }

  function sumRows(rows, fromStr, toStr, typeFilter) {
    const acc = { count: 0, distance: 0, elevation: 0, movingTime: 0, runDistance: 0, runTime: 0, rideDistance: 0, rideTime: 0 };
    rows.forEach((r) => {
      if (r.date < fromStr || r.date > toStr) return;
      if (typeFilter && typeFilter !== "all" && r.type !== typeFilter) return;
      acc.count += r.count;
      acc.distance += r.distance;
      acc.elevation += r.elevation;
      acc.movingTime += r.movingTime;
      if (RUN_TYPES.has(r.type)) { acc.runDistance += r.distance; acc.runTime += r.movingTime; }
      if (RIDE_TYPES.has(r.type)) { acc.rideDistance += r.distance; acc.rideTime += r.movingTime; }
    });
    return acc;
  }

  // ---------- DOM helpers ----------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function section(title, subtitle) {
    const wrap = el("div", "stats-section");
    wrap.appendChild(el("h2", null, title));
    if (subtitle) wrap.appendChild(el("p", "stats-subtitle", subtitle));
    return wrap;
  }

  // ---------- render sections (filled in by later tasks) ----------
  const SECTION_RENDERERS = [];
  const FILTERED_RENDERERS = [];

  function filteredRows(ctx) {
    return ctx.rows.filter((r) => {
      if (ctx.filters.type !== "all" && r.type !== ctx.filters.type) return false;
      if (ctx.filters.year !== "all" && !r.date.startsWith(ctx.filters.year + "-")) return false;
      return true;
    });
  }

  function renderStats(container, payload) {
    container.innerHTML = "";
    const rows = flattenAggregates(payload);
    const units = {
      distance: (payload.units && payload.units.distance) || "km",
      elevation: (payload.units && payload.units.elevation) || "m",
    };
    const today = new Date();
    const ctx = { payload, rows, units, today, container, filters: { year: "all", type: "all" } };

    // Quick-glance rows first ("right now" — unaffected by filters).
    SECTION_RENDERERS.forEach((render) => render(ctx));

    // Filters + filtered sections.
    const filterBar = el("div", "stats-filters");
    const yearSelect = document.createElement("select");
    const years = (payload.years || []).slice().sort((a, b) => b - a);
    yearSelect.appendChild(new Option("All years", "all"));
    years.forEach((y) => yearSelect.appendChild(new Option(String(y), String(y))));
    const typeSelect = document.createElement("select");
    typeSelect.appendChild(new Option("All sports", "all"));
    (payload.types || []).forEach((t) => typeSelect.appendChild(new Option(t, t)));
    filterBar.appendChild(yearSelect);
    filterBar.appendChild(typeSelect);
    container.appendChild(filterBar);

    const filtered = el("div", "stats-filtered");
    filtered.style.display = "flex";
    filtered.style.flexDirection = "column";
    filtered.style.gap = "22px";
    container.appendChild(filtered);

    function renderFiltered() {
      ctx.filters.year = yearSelect.value;
      ctx.filters.type = typeSelect.value;
      filtered.innerHTML = "";
      FILTERED_RENDERERS.forEach((render) => render(ctx, filtered));
    }
    yearSelect.addEventListener("change", renderFiltered);
    typeSelect.addEventListener("change", renderFiltered);
    renderFiltered();
  }

  return {
    renderStats,
    _internal: {
      RUN_TYPES, RIDE_TYPES, MONTH_NAMES, DAY_NAMES, SECTION_RENDERERS, FILTERED_RENDERERS,
      ymd, addDays, flattenAggregates, sumRows, el, section, filteredRows,
      distanceValue, formatDistance, formatDuration, formatPace, formatSpeed, formatElevation, elevationValue,
    },
  };
})();
