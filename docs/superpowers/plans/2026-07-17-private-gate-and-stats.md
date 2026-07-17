# Private Gate + Stats View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encrypt the published dashboard data behind a passphrase (AES-256-GCM, decrypted in-browser) and add a Stats tab with weekly/monthly quick-compare cards, trends, pace tables, and streaks.

**Architecture:** The daily GitHub Actions pipeline gains an optional final step that encrypts `site/data.json` when a `DASHBOARD_PASSPHRASE` secret exists. The vanilla-JS frontend auto-detects the encrypted envelope, prompts for the passphrase, and decrypts via Web Crypto. A new `site/stats.js` module renders a Stats view computed entirely client-side from the decrypted payload.

**Tech Stack:** Python 3.11 (`cryptography` package), vanilla JS (Web Crypto API, inline SVG), GitHub Actions, GitHub Pages. No build step, no JS dependencies.

**Spec:** `docs/superpowers/specs/2026-07-17-private-gate-and-stats-design.md`

## Global Constraints

- Envelope format (locked, browser+Python must match): `{"v": 1, "kdf": "PBKDF2-SHA256", "iter": 200000, "salt": <b64 16B>, "iv": <b64 12B>, "ct": <b64 ciphertext+GCM tag>}`
- KDF: PBKDF2-HMAC-SHA256, 200,000 iterations, 256-bit key. Cipher: AES-256-GCM, 12-byte IV.
- No passphrase secret → byte-identical plaintext behavior to today.
- Python tests use `unittest` style with the `sys.path.insert` header, matching `tests/test_garmin_token_store.py`.
- Repo working dir: `/private/tmp/claude-501/-Users-vincentteh-mekiki/4ee49c28-78bb-49b7-a169-6a1e79b6a9b3/scratchpad/git-sweaty-bc`. Git identity already configured (bestclouder).
- Commit after each task. Do not push until the final task.
- Distances/elevations in `data.json` are meters; `units` field only controls display.

---

### Task 1: Python encryption module

**Files:**
- Create: `scripts/encrypt_data.py`
- Create: `tests/test_encrypt_data.py`
- Modify: `requirements.txt`

**Interfaces:**
- Produces: `encrypt_payload(plaintext: bytes, passphrase: str) -> dict`, `decrypt_payload(envelope: dict, passphrase: str) -> bytes`, `encrypt_file_in_place(path: str, passphrase: str) -> None` (used by Task 2).

- [ ] **Step 1: Add dependency**

Append to `requirements.txt`:

```
cryptography>=42.0.0
```

Run: `pip3 install "cryptography>=42.0.0"` (needed locally to run tests). Expected: installs or already satisfied.

- [ ] **Step 2: Write the failing test**

Create `tests/test_encrypt_data.py`:

```python
import base64
import json
import os
import sys
import tempfile
import unittest


ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPTS_DIR = os.path.join(ROOT_DIR, "scripts")
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

from encrypt_data import (  # noqa: E402
    decrypt_payload,
    encrypt_file_in_place,
    encrypt_payload,
)


class EncryptDataTests(unittest.TestCase):
    def test_envelope_shape(self):
        envelope = encrypt_payload(b'{"a":1}', "hunter2")
        self.assertEqual(envelope["v"], 1)
        self.assertEqual(envelope["kdf"], "PBKDF2-SHA256")
        self.assertEqual(envelope["iter"], 200000)
        self.assertEqual(len(base64.b64decode(envelope["salt"])), 16)
        self.assertEqual(len(base64.b64decode(envelope["iv"])), 12)
        # ciphertext = plaintext length + 16-byte GCM tag
        self.assertEqual(len(base64.b64decode(envelope["ct"])), len(b'{"a":1}') + 16)

    def test_round_trip(self):
        plaintext = json.dumps({"activities": [1, 2, 3], "units": {"distance": "km"}}).encode("utf-8")
        envelope = encrypt_payload(plaintext, "correct horse battery staple")
        self.assertEqual(decrypt_payload(envelope, "correct horse battery staple"), plaintext)

    def test_wrong_passphrase_raises(self):
        envelope = encrypt_payload(b"secret", "right")
        with self.assertRaises(Exception):
            decrypt_payload(envelope, "wrong")

    def test_unique_salt_and_iv_per_call(self):
        e1 = encrypt_payload(b"same", "pw")
        e2 = encrypt_payload(b"same", "pw")
        self.assertNotEqual(e1["salt"], e2["salt"])
        self.assertNotEqual(e1["iv"], e2["iv"])
        self.assertNotEqual(e1["ct"], e2["ct"])

    def test_encrypt_file_in_place(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "data.json")
            original = {"activities": [], "years": [2026]}
            with open(path, "w", encoding="utf-8") as f:
                json.dump(original, f)
            encrypt_file_in_place(path, "pw123")
            with open(path, "r", encoding="utf-8") as f:
                envelope = json.load(f)
            self.assertIn("ct", envelope)
            self.assertNotIn("activities", envelope)
            restored = json.loads(decrypt_payload(envelope, "pw123"))
            self.assertEqual(restored, original)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python3 -m unittest tests.test_encrypt_data -v`
