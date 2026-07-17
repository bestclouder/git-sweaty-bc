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

  // ---------- effort proxy ----------
  // Heuristic: hours × intensity (pace vs your trailing-90-day average for
  // that sport, clamped 0.5–2.0) + elevation/100. Comparable week-to-week;
  // not physiologically calibrated.
  function baselineSpeeds(rows, today) {
    const from = ymd(addDays(today, -89));
    const to = ymd(today);
    const acc = {};
    rows.forEach((r) => {
      if (r.date < from || r.date > to) return;
      if (r.distance <= 0 || r.movingTime <= 0) return;
      if (!acc[r.type]) acc[r.type] = { d: 0, t: 0 };
      acc[r.type].d += r.distance;
      acc[r.type].t += r.movingTime;
    });
    const out = {};
    Object.keys(acc).forEach((type) => { out[type] = acc[type].d / acc[type].t; });
    return out;
  }

  function effortScore(rows, fromStr, toStr, baselines) {
    let score = 0;
    rows.forEach((r) => {
      if (r.date < fromStr || r.date > toStr) return;
      let factor = 1;
      if (r.distance > 0 && r.movingTime > 0 && baselines[r.type]) {
        factor = Math.min(2, Math.max(0.5, (r.distance / r.movingTime) / baselines[r.type]));
      }
      score += (r.movingTime / 3600) * factor + r.elevation / 100;
    });
    return score;
  }

  // ---------- compare cards ----------
  function deltaNode(current, previous, options) {
    const opts = options || {};
    const node = el("div", "delta");
    if (!Number.isFinite(previous) || previous === 0) {
      node.classList.add("delta-flat");
      node.textContent = "no prior data";
      return node;
    }
    if (opts.pace) {
      // Pace values are passed so that LOWER is always faster: run pace is
      // sec/unit (lower = faster), ride "pace" is negated speed (higher
      // speed => more negative => lower). Never Math.abs() these.
      if (!Number.isFinite(current)) {
        node.classList.add("delta-flat");
        node.textContent = "—";
        return node;
      }
      const faster = current < previous;
      const pct = Math.abs(((previous - current) / Math.abs(previous)) * 100);
      node.classList.add(faster ? "delta-up" : "delta-down");
      node.textContent = `${faster ? "▲ faster" : "▼ slower"} ${pct.toFixed(0)}%`;
      return node;
    }
    const diffPct = ((current - previous) / previous) * 100;
    if (Math.abs(diffPct) < 0.5) {
      node.classList.add("delta-flat");
      node.textContent = "≈ same";
      return node;
    }
    node.classList.add(diffPct > 0 ? "delta-up" : "delta-down");
    node.textContent = `${diffPct > 0 ? "▲" : "▼"} ${diffPct > 0 ? "+" : "−"}${Math.abs(diffPct).toFixed(0)}%`;
    return node;
  }

  function statCard(label, valueText, deltaEl) {
    const card = el("div", "stats-card");
    card.appendChild(el("div", "label", label));
    card.appendChild(el("div", "value", valueText));
    card.appendChild(deltaEl);
    return card;
  }

  function periodPace(sums, units) {
    // Prefer run pace when any run-family distance exists; else ride speed.
    if (sums.runDistance > 0 && sums.runTime > 0) {
      const secPerUnit = sums.runTime / distanceValue(sums.runDistance, units.distance);
      return { kind: "run", value: secPerUnit, text: formatPace(secPerUnit, units.distance) || "- - -" };
    }
    if (sums.rideDistance > 0 && sums.rideTime > 0) {
      const speed = sums.rideDistance / sums.rideTime;
      // negative so "lower is better" comparison logic also works for speed
      return { kind: "ride", value: -speed, text: formatSpeed(speed, units.distance) || "- - -" };
    }
    return { kind: "none", value: NaN, text: "- - -" };
  }

  function compareRow(rows, curRange, prevRange, units, baselines, labelSuffix) {
    const cur = sumRows(rows, curRange[0], curRange[1]);
    const prev = sumRows(rows, prevRange[0], prevRange[1]);
    const curPace = periodPace(cur, units);
    const prevPace = periodPace(prev, units);
    const curEffort = effortScore(rows, curRange[0], curRange[1], baselines);
    const prevEffort = effortScore(rows, prevRange[0], prevRange[1], baselines);

    const grid = el("div", "stats-cards");
    grid.appendChild(statCard(`Distance ${labelSuffix}`, formatDistance(cur.distance, units.distance), deltaNode(cur.distance, prev.distance)));
    grid.appendChild(statCard("Active time", formatDuration(cur.movingTime), deltaNode(cur.movingTime, prev.movingTime)));
    grid.appendChild(statCard(
      `Avg pace${curPace.kind === "ride" ? " (rides)" : curPace.kind === "run" ? " (runs)" : ""}`,
      curPace.text,
      deltaNode(
        curPace.kind === "none" ? NaN : curPace.value,
        prevPace.kind !== curPace.kind || prevPace.kind === "none" ? NaN : prevPace.value,
        { pace: true },
      ),
    ));
    grid.appendChild(statCard("Activities", String(cur.count), deltaNode(cur.count, prev.count)));
    grid.appendChild(statCard("Elevation", formatElevation(cur.elevation, units.elevation), deltaNode(cur.elevation, prev.elevation)));
    grid.appendChild(statCard("Effort (estimated)", curEffort > 0 ? curEffort.toFixed(1) : "- - -", deltaNode(curEffort, prevEffort)));
    return grid;
  }

  SECTION_RENDERERS.push(function renderQuickGlance(ctx) {
    const { rows, units, today, container } = ctx;
    const baselines = baselineSpeeds(rows, today);

    const week = section("This week", "Rolling last 7 days vs the 7 days before");
    week.appendChild(compareRow(
      rows,
      [ymd(addDays(today, -6)), ymd(today)],
      [ymd(addDays(today, -13)), ymd(addDays(today, -7))],
      units, baselines, `(${units.distance})`,
    ));
    container.appendChild(week);

    const curStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const prevStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const prevMonthDays = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
    const sameDayCount = Math.min(today.getDate(), prevMonthDays);
    const prevEnd = new Date(prevStart.getFullYear(), prevStart.getMonth(), sameDayCount);

    const month = section("This month", "Month-to-date vs the same number of days into last month");
    month.appendChild(compareRow(
      rows,
      [ymd(curStart), ymd(today)],
      [ymd(prevStart), ymd(prevEnd)],
      units, baselines, `(${units.distance})`,
    ));
    container.appendChild(month);
  });

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
