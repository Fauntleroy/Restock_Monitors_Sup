# Restock Monitors — Deployment Topology & Required Env Vars

**Read this first.** Services across two platforms run the same codebase
(`monitor.js` for Supreme, `palace-monitor.js` for Palace). Knowing what runs
where and what env vars are required is non-obvious from the code alone.

## Services

### Railway (7 services — primary platform)

Each is a separate Railway service under the **Restock Monitors** project.
Auto-redeploys on every push to `main` of
`github.com/Fauntleroy/Restock_Monitors_Sup`.

| Service       | Code              | `PROXIES` country | Notes |
|---------------|-------------------|-------------------|-------|
| Supreme US    | `monitor.js`      | `_country-us`     | |
| Supreme EU    | `monitor.js`      | `_country-de` (or any EU) | |
| Supreme UK    | `monitor.js`      | `_country-gb`     | Migrated from Fly 2026-06-19 |
| Supreme JP    | `monitor.js`      | `_country-jp`     | Migrated from Fly 2026-06-19 |
| Supreme Asia  | `monitor.js`      | `_country-sg`     | Migrated from Fly 2026-06-19 |
| Palace US     | `palace-monitor.js` | (none)          | Palace doesn't need proxies — Shopify API is permissive |
| Palace EU     | `palace-monitor.js` | (none)          | |

### Fly.io (mixed — Palace only is active)

| App                    | Region | Status | Code | Auto-deploy |
|------------------------|--------|--------|------|-------------|
| `supreme-monitor-jp`   | NRT    | ⛔ Dormant (scaled to 0 on 2026-06-19) — replaced by Railway Supreme JP | `monitor.js` | (was via `.github/workflows/fly-deploy.yml`) |
| `supreme-monitor-uk`   | LHR    | ⛔ Dormant (scaled to 0) — replaced by Railway Supreme UK | `monitor.js` | (was via workflow) |
| `supreme-monitor-asia` | SIN    | ⛔ Dormant (scaled to 0) — replaced by Railway Supreme Asia | `monitor.js` | (was via workflow) |
| `palace-monitor-jp`    | NRT    | ✅ Active | `palace-monitor.js` | ❌ **MANUAL ONLY** — `flyctl deploy --config fly.palace-jp.toml` |
| `palace-monitor-uk`    | LHR    | ✅ Active | `palace-monitor.js` | ❌ **MANUAL ONLY** — `fly.palace-uk.toml` |
| `palace-monitor-au`    | SYD    | ✅ Active | `palace-monitor.js` | ❌ **MANUAL ONLY** — `fly.palace-au.toml` |

> ⚠️ The 3 Palace Fly apps are NOT in the auto-deploy workflow. After any
> code change to `palace-monitor.js`, deploy them manually: `flyctl deploy
> --config fly.palace-XX.toml` per app. Easy follow-up: add them to
> `fly-deploy.yml`.

> The 3 dormant Supreme Fly apps still have their app configs; resurrect with
> `flyctl scale count 1 -a <app-name>` if Railway migration ever needs to be
> rolled back. Run `flyctl apps destroy <app-name>` to fully delete them once
> confident.

## Required env vars

Per service:

| Var                          | Purpose                                                                          |
|------------------------------|----------------------------------------------------------------------------------|
| `PROXIES`                    | IPRoyal residential proxy with country code (`geo.iproyal.com:12321:USER:PASS_country-<XX>`). Same base credential across services, only the 2-letter country code changes per region. **Required for Supreme services to avoid Cloudflare bot detection. NOT needed for Palace.** |
| `WEBHOOK_<REGION>` (Supreme) | Discord webhook per region: `WEBHOOK_US`, `WEBHOOK_UK`, `WEBHOOK_EU`, `WEBHOOK_JP`, `WEBHOOK_ASIA` |
| `PALACE_WEBHOOK_<REGION>` (Palace) | Same idea: `PALACE_WEBHOOK_US`, `_UK`, `_EU`, `_JP`, `_AU` |
| `ACTIVE_REGIONS`             | Comma-separated region keys this instance polls (e.g. `US`). If unset, polls all configured regions. Set per-service to limit to one region. |
| `SNAPSHOT_PATH`              | Persistent path for snapshot.json (Railway volume mount, e.g. `/data/snapshot.json`) |
| `RESALE_CACHE_PATH`          | Same idea for resale cache (Supreme only) |

## Optional tuning knobs