Expected: FAIL/ERROR with `ModuleNotFoundError: No module named 'encrypt_data'`

- [ ] **Step 4: Write the implementation**

Create `scripts/encrypt_data.py`:

```python
"""Encrypt site/data.json with a passphrase-derived AES-256-GCM key.

Envelope format (version 1) — mirrored by site/crypto.js in the browser:
    {
      "v": 1,
      "kdf": "PBKDF2-SHA256",
      "iter": 200000,
      "salt": "<base64, 16 bytes>",
      "iv": "<base64, 12 bytes>",
      "ct": "<base64, ciphertext + 16-byte GCM tag>"
    }
"""

import base64
import json
import os

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ENVELOPE_VERSION = 1
KDF_NAME = "PBKDF2-SHA256"
ITERATIONS = 200_000
SALT_BYTES = 16
IV_BYTES = 12
KEY_BYTES = 32


def _derive_key(passphrase: str, salt: bytes, iterations: int = ITERATIONS) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_BYTES,
        salt=salt,
        iterations=iterations,
    )
    return kdf.derive(passphrase.encode("utf-8"))


def encrypt_payload(plaintext: bytes, passphrase: str) -> dict:
    if not passphrase:
        raise ValueError("Passphrase must be non-empty.")
    salt = os.urandom(SALT_BYTES)
    iv = os.urandom(IV_BYTES)
    key = _derive_key(passphrase, salt)
    ct = AESGCM(key).encrypt(iv, plaintext, None)
    return {
        "v": ENVELOPE_VERSION,
        "kdf": KDF_NAME,
        "iter": ITERATIONS,
        "salt": base64.b64encode(salt).decode("ascii"),
        "iv": base64.b64encode(iv).decode("ascii"),
        "ct": base64.b64encode(ct).decode("ascii"),
    }


def decrypt_payload(envelope: dict, passphrase: str) -> bytes:
    salt = base64.b64decode(envelope["salt"])
    iv = base64.b64decode(envelope["iv"])
    ct = base64.b64decode(envelope["ct"])
    key = _derive_key(passphrase, salt, int(envelope.get("iter", ITERATIONS)))
    return AESGCM(key).decrypt(iv, ct, None)


def encrypt_file_in_place(path: str, passphrase: str) -> None:
    with open(path, "rb") as f:
        plaintext = f.read()
    envelope = encrypt_payload(plaintext, passphrase)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(envelope, f, separators=(",", ":"))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 -m unittest tests.test_encrypt_data -v`
Expected: 5 tests, all PASS (`OK`).

Also run existing tests to confirm no regression: `python3 -m unittest discover tests -v`
Expected: all PASS. (Note: `tests/test_sync_strava_auth.py` requires `requests`; `pip3 install -r requirements.txt` first if needed.)

- [ ] **Step 6: Commit**

```bash
git add scripts/encrypt_data.py tests/test_encrypt_data.py requirements.txt
git commit -m "feat: passphrase encryption module for dashboard data"
```

---

### Task 2: Pipeline + workflow integration

**Files:**
- Modify: `scripts/run_pipeline.py` (imports block at top; end of `run_pipeline()` around line 195)
- Modify: `.github/workflows/sync.yml` ("Run pipeline" step env)

**Interfaces:**
- Consumes: `encrypt_file_in_place(path, passphrase)` from Task 1.
- Produces: pipeline behavior — `site/data.json` becomes an envelope when env `DASHBOARD_PASSPHRASE` is non-empty.

- [ ] **Step 1: Add encryption step to run_pipeline.py**

In `scripts/run_pipeline.py`, add to the imports block:

```python
from encrypt_data import encrypt_file_in_place
```

At the end of `run_pipeline()`, immediately after the `generate_heatmaps(write_svgs=False)` line and before `if not dry_run:`, insert:

```python
    passphrase = os.environ.get("DASHBOARD_PASSPHRASE", "").strip()
    if passphrase:
        encrypt_file_in_place(os.path.join("site", "data.json"), passphrase)
        print("Encrypted site/data.json (DASHBOARD_PASSPHRASE configured).")
    else:
        print("DASHBOARD_PASSPHRASE not set; publishing plaintext site/data.json.")
```

