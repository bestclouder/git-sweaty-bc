# Private gate + Stats view — design

Date: 2026-07-17
Repo: bestclouder/git-sweaty-bc (fork of aspain/git-sweaty)
Status: awaiting user approval

## Goal

Two improvements to the self-updating GitHub Pages fitness dashboard:

1. **Private-ish gate:** require a passphrase to view the dashboard. Data is
   encrypted at rest on the public Pages URL, decrypted in-browser. Threat
   model is "keep it out of casual view and search engines with a shared
   passphrase" — NOT per-user auth (explicitly ruled out to stay on pure
   GitHub Pages).
2. **Stats view:** a new tab surfacing statistics from the run/activity data,
   headed by an at-a-glance weekly + monthly comparison strip.

Also: switch the dashboard's display units to metric (km / m).

## Constraints & context

- Hosting stays 100% GitHub Pages + GitHub Actions. No server, no build step,
  vanilla JS frontend (existing `site/app.js` is dependency-free).
- Daily pipeline (`.github/workflows/sync.yml`, cron 15:00 UTC) runs
  `scripts/run_pipeline.py`: sync → normalize → aggregate → generate
  `site/data.json`; publishes generated data to the `dashboard-data` branch;
  `pages.yml` deploys `site/` after each sync.
- `site/data.json` shape: `activities` (list of `{date, hour, type, subtype,
  year}`), `aggregates` (`year → type → date → {count, distance,
  elevation_gain, moving_time, activity_ids}`), plus `types`, `years`,
  `units`, `type_meta`, `generated_at`. Distances/elevations stored in
  meters; `units` only controls display.
- No heart-rate data exists in the pipeline output (stripped during
  normalization).

## Decisions made (with user)

| Decision | Choice |
|---|---|
| Auth strength | Light "private-ish"; stays on GitHub Pages |
| Gate mechanism | **Encrypted at rest** (AES-256-GCM, passphrase-derived key), not a cosmetic overlay |
| Stats placement | New top-level **Heatmaps \| Stats** tab toggle |
| Stats content | Training trends; pace & performance; consistency & streaks |
| Quick-glance header | Weekly + monthly compare strip at top of Stats view |
| Effort metric | **Proxy score** computed from existing data, labeled "estimated"; real HR/suffer-score pipeline extension is a possible follow-up, not in scope |
| Units | Switch whole dashboard to metric (km / m) |

## Part 1 — Encrypted gate

### Principle

Opt-in and transparent. Pipeline encrypts only when a passphrase secret
exists; frontend auto-detects encrypted vs. plaintext payloads. With no
secret configured, behavior is byte-identical to today.

### Pipeline (Python)

- New `scripts/encrypt_data.py`:
  - `encrypt_payload(plaintext_bytes, passphrase) -> envelope dict`
  - Envelope: `{"v": 1, "kdf": "PBKDF2-SHA256", "iter": 200000,
    "salt": <b64 16B>, "iv": <b64 12B>, "ct": <b64 ciphertext+tag>}`
  - PBKDF2-HMAC-SHA256, 200,000 iterations, random 16-byte salt → 256-bit
    key; AES-256-GCM with random 12-byte IV.
  - Uses the `cryptography` package (added to `requirements.txt`).
  - Also provides `decrypt_payload` for tests.
- `run_pipeline.py`: after `generate_heatmaps`, if env
  `DASHBOARD_PASSPHRASE` is non-empty, overwrite `site/data.json` with the
  JSON envelope. Log clearly which mode ran.
- `.github/workflows/sync.yml`: pass
  `DASHBOARD_PASSPHRASE: ${{ secrets.DASHBOARD_PASSPHRASE }}` to the
  pipeline step.

### Frontend (browser)

- New `site/crypto.js`: Web Crypto decrypt mirroring the Python params
  (PBKDF2-SHA256/200k → AES-GCM). Exposes
  `decryptEnvelope(envelope, passphrase) -> object` (throws on bad
  passphrase via GCM auth failure).
- `site/app.js` load path:
  - Fetch `data.json`; if payload has `ct`+`iv`+`salt` → show passphrase
    overlay; on submit decrypt; wrong passphrase → inline error, re-prompt.
  - If payload has `activities` → render directly (plaintext mode, current
    behavior).
- Passphrase cached in `sessionStorage` (cleared when tab closes) so reload
  doesn't re-prompt. A "lock" affordance clears it.
- Overlay styled consistently with the existing dashboard theme; blocks all
  dashboard content until decryption succeeds.

### Known limitation (documented, out of scope)

The `dashboard-data` branch of the public repo still holds plaintext
pipeline state (`data/*.json`). Not linked from the site, but fetchable by
someone who knows to look. Remedy is a one-setting follow-up: make the repo
private — GitHub Pages continues to serve the (now ciphertext-only) site.
README will state this.

## Part 2 — Stats view

### Structure

- Top-level toggle **Heatmaps | Stats** in the existing header. Heatmap view
  unchanged. View choice reflected in the URL hash (`#stats`) so it's
  bookmarkable; default is Heatmaps.
- New isolated module `site/stats.js`: `renderStats(container, data)` plus
  pure computation helpers. Keeps logic out of the 3,300-line `app.js`.
- All computation client-side from decrypted `data.json` — `aggregates` for
  distance/time/elevation, `activities` for date/hour/type.
