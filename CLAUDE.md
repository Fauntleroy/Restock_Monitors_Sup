# Restock Monitors — Deployment Topology & Required Env Vars

**Read this first.** 10 services across two platforms run the same codebase
(`monitor.js` for Supreme, `palace-monitor.js` for Palace). Knowing what runs
where and what env vars are required is non-obvious from the code alone.

## Services

### Railway (4 services)

Each is a separate Railway service, manually created in the Railway dashboard,
all under the **Restock Monitors** project. Auto-redeploys on every push to
`main` of `github.com/Fauntleroy/Restock_Monitors_Sup`.

| Service     | Code              | Notes                                |
|-------------|-------------------|--------------------------------------|
| Supreme US  | `monitor.js`      | US (currently `us-west` region)      |
| Supreme EU  | `monitor.js`      |                                      |
| Palace US   | `palace-monitor.js` |                                    |
| Palace EU   | `palace-monitor.js` |                                    |

### Fly.io (6 apps)

| App                    | Region | Code              | Auto-deploy on `main` push? |
|------------------------|--------|-------------------|------------------------------|
| `supreme-monitor-jp`   | NRT    | `monitor.js`      | ✅ via `.github/workflows/fly-deploy.yml` |
| `supreme-monitor-uk`   | LHR    | `monitor.js`      | ✅ via workflow              |
| `supreme-monitor-asia` | SIN    | `monitor.js`      | ✅ via workflow              |
| `palace-monitor-jp`    | NRT    | `palace-monitor.js` | ❌ **MANUAL ONLY** — run `flyctl deploy --config fly.palace-jp.toml` |
| `palace-monitor-uk`    | LHR    | `palace-monitor.js` | ❌ **MANUAL ONLY** — `fly.palace-uk.toml` |
| `palace-monitor-au`    | SYD    | `palace-monitor.js` | ❌ **MANUAL ONLY** — `fly.palace-au.toml` |

> ⚠️ The 3 Palace Fly apps are not in the auto-deploy workflow. After any
> code change to `palace-monitor.js`, deploy them manually or they'll drift
> behind. Either add them to `fly-deploy.yml` or `flyctl deploy --config
> fly.palace-XX.toml` for each.

## Required env vars

Per service:

| Var                          | Purpose                                                                          |
|------------------------------|----------------------------------------------------------------------------------|
| `PROXIES`                    | IPRoyal residential proxy URL (or `host:port:user:pass`). Same value works on all services. Without it, services get 429-blocked by Cloudflare. |
| `WEBHOOK_<REGION>` (Supreme) | Discord webhook per region: `WEBHOOK_US`, `WEBHOOK_UK`, `WEBHOOK_EU`, `WEBHOOK_JP`, `WEBHOOK_ASIA` |
| `PALACE_WEBHOOK_<REGION>` (Palace) | Same idea: `PALACE_WEBHOOK_US`, `_UK`, `_EU`, `_JP`, `_AU` |
| `ACTIVE_REGIONS`             | Comma-separated region keys this instance polls (e.g. `US,EU`). If unset, polls all configured regions. |
| `SNAPSHOT_PATH`              | Persistent path for snapshot.json (Railway volume mount, e.g. `/data/snapshot.json`) |
| `RESALE_CACHE_PATH`          | Same idea for resale cache |

## Optional tuning knobs

| Var                              | Default | Purpose                                                                |
|----------------------------------|---------|------------------------------------------------------------------------|
| `MAX_RESTOCKS_PER_CYCLE`         | 10      | Quiet-hours alert-burst threshold (snapshot-drift suppression)        |
| `MAX_RESTOCKS_PER_WAVE_CYCLE`    | 250     | Wave-mode alert-burst threshold                                       |
| `POLL_INTERVAL_MS`               | 3000    | Poll interval override                                                |
| `FAST_POLL_MS` / `SLOW_POLL_MS`  | 3000    | Per-mode poll interval (Supreme only)                                 |
| `DROP_HOUR` / `DROP_MIN`         | 11 / 0  | Wall-clock drop time (sell-out recap module, currently unwired)       |
| `RECAP1_DELAY_MIN` / `RECAP2_DELAY_MIN` | 5 / 180 | Sell-out recap delays (module unwired)                          |

## Drop schedules

- **US, UK, EU, Asia** — Thursday 11:00 ET (simultaneous global drop). The
  hardcoded `checkWaveStatus()` window of `10:50–11:30 ET` covers all four.
- **JP** — Saturday. **NOT** in the current wave window. JP burst threshold
  stays at quiet (10) on Saturday → could silently suppress a real 70-item
  JP drop. Open item: add Saturday JST wave window.

## Notable repo files

- `monitor.js` — Supreme. HTML scraping with `['new','shoes','all']` collections per region, per page paginated.
- `palace-monitor.js` — Palace. Shopify Storefront GraphQL API.
- `sellout-recap.js` — Sell-out recap module (drop +5min, drop +3h). **Written but NOT wired** into either monitor. Activating requires hooks in `checkStock` / `checkRegion`.
- `proxies.txt`, `proxies - Copy.txt` — `.gitignored` / `.dockerignored`. **Never ship to production.** Proxy config goes through `PROXIES` env var.
- `fly.toml` / `fly.uk.toml` / `fly.asia.toml` — Supreme Fly configs.
- `fly.palace-*.toml` — Palace Fly configs (not in auto-deploy workflow).
- `.github/workflows/fly-deploy.yml` — Auto-deploys 3 Supreme Fly apps on push to `main`.
- `railway.json` / `railway.toml` — Railway base config; volumes and restart policy.

## Adding a new service / region

1. Add an entry to `REGIONS` in the relevant monitor file.
2. For Fly: create a new `fly.<name>.toml`, run `flyctl apps create <name>`, then add a deploy step in `.github/workflows/fly-deploy.yml` (or accept manual deploys).
3. For Railway: create a new service from the Railway dashboard, set `ACTIVE_REGIONS=<new>`.
4. Set all required env vars on the new service (`PROXIES`, webhooks, snapshot paths).