(Encryption failures raise and fail the workflow — intentional: never silently publish plaintext when encryption was requested.)

- [ ] **Step 2: Verify locally**

`run_pipeline.py` supports `--skip-sync` (see `main()` at `scripts/run_pipeline.py:200`). Run the real pipeline tail with encryption enabled, then verify round-trip and restore:

```bash
DASHBOARD_PASSPHRASE=local-test python3 scripts/run_pipeline.py --skip-sync
python3 -c "
import sys, json; sys.path.insert(0, 'scripts')
from encrypt_data import decrypt_payload
env = json.load(open('site/data.json'))
assert 'ct' in env and 'activities' not in env, 'expected envelope'
data = json.loads(decrypt_payload(env, 'local-test'))
assert 'activities' in data
print('round-trip OK,', len(data['activities']), 'activities')
"
git checkout -- site/data.json data/ README.md 2>/dev/null; git status --short
```

Expected: pipeline logs `Encrypted site/data.json (DASHBOARD_PASSPHRASE configured).`; then `round-trip OK, 1364 activities`; then `git status --short` shows no changes under `site/` or `data/`.

- [ ] **Step 3: Pass the secret through the workflow**

In `.github/workflows/sync.yml`, find the "Run pipeline" step and add the secret to its `env`:

```yaml
      - name: Run pipeline
        env:
          UPDATE_README_LINK: ${{ github.event_name != 'workflow_dispatch' || inputs.update_readme_link }}
          DASHBOARD_PASSPHRASE: ${{ secrets.DASHBOARD_PASSPHRASE }}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/run_pipeline.py .github/workflows/sync.yml
git commit -m "feat: encrypt published data.json when DASHBOARD_PASSPHRASE secret is set"
```

---

### Task 3: Frontend decrypt gate

**Files:**
- Create: `site/crypto.js`
- Modify: `site/index.html` (overlay markup + lock button before `</body>`; script tags; CSS before `</style>`)
- Modify: `site/app.js` (`init()` at line 2211: replace fetch block with envelope-aware loader)

**Interfaces:**
- Consumes: envelope format from Task 1.
- Produces: `window.SweatyCrypto = { isEnvelope(obj), decryptEnvelope(env, passphrase) -> Promise<object> }`; `init()` obtains the payload via `resolvePayload()`.

- [ ] **Step 1: Write site/crypto.js**

```javascript
"use strict";

// Mirrors scripts/encrypt_data.py envelope format (v1):
// PBKDF2-SHA256 (200k iters) -> AES-256-GCM.
window.SweatyCrypto = (function () {
  function isEnvelope(payload) {
    return Boolean(
      payload &&
        typeof payload === "object" &&
        typeof payload.ct === "string" &&
        typeof payload.iv === "string" &&
        typeof payload.salt === "string",
    );
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }

  async function decryptEnvelope(envelope, passphrase) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("This browser does not support Web Crypto; cannot decrypt the dashboard.");
    }
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: b64ToBytes(envelope.salt),
        iterations: Number(envelope.iter) || 200000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(envelope.iv) },
      key,
      b64ToBytes(envelope.ct),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  return { isEnvelope, decryptEnvelope };
})();
```

- [ ] **Step 2: Add overlay markup and script tag to index.html**

In `site/index.html`, replace the single script line (`<script src="app.js?v=__APP_VERSION__"></script>`) with:

```html
    <div id="lockOverlay" class="lock-overlay" hidden>
      <form id="lockForm" class="lock-card">
        <h2 class="lock-title">Private dashboard</h2>
        <p class="lock-text">Enter the passphrase to unlock.</p>
        <input type="password" id="lockInput" class="lock-input" autocomplete="current-password" autofocus />
        <button type="submit" class="lock-button">Unlock</button>
        <div id="lockError" class="lock-error" role="alert"></div>
      </form>
    </div>

    <script src="crypto.js?v=__APP_VERSION__"></script>
    <script src="stats.js?v=__APP_VERSION__"></script>
    <script src="app.js?v=__APP_VERSION__"></script>
```

(`stats.js` is created in Task 4; a temporary empty file is added in Step 5 of this task so nothing 404s meanwhile.)

- [ ] **Step 3: Add gate CSS to index.html**

Insert before the closing `</style>` tag:

```css
      .lock-overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(4, 6, 12, 0.96);
      }
      .lock-card {
        display: flex;
        flex-direction: column;
        gap: 12px;
        width: min(340px, calc(100vw - 48px));
        padding: 28px;
        border: 1px solid #2b3245;
        border-radius: 12px;
        background: #10141f;
        text-align: center;
      }
      .lock-title { margin: 0; font-size: 20px; }
      .lock-text { margin: 0; opacity: 0.75; font-size: 14px; }
      .lock-input {
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid #2b3245;
        background: #0a0d15;
        color: inherit;
        font-size: 15px;
      }
      .lock-button {
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid #2b3245;
        background: #1d2434;
        color: inherit;
        font-size: 15px;
        cursor: pointer;
      }
      .lock-button:hover { background: #273049; }
      .lock-error { min-height: 18px; color: #ff6b81; font-size: 13px; }
      .lock-link {
        background: none;
        border: none;
        color: inherit;
        opacity: 0.6;
        cursor: pointer;
        font-size: 12px;
        text-decoration: underline;
        padding: 0;
      }
      .lock-link:hover { opacity: 1; }
```

- [ ] **Step 4: Make app.js envelope-aware**

In `site/app.js`, replace the top of `init()` (lines 2211–2220):

```javascript
async function init() {
  syncRepoLink();
  const resp = await fetch("data.json");
  if (!resp.ok) {
    throw new Error(`Failed to load data.json (${resp.status})`);
  }
  const payload = await resp.json();
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid dashboard data format.");
  }
```

with:

```javascript
const PASSPHRASE_STORAGE_KEY = "dashboardPassphrase";

function promptForPassphrase(envelope) {
  const overlay = document.getElementById("lockOverlay");
  const form = document.getElementById("lockForm");
  const input = document.getElementById("lockInput");
  const errorEl = document.getElementById("lockError");
  overlay.hidden = false;
  input.focus();
  return new Promise((resolve) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const passphrase = input.value;
      if (!passphrase) return;
      errorEl.textContent = "";
      try {
        const data = await SweatyCrypto.decryptEnvelope(envelope, passphrase);
        try {
          sessionStorage.setItem(PASSPHRASE_STORAGE_KEY, passphrase);
        } catch (storageError) {
          // Private browsing may block sessionStorage; unlock still works for this page view.
        }
        overlay.hidden = true;
        resolve(data);
      } catch (error) {
        input.value = "";
        input.focus();
        errorEl.textContent = "Wrong passphrase. Try again.";
      }
    });
  });
}

function addLockControl() {
  const header = document.querySelector(".header-top");
  if (!header || document.getElementById("lockControl")) return;
  const lock = document.createElement("button");
  lock.type = "button";
  lock.id = "lockControl";
  lock.className = "lock-link";
  lock.textContent = "Lock dashboard";
  lock.addEventListener("click", () => {
    try {
      sessionStorage.removeItem(PASSPHRASE_STORAGE_KEY);
    } catch (storageError) {
      // ignore
    }
    window.location.reload();
  });
  header.appendChild(lock);
}

async function resolvePayload() {
  const resp = await fetch("data.json");
  if (!resp.ok) {
    throw new Error(`Failed to load data.json (${resp.status})`);
  }
  const raw = await resp.json();
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid dashboard data format.");
  }
  if (!window.SweatyCrypto || !SweatyCrypto.isEnvelope(raw)) {
    return raw;
  }
  let cached = null;
  try {
    cached = sessionStorage.getItem(PASSPHRASE_STORAGE_KEY);
  } catch (storageError) {
    cached = null;
  }
  if (cached) {
    try {
      const data = await SweatyCrypto.decryptEnvelope(raw, cached);
      addLockControl();
      return data;
    } catch (error) {
      try {
        sessionStorage.removeItem(PASSPHRASE_STORAGE_KEY);
      } catch (storageError) {
        // ignore
      }
    }
  }
  const data = await promptForPassphrase(raw);
  addLockControl();
  return data;
}

async function init() {
  syncRepoLink();
  const payload = await resolvePayload();
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.activities)) {
    throw new Error("Invalid dashboard data format.");
  }
```

- [ ] **Step 5: Placeholder stats.js so the script tag resolves**

```bash
echo '"use strict";' > site/stats.js
```

- [ ] **Step 6: Verify in browser (plaintext mode unchanged)**

Serve: `cd site && python3 -m http.server 8123` (background). Open `http://localhost:8123` in the Browser pane. Expected: dashboard renders exactly as before (plaintext data.json → no overlay). Check console for errors.

- [ ] **Step 7: Verify in browser (encrypted mode)**

```bash
mkdir -p /tmp/sweaty-e2e && cp -R site/* /tmp/sweaty-e2e/
python3 -c "
import sys; sys.path.insert(0, 'scripts')
from encrypt_data import encrypt_file_in_place
encrypt_file_in_place('/tmp/sweaty-e2e/data.json', 'test-passphrase')
print('encrypted fixture ready')
"
```