- Charts: dependency-free inline SVG, matching the repo's zero-build ethos.
- Local filters within the Stats view: year and sport type.

### 2a. Quick-glance comparison header (top of view)

Two rows of stat cards, each metric shown as current value + delta vs the
previous period (▲/▼, green/red):

- **Week row:** rolling last 7 days vs the 7 days before.
- **Month row:** calendar month-to-date vs the same number of days into the
  previous month (fair mid-month comparison).

Cards per row:

| Card | Computation |
|---|---|
| Distance (km) | Σ `distance` / 1000 |
| Active time | Σ `moving_time`, shown `Xh Ym` |
| Avg pace | run-family types (Run/TrailRun/VirtualRun/Walk/Hike): min/km from Σ time / Σ dist; ride-family: km/h. When the period mixes families, the card shows run-family pace if any run-family distance exists (labeled e.g. "runs"), otherwise ride speed; if neither, the card shows a placeholder |
| Activities | Σ `count` |
| Elevation (m) | Σ `elevation_gain` |
| Effort (estimated) | proxy score, see below |

Empty previous period → show value with "no prior data" instead of a
percentage.

**Effort proxy:** per day-type cell,
`effort = moving_time_hours × intensity_factor + elevation_gain / 100`,
where `intensity_factor` = (that cell's pace or speed) relative to the
athlete's trailing 90-day average for that sport, clamped to [0.5, 2.0];
sports without meaningful pace (e.g. WeightTraining) use factor 1.0. Summed
over the period. Displayed as a unitless score with the delta; labeled
"estimated". The formula is a heuristic — the card's purpose is
week-over-week comparability, not physiological accuracy.

### 2b. Training trends

- Weekly distance and moving-time bar/line chart over the selected year
  (per-sport stacked or filtered).
- Monthly totals table with year-over-year context.
- Simple trend indicator (last 4 weeks vs prior 4 weeks).

### 2c. Pace & performance

Per-sport table: total distance, total time, average pace/speed, longest
single day (distance), biggest climbing day, fastest daily pace (min
distance threshold ~2 km to exclude noise).

### 2d. Consistency & streaks

- Current active-day streak, longest streak (all-time and selected year).
- Active days per month (mini bar chart).
- Most-active day-of-week and hour-of-day distributions (from
  `activities[].date` / `.hour`).
- Rest-day pattern: average rest days/week.

## Part 3 — Units switch to metric

- `config.yaml`: `units.distance: "km"`, `units.elevation: "m"`.
- `sync.yml` supports `DASHBOARD_DISTANCE_UNIT`/`DASHBOARD_ELEVATION_UNIT`
  repo variables that override config; user should clear/set them to metric
  if present (README note).
- Frontend already renders from `data.units`; heatmap view follows
  automatically after next sync. Stats view reads `data.units` too (km/m
  primary; mi/ft still supported for upstream users).

## Files

New:
- `scripts/encrypt_data.py`
- `site/crypto.js`
- `site/stats.js`
- `tests/test_encrypt_data.py`

Modified:
- `scripts/run_pipeline.py` (encrypt step)
- `requirements.txt` (`cryptography`)
- `.github/workflows/sync.yml` (pass secret)
- `site/index.html` (tab toggle, overlay markup, script tags)
- `site/app.js` (decrypt-aware load path, view switching)
- `config.yaml` (metric units)
- `README.md` (passphrase setup, stats, privacy limitation note)

## Error handling

- Pipeline: missing/empty passphrase → plaintext mode with a log line;
  encryption failure → hard error (fail the workflow rather than silently
  publishing plaintext when encryption was requested).
- Frontend: fetch failure → existing error path; malformed envelope →
  explicit "data corrupted" message; wrong passphrase → inline retry;
  Web Crypto unavailable (non-HTTPS/legacy) → clear message (GitHub Pages
  is HTTPS, so this is edge-case only).
- Stats: empty periods and division-by-zero (pace with 0 distance) guarded;
  cards render placeholders rather than NaN.

## Testing

- `tests/test_encrypt_data.py`: envelope shape; round-trip encrypt/decrypt;
  wrong passphrase raises; unique salt/IV per run. This locks the format the
  browser depends on.
- Stats helpers written as pure functions; tested via a small Node-free
  approach: computation functions kept deterministic and exercised in the
  browser during E2E (no JS test runner exists in this repo; adding one is
  out of scope).
- E2E before shipping: serve `site/` locally with a test-encrypted
  `data.json` (known passphrase); verify in browser: wrong passphrase
  rejected, correct passphrase decrypts, both views render, quick-glance
  deltas correct against hand-computed values from fixture data; screenshots
  shared with user.

## Deployment

1. Commit + push all changes to `main` of `bestclouder/git-sweaty-bc`.
2. User adds repo secret `DASHBOARD_PASSPHRASE` (strong passphrase).
3. Re-run the **Sync Heatmaps** workflow → encrypted `data.json` published;
   Pages redeploys automatically.
4. Until the secret is added, the site keeps working exactly as today
   (plaintext), so deployment is safe to stage.

## Out of scope (explicit)

- Real per-user authentication (Cloudflare Access / serverless gate).
- Heart-rate / suffer-score pipeline extension (possible follow-up; would
  need a full-backfill re-fetch).
- Making the repo private (one-click user action, documented in README).
- Upstream contribution; this targets the fork.
