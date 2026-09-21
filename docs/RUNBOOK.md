# Operations and reproducible setup

This is the short operational guide for reproducing and running the whole project. Component-specific implementation details stay in `satellite/README.md` and `model/README.md`.

The canonical production build is `.github/workflows/pages.yml`. A local build can reproduce the data/rendering stages, but only GitHub Actions can mint the short-lived GitHub OIDC token used by the production R2 uploader.

## Accounts and registrations

1. **GitHub** — repository, GitHub Pages and GitHub Actions: https://github.com/
2. **Cloudflare** — Worker, D1 and R2: https://dash.cloudflare.com/
3. **EUMETSAT** — register/login for Data Store access: https://data.eumetsat.int/
4. **EUMETSAT API Key Management** — obtain the Consumer Key and Consumer Secret used by EUMDAC: https://api.eumetsat.int/api-key/
5. **GitHub fine-grained PAT settings** — create the Worker scheduler token here: https://github.com/settings/personal-access-tokens
6. **Cloudflare API Tokens** — only needed for headless Cloudflare automation; interactive setup uses Wrangler login: https://dash.cloudflare.com/profile/api-tokens

DWD Open Data, Open-Meteo, Aviation Weather Center, OpenStreetMap and Natural Earth are consumed as public sources by the current project and do not require project API secrets.

## Credential map

| Credential | Where it lives | Purpose |
| --- | --- | --- |
| `EUMETSAT_CONSUMER_KEY` | GitHub Actions repository secret | Native MTG/FCI Level-1c download through EUMDAC |
| `EUMETSAT_CONSUMER_SECRET` | GitHub Actions repository secret | Native MTG/FCI Level-1c download through EUMDAC |
| `GITHUB_ACTIONS_TOKEN` | Cloudflare Worker secret | Lets the Worker cron dispatch `pages.yml` |
| sensor bearer token | Local mode-600 collector config; only its SHA-256 hash is stored in D1 | Authenticates sensor ingest |
| GitHub OIDC JWT | Ephemeral inside each Actions run | Authenticates model-cube upload to the Worker/R2 gateway |

Do not commit any of these secrets. Production model uploads do **not** require a long-lived `MODEL_UPLOAD_TOKEN`; the workflow uses GitHub OIDC.

## First-time Cloudflare setup

From `worker/`:

```bash
npm ci
npx wrangler login
npx wrangler d1 create read-sensor
npx wrangler r2 bucket create read-sensor-model-cubes
```

Copy the newly created D1 `database_id` into `worker/wrangler.jsonc`. Keep the R2 binding name `MODEL_CUBE`; if the bucket name changes, update `bucket_name` in the same file.

Initialize the remote D1 schema:

```bash
npx wrangler d1 execute read-sensor --remote --file schema.sql
```

Configure the R2 bucket with a 14-day object lifecycle. `model/r2-lifecycle.json` records the intended rule; verify the live rule in the Cloudflare dashboard after applying it.

Create a **fine-grained GitHub personal access token** restricted to this repository with **Actions: write** permission, then store it as a Worker secret:

```bash
npx wrangler secret put GITHUB_ACTIONS_TOKEN
npx wrangler deploy
```

The Worker cron is defined in `worker/wrangler.jsonc` and dispatches the Pages workflow four times per hour. For local interactive Wrangler use, `wrangler login` is preferred; a Cloudflare API token is only needed for non-interactive/headless Cloudflare automation.

## GitHub setup

In the repository settings:

1. Enable **GitHub Pages** with **GitHub Actions** as the deployment source.
2. Add repository Actions secrets `EUMETSAT_CONSUMER_KEY` and `EUMETSAT_CONSUMER_SECRET`.
3. Keep `permissions: id-token: write` in `.github/workflows/pages.yml`; this is what permits the workflow to request its short-lived OIDC JWT.
4. Keep the Worker `GITHUB_OWNER`, `GITHUB_REPOSITORY`, `GITHUB_WORKFLOW` and `GITHUB_REF` variables synchronized with the repository/branch. The Worker validates these claims before accepting an OIDC-authenticated model upload.

The EUMETSAT key pair comes from the API Key Management page after logging in. EUMDAC converts those long-lived user credentials into access tokens; do not manually create or store an EUMETSAT access token in GitHub.

## Canonical full project run

The reproducible end-to-end production run is the GitHub Actions workflow:

```bash
gh workflow run pages.yml -f satellite_only=false
gh run watch
```

The same action is available in the GitHub web UI under **Actions → Deploy GitHub Pages → Run workflow**.

A full run performs Worker/frontend tests, refreshes SYNOP, renders the WMS satellite baseline, attempts the credential-gated native FCI/Satpy upgrade, renders the ICON-EU/MetPy products and local Zarr cube, uploads the accepted cube to R2 through GitHub OIDC, builds the data monitor, enforces storage guardrails, and deploys Pages.

## Local validation and rendering

Use Python 3.13 to match Actions:

```bash
python3.13 -m venv .venv
source .venv/bin/activate
python -m pip install -r model/requirements.txt
python -m pip install -r satellite/requirements-native.txt
npm ci --prefix worker
```

Run the fast checks first:

```bash
npm test --prefix worker
node --check app.js
node --check model-map.js
node --check data-monitor.js
node --check geometry-loader.js
node --check geometry-ui.js
node synop/test_decode.js
python model/test_metpy_diagnostics.py
PYTHONPATH=.:satellite python satellite/test_render_satellite.py
```

Then render the data products. The WMS path needs no EUMETSAT secret; the native FCI step does:

```bash
mkdir -p synop/output satellite/output model/output
PYTHONPATH=. python synop/update_live.py --catalog synop/stations.json --output synop/output/live.json
python satellite/render_satellite.py --output satellite/output
export EUMETSAT_CONSUMER_KEY='...'
export EUMETSAT_CONSUMER_SECRET='...'
PYTHONPATH=.:satellite python satellite/render_satpy.py --output satellite/output
python model/render_icon_products.py --output model/output --background satellite/output/geocolour.webp --skip-zarr
```

Omit the two EUMETSAT environment variables and the `render_satpy.py` command when testing only the public WMS fallback. Omit `--skip-zarr` when you specifically need to inspect the local Zarr output. Do not call `model/upload_zarr_cube.py` with a fabricated production token; use the GitHub Actions path for the real R2 upload.

## Sensor computer setup

The collector requires `osx-cpu-temp`, a registered D1 device, and a local mode-600 config file.

After the Worker is deployed and Wrangler is authenticated:

```bash
./register-device.sh sensor-node-01 \
  https://read-sensor-api.read-sensor.workers.dev \
  "$HOME/.config/read-sensor/collector.env"

./publish.sh
./install-schedule.sh
```

`register-device.sh` generates a random bearer token locally, stores only its SHA-256 hash in D1, and writes the raw token only to the protected local config. `install-schedule.sh` installs a macOS LaunchAgent that publishes every five minutes.

## Verification after a deployment

Check these in order:

1. GitHub Actions run is green.
2. `satellite/latest.json` reports the intended backend and any composite warnings.
3. `model/latest.json` exposes the current interactive layer catalogue.
4. `monitor/latest.json` reports zero failed processing steps and storage below project ceilings.
5. The live dashboard loads the expected satellite/model layers without stale-cache artefacts.
6. Cloudflare R2 lifecycle and D1 retention remain configured.

When changing storage, cadence, time dimensions or satellite products, update the monitor/guardrails in the same change rather than documenting an unmeasured estimate.