Serve `/tmp/sweaty-e2e` on another port, open it, and verify: overlay appears; wrong passphrase → "Wrong passphrase. Try again."; `test-passphrase` → dashboard renders; reload → no re-prompt (sessionStorage); "Lock dashboard" → overlay returns.

- [ ] **Step 8: Commit**

```bash
git add site/crypto.js site/stats.js site/index.html site/app.js
git commit -m "feat: passphrase gate with in-browser AES-GCM decryption"
```

---

### Task 4: Stats view shell — tab toggle + data shaping

**Files:**
- Modify: `site/index.html` (view toggle markup after `<h1>`; stats container after `#heatmaps`; CSS)
- Modify: `site/app.js` (view switching at end of `init()`)
- Modify: `site/stats.js` (module skeleton: flatten/format/date helpers + filters + section scaffolding)

**Interfaces:**
- Produces: `window.SweatyStats = { renderStats(container, payload) }`; internal helpers `flattenAggregates(payload)` → `[{date, type, count, distance, elevation, movingTime}]`, `ymd(date)`, `addDays(date, n)`, `formatDistance/formatDuration/formatPace/formatSpeed/formatElevation`, family constants `RUN_TYPES`/`RIDE_TYPES`. Tasks 5–6 add render sections to this module.

- [ ] **Step 1: Add toggle + container markup**

In `site/index.html`, directly after `<h1 id="dashboardTitle">Activity Heatmaps</h1>` insert:

```html
          <div class="view-toggle" id="viewToggle">
            <button type="button" class="view-toggle-button active" data-view="heatmaps">Heatmaps</button>
            <button type="button" class="view-toggle-button" data-view="stats">Stats</button>
          </div>
```

After `<div id="heatmaps" class="heatmaps"></div>` insert:

```html
      <div id="statsView" class="stats-view" hidden></div>
```

- [ ] **Step 2: Add view CSS**

Before `</style>`:

```css
      .view-toggle {
        display: flex;
        justify-content: center;
        gap: 8px;
        margin: 10px 0 4px;
      }
      .view-toggle-button {
        padding: 7px 22px;
        border-radius: 999px;
        border: 1px solid #2b3245;
        background: transparent;
        color: inherit;
        opacity: 0.65;
        font-size: 14px;
        cursor: pointer;
      }
      .view-toggle-button.active {
        opacity: 1;
        background: #1d2434;
        border-color: #3d4763;
      }
      body.stats-mode #summary,
      body.stats-mode #heatmaps,
      body.stats-mode #typeButtons,
      body.stats-mode #yearButtons,
      body.stats-mode #resetAllRow,
      body.stats-mode .controls {
        display: none !important;
      }
      .stats-view {
        display: flex;
        flex-direction: column;
        gap: 22px;
        max-width: 1120px;
        margin: 0 auto;
        padding: 8px 4px 40px;
      }
      .stats-section {
        border: 1px solid #232a3d;
        border-radius: 12px;
        background: #0e1220;
        padding: 18px 20px;
      }
      .stats-section h2 {
        margin: 0 0 4px;
        font-size: 16px;
        letter-spacing: 0.02em;
      }
      .stats-section .stats-subtitle {
        margin: 0 0 14px;
        font-size: 12.5px;
        opacity: 0.6;
      }
      .stats-cards {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 12px;
      }
      .stats-card {
        border: 1px solid #232a3d;
        border-radius: 10px;
        padding: 12px 14px;
        background: #111627;
      }
      .stats-card .label { font-size: 12px; opacity: 0.6; }
      .stats-card .value { font-size: 21px; font-weight: 600; margin: 4px 0 2px; }
      .stats-card .delta { font-size: 12.5px; }
      .delta-up { color: #3ddc84; }
      .delta-down { color: #ff6b81; }
      .delta-flat { opacity: 0.55; }
      .stats-filters { display: flex; gap: 10px; flex-wrap: wrap; }
      .stats-filters select {
        padding: 7px 10px;
        border-radius: 8px;
        border: 1px solid #2b3245;
        background: #10141f;
        color: inherit;
        font-size: 13.5px;
      }
      .stats-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
      .stats-table th, .stats-table td {
        text-align: right;
        padding: 7px 10px;
        border-bottom: 1px solid #1c2333;
        white-space: nowrap;
      }
      .stats-table th:first-child, .stats-table td:first-child { text-align: left; }
      .stats-table th { opacity: 0.6; font-weight: 500; }
      .stats-table-wrap { overflow-x: auto; }
      .stats-chart svg { width: 100%; height: auto; display: block; }
```