| Var                              | Default | Purpose                                                                |
|----------------------------------|---------|------------------------------------------------------------------------|
| `SLOW_POLL_MS`                   | 10000   | Quiet-hours poll interval (Supreme). Reduces proxy bandwidth ~70% vs 3s. |
| `FAST_POLL_MS`                   | 3000    | Wave-mode poll interval (Supreme). Engaged on any restock or Thursday drop window. |
| `WAVE_COOLDOWN_MS`               | 300000  | How long wave-mode persists after last restock (Supreme), default 5 min. |
| `POLL_INTERVAL_MS`               | 3000    | Palace poll interval. Palace has no slow/fast distinction.             |
| `MAX_RESTOCKS_PER_CYCLE`         | 10      | Quiet-hours alert-burst threshold (Supreme snapshot-drift suppression). |
| `MAX_RESTOCKS_PER_WAVE_CYCLE`    | 250     | Wave-mode alert-burst threshold (Supreme).                            |
| `DROP_HOUR` / `DROP_MIN`         | 11 / 0  | Wall-clock drop time (sell-out recap module, currently unwired)       |
| `RECAP1_DELAY_MIN` / `RECAP2_DELAY_MIN` | 5 / 180 | Sell-out recap delays (module unwired)                          |

## Wave-mode behavior (Supreme)

The Supreme monitor switches between two polling rates automatically:

- **Quiet mode** (default): `SLOW_POLL_MS` (10s) — saves proxy bandwidth.
- **Wave mode**: `FAST_POLL_MS` (3s) — engaged when:
  - Any restock is detected (via `onRestockDetected()`), OR
  - It's Thursday 10:50–11:30 ET (the global drop window)
- After last restock, wave mode persists for `WAVE_COOLDOWN_MS` (5 min) before reverting.

## Drop schedules

- **US, UK, EU, Asia** — Thursday 11:00 ET (simultaneous global drop). The
  hardcoded `checkWaveStatus()` window of `10:50–11:30 ET` covers all four.
- **JP** — Saturday. **NOT** in the current wave window. JP burst threshold
  stays at quiet (10) on Saturday → could silently suppress a real 70-item
  JP drop. Open item: add Saturday JST wave window.

## Anti-bot context

- **Supreme is on Cloudflare** with active bot detection. Direct egress
  IPs (Railway / Fly datacenter ASNs) get hit with JavaScript challenges
  (`Verifying your connection...` page returning 429). Residential proxies
  bypass this; mobile proxies or anti-bot services would too if residential
  ever stops working (e.g. if Cloudforce One threat intel starts flagging
  IPRoyal's pool).
- **Palace is on Shopify Storefront API** — no Cloudflare WAF, no bot
  detection. Direct egress IPs work fine. Only soft per-IP rate limits.

## Notable repo files

- `monitor.js` — Supreme. HTML scraping. Currently fetches only `['all']` collection per region (trimmed from `['new','shoes','all']` on 2026-06-19 to halve request rate).
- `palace-monitor.js` — Palace. Shopify Storefront GraphQL API.
- `sellout-recap.js` — Sell-out recap module (drop +5min, drop +3h). **Written but NOT wired** into either monitor. Activating requires hooks in `checkStock` / `checkRegion`.
- `proxies.txt`, `proxies - Copy.txt` — `.gitignored` / `.dockerignored`. **Never ship to production.** Proxy config goes through `PROXIES` env var.
- `fly.toml` / `fly.uk.toml` / `fly.asia.toml` — Supreme Fly configs (dormant apps).
- `fly.palace-*.toml` — Palace Fly configs (active, manual deploy).
- `.github/workflows/fly-deploy.yml` — Auto-deploys 3 Supreme Fly apps on push to `main` (now hitting dormant apps; harmless, but could be cleaned up).
- `railway.json` / `railway.toml` — Railway base config; volumes and restart policy.

## Adding a new service / region

1. Add an entry to `REGIONS` in the relevant monitor file.
2. Create a new Railway service from the dashboard:
   - Deploy from GitHub → select the repo
   - Set start command (`node monitor.js` or `node palace-monitor.js`)
   - Set `ACTIVE_REGIONS`, the webhook env var, `PROXIES` (Supreme only), `SNAPSHOT_PATH`
   - Mount a volume at `/data` for snapshot persistence
3. Verify in logs: `[Proxy] Loaded` line + clean `[<REGION>] N products` cycles.
