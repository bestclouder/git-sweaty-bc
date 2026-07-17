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
    let m = Math.floor(secondsPerUnit / 60);
    let s = Math.round(secondsPerUnit % 60);
    if (s === 60) { m += 1; s = 0; }
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

  // ---------- training trends ----------
  function sundayOnOrBefore(d) {
    return addDays(d, -d.getDay());
  }

  function weeklySeries(rows, today, weeks) {
    const series = [];
    const thisWeekStart = sundayOnOrBefore(today);
    for (let i = weeks - 1; i >= 0; i -= 1) {
      const start = addDays(thisWeekStart, -7 * i);
      const end = addDays(start, 6);
      const sums = sumRows(rows, ymd(start), ymd(end));
      series.push({ start, distance: sums.distance, movingTime: sums.movingTime });
    }
    return series;
  }

  function barChartSVG(series, valueOf, formatValue) {
    const width = 1040;
    const height = 150;
    const pad = { top: 14, bottom: 26, left: 6, right: 6 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const max = Math.max(1, ...series.map(valueOf));
    const barW = innerW / series.length;
    let bars = "";
    series.forEach((point, i) => {
      const v = valueOf(point);
      const h = (v / max) * innerH;
      const x = pad.left + i * barW;
      const y = pad.top + innerH - h;
      const label = `${point.start.getMonth() + 1}/${point.start.getDate()}: ${formatValue(v)}`;
      bars += `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, barW - 2).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="#4f7cff" opacity="0.85"><title>${label}</title></rect>`;
      if (i % 4 === 0) {
        bars += `<text x="${(x + barW / 2).toFixed(1)}" y="${height - 8}" font-size="10" fill="currentColor" opacity="0.55" text-anchor="middle">${MONTH_NAMES[point.start.getMonth()]} ${point.start.getDate()}</text>`;
      }
    });
    return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img">${bars}</svg>`;
  }

  FILTERED_RENDERERS.push(function renderTrends(ctx, parent) {
    const rows = filteredRows(ctx);
    const { units, today } = ctx;
    const wrap = section("Training trends", "Weekly totals for the last 26 weeks; monthly rollup for the selected year");

    const series = weeklySeries(rows, today, 26);
    const chart = el("div", "stats-chart");
    chart.innerHTML = barChartSVG(series, (p) => p.distance, (v) => formatDistance(v, units.distance));
    wrap.appendChild(chart);

    // 4-week trend line
    const last4 = series.slice(-4).reduce((sum, p) => sum + p.distance, 0);
    const prior4 = series.slice(-8, -4).reduce((sum, p) => sum + p.distance, 0);
    const trend = el("p", "stats-subtitle");
    if (prior4 > 0) {
      const pct = ((last4 - prior4) / prior4) * 100;
      trend.textContent = `Last 4 weeks: ${formatDistance(last4, units.distance)} — ${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(0)}% vs the prior 4 weeks (${formatDistance(prior4, units.distance)}).`;
    } else {
      trend.textContent = `Last 4 weeks: ${formatDistance(last4, units.distance)}.`;
    }
    wrap.appendChild(trend);

    // Monthly table for the selected (or current) year, with prior-year context
    const year = ctx.filters.year === "all" ? String(today.getFullYear()) : ctx.filters.year;
    const prevYear = String(Number(year) - 1);
    const tableWrap = el("div", "stats-table-wrap");
    const table = el("table", "stats-table");
    table.innerHTML = `<thead><tr><th>${year} by month</th><th>Distance</th><th>Time</th><th>Elevation</th><th>Activities</th><th>Active days</th><th>${prevYear} distance</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    // Type-filtered but NOT year-filtered: the `year`/`prevYear` date ranges
    // below scope each column, and the prior-year context column needs rows
    // from outside the selected year.
    const monthRows = ctx.rows.filter((r) => ctx.filters.type === "all" || r.type === ctx.filters.type);
    for (let m = 0; m < 12; m += 1) {
      const mm = String(m + 1).padStart(2, "0");
      const from = `${year}-${mm}-01`;
      const to = `${year}-${mm}-31`;
      const cur = sumRows(monthRows, from, to);
      const prev = sumRows(monthRows, `${prevYear}-${mm}-01`, `${prevYear}-${mm}-31`);
      if (cur.count === 0 && prev.count === 0) continue;
      const activeDays = new Set(monthRows.filter((r) => r.date >= from && r.date <= to && r.count > 0).map((r) => r.date)).size;
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${MONTH_NAMES[m]}</td><td>${formatDistance(cur.distance, units.distance)}</td><td>${formatDuration(cur.movingTime)}</td><td>${formatElevation(cur.elevation, units.elevation)}</td><td>${cur.count}</td><td>${activeDays}</td><td>${prev.count ? formatDistance(prev.distance, units.distance) : "- - -"}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    wrap.appendChild(tableWrap);
    parent.appendChild(wrap);
  });

  // ---------- pace & performance ----------
  FILTERED_RENDERERS.push(function renderPace(ctx, parent) {
    const rows = filteredRows(ctx);
    const { units } = ctx;
    const wrap = section("Pace & performance", "Per sport, within the selected filters. Fastest day requires at least 2 km.");

    const byType = {};
    rows.forEach((r) => {
      if (!byType[r.type]) {
        byType[r.type] = { distance: 0, movingTime: 0, elevation: 0, count: 0, longestDay: 0, biggestClimb: 0, fastest: null };
      }
      const t = byType[r.type];
      t.distance += r.distance;
      t.movingTime += r.movingTime;
      t.elevation += r.elevation;
      t.count += r.count;
      t.longestDay = Math.max(t.longestDay, r.distance);
      t.biggestClimb = Math.max(t.biggestClimb, r.elevation);
      if (r.distance >= 2000 && r.movingTime > 0) {
        const pace = r.movingTime / distanceValue(r.distance, units.distance);
        if (t.fastest === null || pace < t.fastest) t.fastest = pace;
      }
    });

    const tableWrap = el("div", "stats-table-wrap");
    const table = el("table", "stats-table");
    table.innerHTML = `<thead><tr><th>Sport</th><th>Distance</th><th>Time</th><th>Avg pace</th><th>Longest day</th><th>Biggest climb</th><th>Fastest day</th><th>Activities</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    Object.keys(byType)
      .sort((a, b) => byType[b].distance - byType[a].distance)
      .forEach((type) => {
        const t = byType[type];
        let avg = "- - -";
        if (t.distance > 0 && t.movingTime > 0) {
          avg = RIDE_TYPES.has(type)
            ? (formatSpeed(t.distance / t.movingTime, units.distance) || "- - -")
            : (formatPace(t.movingTime / distanceValue(t.distance, units.distance), units.distance) || "- - -");
        }
        const fastest = t.fastest !== null && !RIDE_TYPES.has(type)
          ? (formatPace(t.fastest, units.distance) || "- - -")
          : "- - -";
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${type}</td><td>${t.distance ? formatDistance(t.distance, units.distance) : "- - -"}</td><td>${formatDuration(t.movingTime)}</td><td>${avg}</td><td>${t.longestDay ? formatDistance(t.longestDay, units.distance) : "- - -"}</td><td>${t.biggestClimb ? formatElevation(t.biggestClimb, units.elevation) : "- - -"}</td><td>${fastest}</td><td>${t.count}</td>`;
        tbody.appendChild(tr);
      });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    wrap.appendChild(tableWrap);
    parent.appendChild(wrap);
  });

  // ---------- consistency & streaks ----------
  function activeDateSet(rows) {
    const set = new Set();
    rows.forEach((r) => { if (r.count > 0) set.add(r.date); });
    return set;
  }

  function streaks(activeDates, today) {
    const dates = Array.from(activeDates).sort();
    let longest = 0;
    let runLength = 0;
    let prev = null;
    dates.forEach((dateStr) => {
      if (prev !== null) {
        const [py, pm, pd] = prev.split("-").map(Number);
        const next = ymd(addDays(new Date(py, pm - 1, pd), 1));
        runLength = next === dateStr ? runLength + 1 : 1;
      } else {
        runLength = 1;
      }
      longest = Math.max(longest, runLength);
      prev = dateStr;
    });

    let current = 0;
    let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (!activeDates.has(ymd(cursor))) cursor = addDays(cursor, -1); // today may still be pending
    while (activeDates.has(ymd(cursor))) {
      current += 1;
      cursor = addDays(cursor, -1);
    }
    return { current, longest };
  }

  FILTERED_RENDERERS.push(function renderConsistency(ctx, parent) {
    const rows = filteredRows(ctx);
    const { today, payload } = ctx;
    const wrap = section("Consistency & streaks", "Within the selected filters");

    const active = activeDateSet(rows);
    const { current, longest } = streaks(active, today);

    // Rest days per week over the filtered span
    let restText = "- - -";
    const sorted = Array.from(active).sort();
    if (sorted.length > 1) {
      const [fy, fm, fd] = sorted[0].split("-").map(Number);
      const [ly, lm, ld] = sorted[sorted.length - 1].split("-").map(Number);
      const spanDays = Math.max(1, Math.round((new Date(ly, lm - 1, ld) - new Date(fy, fm - 1, fd)) / 86400000) + 1);
      const weeks = spanDays / 7;
      restText = `${Math.max(0, 7 - active.size / weeks).toFixed(1)} / week`;
    }

    const grid = el("div", "stats-cards");
    [
      ["Current streak", current ? `${current} day${current === 1 ? "" : "s"}` : "0 days"],
      ["Longest streak", longest ? `${longest} day${longest === 1 ? "" : "s"}` : "0 days"],
      ["Active days", String(active.size)],
      ["Avg rest days", restText],
    ].forEach(([label, value]) => {
      const card = el("div", "stats-card");
      card.appendChild(el("div", "label", label));
      card.appendChild(el("div", "value", value));
      grid.appendChild(card);
    });
    wrap.appendChild(grid);

    // Day-of-week and hour-of-day histograms from the activities list
    const acts = (payload.activities || []).filter((a) => {
      if (ctx.filters.type !== "all" && a.type !== ctx.filters.type) return false;
      if (ctx.filters.year !== "all" && String(a.year) !== ctx.filters.year) return false;
      return true;
    });
    const dow = new Array(7).fill(0);
    const hod = new Array(24).fill(0);
    acts.forEach((a) => {
      const [y, m, d] = String(a.date).split("-").map(Number);
      if (y && m && d) dow[new Date(y, m - 1, d).getDay()] += 1;
      const h = Number(a.hour);
      if (Number.isInteger(h) && h >= 0 && h < 24) hod[h] += 1;
    });

    function miniBars(values, labels) {
      const width = 1040;
      const height = 110;
      const pad = { top: 8, bottom: 22 };
      const innerH = height - pad.top - pad.bottom;
      const max = Math.max(1, ...values);
      const barW = width / values.length;
      let out = "";
      values.forEach((v, i) => {
        const h = (v / max) * innerH;
        out += `<rect x="${(i * barW + 2).toFixed(1)}" y="${(pad.top + innerH - h).toFixed(1)}" width="${(barW - 4).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="#9b5de5" opacity="0.85"><title>${labels[i] || i}: ${v}</title></rect>`;
        out += `<text x="${(i * barW + barW / 2).toFixed(1)}" y="${height - 6}" font-size="10" fill="currentColor" opacity="0.55" text-anchor="middle">${labels[i]}</text>`;
      });
      return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img">${out}</svg>`;
    }

    wrap.appendChild(el("p", "stats-subtitle", "Activities by day of week"));
    const dowChart = el("div", "stats-chart");
    dowChart.innerHTML = miniBars(dow, DAY_NAMES);
    wrap.appendChild(dowChart);

    wrap.appendChild(el("p", "stats-subtitle", "Activities by hour of day"));
    const hourLabels = hod.map((_, i) => (i % 3 === 0 ? String(i) : ""));
    const hodChart = el("div", "stats-chart");
    hodChart.innerHTML = miniBars(hod, hourLabels);
    wrap.appendChild(hodChart);

    parent.appendChild(wrap);
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