- [ ] **Step 3: Wire view switching in app.js**

At the end of `init()` in `site/app.js` (just before the closing `}` of the function, after the existing resize/scroll listeners), add:

```javascript
  setupViewToggle(payload);
```

And add this function at module level (near `addLockControl`):

```javascript
function setupViewToggle(payload) {
  const toggle = document.getElementById("viewToggle");
  const statsView = document.getElementById("statsView");
  if (!toggle || !statsView) return;
  let statsRendered = false;

  function activate(view) {
    document.body.classList.toggle("stats-mode", view === "stats");
    statsView.hidden = view !== "stats";
    toggle.querySelectorAll(".view-toggle-button").forEach((button) => {
      button.classList.toggle("active", button.dataset.view === view);
    });
    if (view === "stats" && !statsRendered && window.SweatyStats) {
      SweatyStats.renderStats(statsView, payload);
      statsRendered = true;
    }
    const targetHash = view === "stats" ? "#stats" : "";
    if (window.location.hash !== targetHash) {
      history.replaceState(null, "", window.location.pathname + window.location.search + targetHash);
    }
  }

  toggle.querySelectorAll(".view-toggle-button").forEach((button) => {
    button.addEventListener("click", () => activate(button.dataset.view));
  });

  activate(window.location.hash === "#stats" ? "stats" : "heatmaps");
}
```

- [ ] **Step 4: Write the stats.js skeleton**

Replace `site/stats.js` entirely:

```javascript
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

  function renderStats(container, payload) {
    container.innerHTML = "";
    const rows = flattenAggregates(payload);
    const units = {
      distance: (payload.units && payload.units.distance) || "km",
      elevation: (payload.units && payload.units.elevation) || "m",
    };
    const today = new Date();
    const ctx = { payload, rows, units, today, container, filters: { year: "all", type: "all" } };
    SECTION_RENDERERS.forEach((render) => render(ctx));
  }

  return {
    renderStats,
    _internal: {
      RUN_TYPES, RIDE_TYPES, MONTH_NAMES, DAY_NAMES, SECTION_RENDERERS,
      ymd, addDays, flattenAggregates, sumRows, el, section,
      distanceValue, formatDistance, formatDuration, formatPace, formatSpeed, formatElevation, elevationValue,
    },
  };
})();
```

- [ ] **Step 5: Verify in browser**

Reload `http://localhost:8123`. Expected: "Heatmaps | Stats" toggle appears under the title; clicking Stats hides the heatmap/summary/filters and shows an empty stats area; URL hash becomes `#stats`; loading the page with `#stats` starts on Stats; no console errors.

- [ ] **Step 6: Commit**

```bash
git add site/index.html site/app.js site/stats.js
git commit -m "feat: stats view shell with Heatmaps|Stats toggle"
```

---

### Task 5: Quick-glance comparison header

**Files:**
- Modify: `site/stats.js` (add the "Right now" section renderer)

**Interfaces:**
- Consumes: `_internal` helpers from Task 4 (`ymd`, `addDays`, `sumRows`, `el`, `section`, formatters, `SECTION_RENDERERS`).
- Produces: the first Stats section — two card rows (week vs last week, month-to-date vs last month) including the estimated effort score.

- [ ] **Step 1: Add the compare-header renderer**

In `site/stats.js`, insert after the `SECTION_RENDERERS` declaration (before `renderStats`):

```javascript
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
      return { kind: "run", value: secPerUnit, text: `${formatPace(secPerUnit, units.distance)}` };
    }
    if (sums.rideDistance > 0 && sums.rideTime > 0) {
      const speed = sums.rideDistance / sums.rideTime;
      return { kind: "ride", value: -speed, text: formatSpeed(speed, units.distance) };
      // negative so "lower is better" comparison logic also works for speed
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
```

- [ ] **Step 2: Verify in browser with hand-checked values**

Reload, open Stats. Pick the current 7-day window; independently compute expected distance with:

```bash
python3 -c "
import json, datetime
d = json.load(open('site/data.json'))
today = datetime.date.today()
cur = [str(today - datetime.timedelta(days=i)) for i in range(7)]
total = 0
for year, types in d['aggregates'].items():
    for t, days in types.items():
        for day, cell in days.items():
            if day in cur:
                total += cell['distance']
print('expected current-week meters:', total)
"
```

Expected: the "Distance" card in the This-week row matches (converted to display units). Spot-check the Activities count the same way.

- [ ] **Step 3: Commit**

```bash
git add site/stats.js
git commit -m "feat: weekly and monthly quick-compare stat cards with estimated effort"
```

