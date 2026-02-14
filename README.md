# Workout --> GitHub Heatmap Dashboard

Turn your Strava and Garmin activities into GitHub-style contribution heatmaps.  
Automatically generates a free, interactive dashboard updated daily on GitHub Pages.  
**No coding required.**  

- View the Interactive [Activity Dashboard](https://bestclouder.github.io/git-sweaty-bc/)
- Once setup is complete, this dashboard link will automatically update to your own GitHub Pages URL.


![Dashboard Preview](site/readme-preview-20260213.png)

## Quick Start

### Option 1 (Recommended): Run the setup script

Fastest path: fork, run one script, and let it configure the repository for you.

1. Fork this repo: [Fork this repository](../../fork)
2. Clone your fork and enter it:

   ```bash
   git clone https://github.com/<your-username>/<repo-name>.git
   cd <repo-name>
   ```
3. Sign in to GitHub CLI:

   ```bash
   gh auth login
   ```

4. Run setup:

   ```bash
   python3 scripts/setup_auth.py
   ```

   Follow the terminal prompts to choose a source and unit preference:
      - `strava` - terminal will link to [Strava API application](https://www.strava.com/settings/api). Create an application first and set **Authorization Callback Domain** to `localhost`. The prompt will then ask for `Client ID` and `Client Secret`
      - `garmin` - terminal prompts for Garmin email/password
      - unit preference (`US` or `Metric`)

   The setup may take several minutes to complete when run for the first time. If any automation step fails, the script prints steps to remedy the failed step.  
   Once the script succeeds, it will provide the URL for your dashboard.


### Option 2: Manual setup (no local clone required)

1. Fork this repo to your account: [Fork this repository](../../fork)

2. Add `DASHBOARD_SOURCE` repo variable (repo → [Settings → Secrets and variables → Actions](../../settings/variables/actions)):
   - `DASHBOARD_SOURCE` = `strava` or `garmin`

3. Add source-specific GitHub secrets (repo → [Settings → Secrets and variables → Actions](../../settings/secrets/actions)):
   - For `garmin`:
      - Preferred: `GARMIN_TOKENS_B64`
      - Fallback: `GARMIN_EMAIL` and `GARMIN_PASSWORD`
   - For `strava`:
      - Step 1: Create a [Strava API application](https://www.strava.com/settings/api). Set **Authorization Callback Domain** to `localhost`, then copy:
         - `Client ID`
         - `Client Secret`

      - Step 2: Generate a **refresh token** via OAuth (the token shown on the Strava API page often does **not** work).
         - Open this URL in your browser (replace CLIENT_ID with the Client ID value from your Strava API application page):

            ```text
            https://www.strava.com/oauth/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=http://localhost/exchange_token&approval_prompt=force&scope=read,activity:read_all
            ```

         - **Note:** After approval you’ll be redirected to a `localhost` URL that won’t load. That’s expected.
           Example redirect URL:

            ```text
            http://localhost/exchange_token?state=&code=12345&scope=read,activity:read_all
            ```

         - Copy the `code` value from the redirect URL and exchange it:

            ```bash
            curl -X POST https://www.strava.com/oauth/token \
              -d client_id=CLIENT_ID_FROM_STRAVA_API_APP \
              -d client_secret=CLIENT_SECRET_FROM_STRAVA_API_APP \
              -d code=CODE_FROM_THE_REDIRECT_URL \
              -d grant_type=authorization_code
            ```

         - Copy `refresh_token` from the response.

      - Step 3: Add these secrets:
         - `STRAVA_CLIENT_ID` = Client ID from step 1
         - `STRAVA_CLIENT_SECRET` = Client Secret from step 1
         - `STRAVA_REFRESH_TOKEN` = refresh token from step 2

4. Enable GitHub Pages (repo → [Settings → Pages](../../settings/pages)):
   - Under **Build and deployment**, set **Source** to **GitHub Actions**.

5. Run [Sync Heatmaps](../../actions/workflows/sync.yml):
   - If GitHub shows an **Enable workflows** button in [Actions](../../actions), click it first.
   - Go to [Actions](../../actions) → [Sync Heatmaps](../../actions/workflows/sync.yml) → **Run workflow**.
   - Optional: override the source in `workflow_dispatch` input.
   - The same workflow is also scheduled in `.github/workflows/sync.yml` (daily at `15:00 UTC`).

6. Open your live site at `https://<your-username>.github.io/<repo-name>/` after deploy finishes.

## Updating Your Repository

- To pull in new updates and features from the original repo, use GitHub's **Sync fork** button on your fork's `main` branch.
- Activity data is stored on a dedicated `dashboard-data` branch and deployed from there
- `main` is intentionally kept free of generated `data/` and `site/data.json` artifacts so fork sync process stays cleaner.
- After syncing, manually run [Sync Heatmaps](../../actions/workflows/sync.yml) if you want your dashboard refreshed immediately. Otherwise updates will deploy at the next scheduled run.

### Switching Sources Later

You can switch between `strava` and `garmin` any time, even after initial setup.

- Re-run `python3 scripts/setup_auth.py` and choose a different source (or pass `--source strava` / `--source garmin`).

## Configuration (Optional)

Everything in this section is optional. Defaults work without changes.
Base settings live in `config.yaml`.

Key options:
- `source` (`strava` or `garmin`)
- `garmin.strict_token_only` (when `true`, requires `garmin.token_store_b64` and disables email/password fallback auth in pipeline runs)
- `sync.start_date` (optional `YYYY-MM-DD` lower bound for history)
- `sync.lookback_years` (optional rolling lower bound; used only when `sync.start_date` is unset)
- `sync.recent_days` (sync recent activities even while backfilling)
- `sync.resume_backfill` (persist cursor to continue older pages across days)
- `sync.prune_deleted` (remove local activities no longer returned by the selected source in the current sync scope)
- `activities.types` (featured/allowed activity types shown first in UI; key name is historical)
- `activities.include_all_types` (when `true`, include all seen sport types; when `false`, include only `activities.types`)
- `activities.exclude_types` (optional `SportType` names to exclude without disabling inclusion of future new types)
- `activities.group_other_types` (when `true`, allow non-Strava grouping buckets like `WaterSports`; default `false`)
- `activities.other_bucket` (fallback group name when no smart match is found)
- `activities.group_aliases` (optional explicit map of a raw/canonical type to a group)
- `activities.type_aliases` (optional map from raw source `sport_type`/`type` values to canonical names)
- `units.distance` (`mi` or `km`)
- `units.elevation` (`ft` or `m`)
- `rate_limits.*` (Strava API throttling caps; ignored for Garmin)

## Notes

- Raw activities are stored locally for processing but are not committed (`activities/raw/` is ignored). This prevents publishing detailed per-activity payloads and GPS location traces.
- If neither `sync.start_date` nor `sync.lookback_years` is set, the sync workflow backfills all available history from the selected source (i.e. Strava/Garmin).
- Strava backfill state is stored in `data/backfill_state_strava.json`; Garmin backfill state is stored in `data/backfill_state_garmin.json`. If a backfill hits API limits (unlikely), this state allows the daily refresh automation to pick back up where it left off.
- The Sync action workflow includes a toggle labeled `Reset backfill cursor and re-fetch full history for the selected source` which forces a one-time full backfill. This is useful if you add/delete/modify activities which have already been loaded.
- The GitHub Pages site is optimized for responsive desktop/mobile viewing.
- If a day contains multiple activity types, that day’s colored square is split into equal segments — one per unique activity type on that day.