---

### Task 6: Trends, pace & performance, consistency sections

**Files:**
- Modify: `site/stats.js` (filters + three section renderers)

**Interfaces:**
- Consumes: `_internal` helpers and `SECTION_RENDERERS` from Task 4.
- Produces: filter controls (year/sport selects) plus Training Trends (weekly SVG chart, monthly table, 4-week trend), Pace & Performance (per-sport table), Consistency & Streaks (streaks, active days, day-of-week and hour histograms).

- [ ] **Step 1: Add filter controls and filtered-sections re-render**

In `site/stats.js`, replace the `renderStats` function with:

```javascript
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
```

And add next to `SECTION_RENDERERS`:

```javascript
  const FILTERED_RENDERERS = [];

  function filteredRows(ctx) {
    return ctx.rows.filter((r) => {
      if (ctx.filters.type !== "all" && r.type !== ctx.filters.type) return false;
      if (ctx.filters.year !== "all" && !r.date.startsWith(ctx.filters.year + "-")) return false;
      return true;
    });
  }
```

- [ ] **Step 2: Add the Training Trends renderer**

Append inside the module (after the quick-glance renderer):

```javascript
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
    for (let m = 0; m < 12; m += 1) {
      const mm = String(m + 1).padStart(2, "0");
      const from = `${year}-${mm}-01`;
      const to = `${year}-${mm}-31`;
      const cur = sumRows(rows, from, to);
      const prev = sumRows(rows, `${prevYear}-${mm}-01`, `${prevYear}-${mm}-31`);
      if (cur.count === 0 && prev.count === 0) continue;
      const activeDays = new Set(rows.filter((r) => r.date >= from && r.date <= to && r.count > 0).map((r) => r.date)).size;
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${MONTH_NAMES[m]}</td><td>${formatDistance(cur.distance, units.distance)}</td><td>${formatDuration(cur.movingTime)}</td><td>${formatElevation(cur.elevation, units.elevation)}</td><td>${cur.count}</td><td>${activeDays}</td><td>${prev.count ? formatDistance(prev.distance, units.distance) : "- - -"}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    wrap.appendChild(tableWrap);
    parent.appendChild(wrap);
  });
```

Note: the monthly table ignores the year filter for its per-month ranges only when "All years" is selected (defaults to the current year). The weekly chart always ends at today; the year filter still affects it through `filteredRows` (a past-year selection empties recent weeks — acceptable and predictable).

- [ ] **Step 3: Add the Pace & Performance renderer**

```javascript
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
        const fastest = t.fastest !== null
          ? (RIDE_TYPES.has(type)
            ? "- - -"
            : formatPace(t.fastest, units.distance) || "- - -")
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
```

- [ ] **Step 4: Add the Consistency & Streaks renderer**

```javascript
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
    const { units, today, payload } = ctx;
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
        out += `<rect x="${(i * barW + 2).toFixed(1)}" y="${(pad.top + innerH - h).toFixed(1)}" width="${(barW - 4).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="#9b5de5" opacity="0.85"><title>${labels[i]}: ${v}</title></rect>`;
        out += `<text x="${(i * barW + barW / 2).toFixed(1)}" y="${height - 6}" font-size="10" fill="currentColor" opacity="0.55" text-anchor="middle">${labels[i]}</text>`;
      });
      return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img">${out}</svg>`;
    }

    const dowChart = el("div", "stats-chart");
    wrap.appendChild(el("p", "stats-subtitle", "Activities by day of week"));
    dowChart.innerHTML = miniBars(dow, DAY_NAMES);
    wrap.appendChild(dowChart);

    const hourLabels = hod.map((_, i) => (i % 3 === 0 ? String(i) : ""));
    const hodChart = el("div", "stats-chart");
    wrap.appendChild(el("p", "stats-subtitle", "Activities by hour of day"));
    hodChart.innerHTML = miniBars(hod, hourLabels);
    wrap.appendChild(hodChart);

    parent.appendChild(wrap);
  });
```

- [ ] **Step 5: Verify in browser**

Reload, open Stats. Expected: quick-glance rows, then filter selects, then Trends (bar chart + monthly table), Pace & Performance table (Run pace ~min/km-plausible, Ride shows km/h), Consistency section (streaks are integers; histograms populated). Change year filter to a past year → tables/histograms update, weekly chart mostly empties (expected). Sport filter to Run → pace table shows only Run. No console errors.

- [ ] **Step 6: Commit**

```bash
git add site/stats.js
git commit -m "feat: trends, pace, and consistency stats sections"
```

---

### Task 7: Metric units + README

**Files:**
- Modify: `config.yaml` (units block)
- Modify: `README.md` (privacy section + stats mention)

- [ ] **Step 1: Flip config units**

In `config.yaml` change:

```yaml
units:
  distance: "km"   # "mi" or "km"
  elevation: "m"   # "ft" or "m"
```

- [ ] **Step 2: Check for overriding repo variables**

```bash
gh api repos/bestclouder/git-sweaty-bc/actions/variables --jq '.variables[] | "\(.name)=\(.value)"'
```

If `DASHBOARD_DISTANCE_UNIT` / `DASHBOARD_ELEVATION_UNIT` exist with imperial values, update them:

```bash
gh variable set DASHBOARD_DISTANCE_UNIT --repo bestclouder/git-sweaty-bc --body "km"
gh variable set DASHBOARD_ELEVATION_UNIT --repo bestclouder/git-sweaty-bc --body "m"
```

If they don't exist, do nothing (config.yaml now governs).

- [ ] **Step 3: README additions**

Add a new section after "## Configuration (Optional)":

```markdown
## Private dashboard (optional)

You can require a passphrase to view the dashboard:

1. Add a repository secret `DASHBOARD_PASSPHRASE` (Settings → Secrets and variables → Actions). Pick a strong passphrase — anyone who has it can view the dashboard.
2. Re-run the [Sync Heatmaps](../../actions/workflows/sync.yml) workflow.

From then on `site/data.json` is published encrypted (AES-256-GCM, key derived from your passphrase), and the site shows an unlock screen. The passphrase is remembered for the browser session only. Remove the secret and re-run the sync to go public again.

**Scope of protection:** this encrypts the published dashboard data. The `dashboard-data` branch of this repository still contains plaintext aggregates for the pipeline. If you want that private too, make the repository private — GitHub Pages keeps serving the (encrypted) site.

## Stats view

The dashboard has a second tab — **Stats** — with:

- weekly and monthly at-a-glance cards (distance, active time, avg pace, activities, elevation, estimated effort) compared against the previous period
- weekly distance trends and monthly rollups
- per-sport pace & performance tables
- streaks, active days, and day-of-week / time-of-day patterns
```

- [ ] **Step 4: Commit**

```bash
git add config.yaml README.md
git commit -m "feat: metric units + README docs for private gate and stats"
```

---

### Task 8: Full E2E verification and ship

**Files:** none new — verification + push.

- [ ] **Step 1: Run all Python tests**

Run: `python3 -m unittest discover tests -v`
Expected: all PASS.

- [ ] **Step 2: Full browser E2E on encrypted fixture**

Rebuild the fixture from the final code (metric units forced to match post-sync reality):

```bash
rm -rf /tmp/sweaty-e2e && mkdir -p /tmp/sweaty-e2e && cp -R site/* /tmp/sweaty-e2e/
python3 -c "
import sys, json; sys.path.insert(0, 'scripts')
from encrypt_data import encrypt_payload
data = json.load(open('site/data.json'))
data['units'] = {'distance': 'km', 'elevation': 'm'}
env = encrypt_payload(json.dumps(data).encode(), 'test-passphrase')
json.dump(env, open('/tmp/sweaty-e2e/data.json', 'w'))
print('fixture ready')
"
sed -i '' 's/__APP_VERSION__/e2e/g' /tmp/sweaty-e2e/index.html
```

Serve and verify in the Browser pane:
1. Overlay blocks the page; nothing dashboard-related visible behind it.
2. Wrong passphrase → error text, stays locked.
3. `test-passphrase` → heatmap renders with km/m units.
4. Reload → unlocks without re-prompt. "Lock dashboard" → locked again.
5. Stats tab → all sections render; deltas sane; `#stats` hash works on direct load.
6. Console free of errors; screenshot both views for the user.

- [ ] **Step 3: Verify plaintext mode still clean**

Serve `site/` directly (plaintext data.json): no overlay, dashboard + stats both work (mi/ft units from the old committed data.json — expected until next sync).

- [ ] **Step 4: Push**

```bash
git push origin main
```

Expected: push succeeds; `pages.yml` deploys (site markup changed). The live site stays plaintext until the user adds the `DASHBOARD_PASSPHRASE` secret and re-runs Sync Heatmaps.

- [ ] **Step 5: Hand off to user**

Tell the user to:
1. Add repo secret `DASHBOARD_PASSPHRASE` (strong passphrase) at Settings → Secrets and variables → Actions.
2. Run the Sync Heatmaps workflow (Actions tab) — after it finishes, the live site requires the passphrase and shows metric units.
3. Optionally make the repo private to also seal the `dashboard-data` branch.
```
