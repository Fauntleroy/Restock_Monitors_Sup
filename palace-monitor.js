// Palace Skateboards Restock Monitor
// Uses Shopify Storefront GraphQL API (no auth required)
// Regions: US, UK, EU, JP

import fetch from 'node-fetch';
import fs    from 'fs';
import http  from 'http';
import { HttpsProxyAgent } from 'https-proxy-agent';

// ─── HEALTH CHECK SERVER ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(PORT, () => console.log(`[Health] Listening on port ${PORT}`));

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const WEBHOOKS = {
  US: process.env.PALACE_WEBHOOK_US || '',
  UK: process.env.PALACE_WEBHOOK_UK || '',
  EU: process.env.PALACE_WEBHOOK_EU || '',
  JP: process.env.PALACE_WEBHOOK_JP || '',
  AU: process.env.PALACE_WEBHOOK_AU || '',
};

const REGIONS = {
  US: { label: 'Palace US',  flag: '🇺🇸', baseUrl: 'https://usa.palaceskateboards.com', currency: 'USD', webhookKey: 'US' },
  UK: { label: 'Palace UK',  flag: '🇬🇧', baseUrl: 'https://palaceskateboards.com',     currency: 'GBP', webhookKey: 'UK' },
  EU: { label: 'Palace EU',  flag: '🇪🇺', baseUrl: 'https://eu.palaceskateboards.com',  currency: 'EUR', webhookKey: 'EU' },
  JP: { label: 'Palace JP',  flag: '🇯🇵', baseUrl: 'https://jp.palaceskateboards.com',  currency: 'JPY', webhookKey: 'JP' },
  AU: { label: 'Palace AU',  flag: '🇦🇺', baseUrl: 'https://au.palaceskateboards.com',  currency: 'AUD', webhookKey: 'AU' },
};

const ACTIVE_REGIONS = process.env.ACTIVE_REGIONS
  ? process.env.ACTIVE_REGIONS.split(',').map(r => r.trim().toUpperCase())
  : null;

// Quiet mode = slow polling. Wave mode (auto-engaged on any restock) = fast polling.
// Stays in wave mode for WAVE_COOLDOWN_MS after the last restock, then drops back.
const SLOW_POLL_MS      = Number(process.env.SLOW_POLL_MS ?? process.env.POLL_INTERVAL_MS ?? 20 * 1000);
const FAST_POLL_MS      = Number(process.env.FAST_POLL_MS ?? 3 * 1000);
const WAVE_COOLDOWN_MS  = Number(process.env.WAVE_COOLDOWN_MS ?? 5 * 60 * 1000);
const REQUEST_TIMEOUT   = 15 * 1000;
const SNAPSHOT_FILE     = process.env.SNAPSHOT_PATH || 'palace-snapshot.json';
const RESALE_CACHE_FILE = process.env.RESALE_CACHE_PATH || 'palace-resale-cache.json';
const RESALE_REFRESH_MS = 12 * 60 * 60 * 1000;  // refresh resale cache every 12 hours
const RESALE_DELAY_MS   = 1000;                   // 1s between Grailed lookups (be polite)
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;          // 5 min cooldown per item
const EMBED_COLOR_NEW     = 0xE74C3C;             // red for new drops
const EMBED_COLOR_RESTOCK = 0x2ECC71;             // green for restocks

// Currency symbols
const CURRENCY_SYMBOLS = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', AUD: 'A$' };

// ─── PROXY POOL ──────────────────────────────────────────────────────────────
// Three input sources, all optional, merged into one pool:
//   1. proxies.txt (or $PROXIES_PATH) — one per line, file-based
//   2. $PROXIES env var — newline OR comma separated list (preferred for Railway)
//   3. $PROXY env var — single entry shorthand
// Each entry accepts EITHER URL form (http://user:pass@host:port) OR the
// IPRoyal-native colon form (host:port:user:pass), auto-detected.

function parseProxyEntry(raw) {
  const s = String(raw || '').trim();
  if (!s || s.startsWith('#')) return null;
  if (/^https?:\/\//i.test(s)) return s; // already a URL
  const parts = s.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  if (parts.length === 2) return `http://${s}`; // host:port, no auth
  console.warn(`[Proxy] Skipping unrecognized entry: "${s.slice(0, 40)}"`);
  return null;
}

const proxyLines = (() => {
  const inputs = [];
  try {
    const raw = fs.readFileSync(process.env.PROXIES_PATH || 'proxies.txt', 'utf8');
    inputs.push(...raw.split('\n'));
  } catch { /* no file is fine */ }
  if (process.env.PROXIES) inputs.push(...process.env.PROXIES.split(/[\n,]/));
  if (process.env.PROXY)   inputs.push(process.env.PROXY);
  const parsed = inputs.map(parseProxyEntry).filter(Boolean);
  if (parsed.length) console.log(`[Proxy] Loaded ${parsed.length} proxy URL(s) — IP rotation active`);
  else               console.log(`[Proxy] No proxies configured — all traffic from single egress IP`);
  return parsed;
})();

const proxyPool = (() => {
  const banned  = new Set();
  const proxies = proxyLines.map(url => ({ url }));
  let i = 0;
  return {
    next() {
      if (!proxies.length) return null;
      const available = proxies.filter(p => !banned.has(p.url));
      if (!available.length) { banned.clear(); return proxies[i++ % proxies.length]; }
      return available[i++ % available.length];
    },
    ban(p) { if (p) banned.add(p.url); },
    ok(p)  { if (p) banned.delete(p.url); },
  };
})();

// ─── EXCHANGE RATES ─────────────────────────────────────────────────────────
// Converts Grailed USD prices → local currency. Refreshed once per day.

let exchangeRates = {};
let exchangeRatesUpdatedAt = 0;
const FX_REFRESH_MS = 24 * 60 * 60 * 1000;

async function refreshExchangeRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.rates) {
      exchangeRates = data.rates;
      exchangeRatesUpdatedAt = Date.now();
      console.log(`[FX] Rates updated — GBP:${data.rates.GBP} EUR:${data.rates.EUR} JPY:${data.rates.JPY} AUD:${data.rates.AUD}`);
    }
  } catch (err) {
    console.error(`[FX] Failed to fetch rates: ${err.message}`);
  }
}

function convertUSD(amount, toCurrency) {
  if (!amount || toCurrency === 'USD') return amount;
  const rate = exchangeRates[toCurrency];
  if (!rate) return null;
  return Math.round(amount * rate);
}

// ─── STATE ───────────────────────────────────────────────────────────────────

let snapshot    = {};  // { regionKey: { productId: { title, variants: { variantId: available } } } }
let cooldowns   = {};  // { "region:title": timestamp }
let resaleCache = {};  // { "product title": { avg, low, high, count, url, fetchedAt } }

// Wave-mode polling state — engaged on any restock, falls back after WAVE_COOLDOWN_MS idle.
let inWave        = false;
let lastRestockAt = 0;

function onRestockDetected() {
  lastRestockAt = Date.now();
  if (!inWave) {
    inWave = true;
    console.log(`[${ts()}] 🌊 Wave mode ON`);
  }
}

function checkWaveStatus() {
  if (inWave && Date.now() - lastRestockAt > WAVE_COOLDOWN_MS) {
    inWave = false;
    console.log(`[${ts()}] 💤 Wave mode OFF — returning to quiet`);
  }
}

// ─── GRAPHQL ─────────────────────────────────────────────────────────────────

const PRODUCTS_QUERY = `
  query ($cursor: String) {
    collection(handle: "all") {
      products(first: 250, after: $cursor) {
        edges {
          node {
            id
            title
            handle
            productType
            availableForSale
            createdAt
            updatedAt
            priceRange {
              minVariantPrice { amount currencyCode }
            }
            variants(first: 30) {
              edges {
                node {
                  id
                  title
                  availableForSale
                  price { amount currencyCode }
                }
              }
            }
            images(first: 1) {
              edges { node { url } }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

async function fetchProducts(region) {
  const graphqlUrl = `${region.baseUrl}/api/2024-01/graphql.json`;
  let allProducts = [];
  let cursor = null;
  let page = 0;

  while (true) {
    page++;
    const proxy = proxyPool.next();
    const agent = proxy ? new HttpsProxyAgent(proxy.url) : undefined;
    const res = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        query: PRODUCTS_QUERY,
        variables: { cursor },
      }),
      agent,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (res.status === 429 || res.status === 403 || res.status === 503) {
      proxyPool.ban(proxy);
      let body = '';
      try { body = (await res.text()).slice(0, 200); } catch {}
      const via   = proxy ? proxy.url.replace(/:[^@:/]+@/, ':***@') : 'DIRECT (no proxy in use)';
      const cfRay = res.headers.get('cf-ray')      || '-';
      const ra    = res.headers.get('retry-after') || '-';
      const srv   = res.headers.get('server')      || '-';
      console.warn(`[Blocked] ${res.status} ${graphqlUrl} | via=${via} | server=${srv} | cf-ray=${cfRay} | retry-after=${ra} | body="${body.replace(/\s+/g, ' ').trim()}"`);
      throw new Error(`Blocked: ${res.status}`);
    }
    if (!res.ok) {
      proxyPool.ban(proxy);
      throw new Error(`HTTP ${res.status}`);
    }
    proxyPool.ok(proxy);

    const json = await res.json();
    const collection = json?.data?.collection;
    if (!collection) throw new Error('No collection data');

    const products = collection.products.edges.map(e => e.node);
    allProducts.push(...products);

    if (collection.products.pageInfo.hasNextPage) {
      cursor = collection.products.pageInfo.endCursor;
    } else {
      break;
    }

    // Safety: max 5 pages
    if (page >= 5) break;
  }

  return allProducts;
}

// ─── RESALE CACHE ───────────────────────────────────────────────────────────
// Resale data is fetched in bulk every 12 hours, NOT on each alert.
// This keeps API usage low and alerts instant (no waiting for lookups).

function loadResaleCache() {
  try {
    if (fs.existsSync(RESALE_CACHE_FILE)) {
      resaleCache = JSON.parse(fs.readFileSync(RESALE_CACHE_FILE, 'utf8'));
      const count = Object.keys(resaleCache).length;
      console.log(`[Resale] Loaded cache: ${count} items from ${RESALE_CACHE_FILE}`);
    }
  } catch (err) {
    console.error(`[Resale] Failed to load cache: ${err.message}`);
    resaleCache = {};
  }
}

function saveResaleCache() {
  try {
    fs.writeFileSync(RESALE_CACHE_FILE, JSON.stringify(resaleCache, null, 2));
  } catch (err) {
    console.error(`[Resale] Failed to save cache: ${err.message}`);
  }
}

function getResaleFromCache(title) {
  const entry = resaleCache[title];
  if (!entry) return null;
  return entry;
}

async function grailedLookupSingle(title) {
  try {
    const query = `Palace ${title}`.slice(0, 80);
    const res = await fetch('https://mnrwefss2q-dsn.algolia.net/1/indexes/Listing_sold_production/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-algolia-application-id': 'MNRWEFSS2Q',
        'x-algolia-api-key': 'a3a4de2e05d9e9b463911705fb6323ad',
      },
      body: JSON.stringify({
        params: `query=${encodeURIComponent(query)}&hitsPerPage=5`,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const hits = data.hits || [];
    if (!hits.length) return null;

    const prices = hits.map(h => h.sold_price || h.price).filter(Boolean);
    if (!prices.length) return null;

    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const low = Math.min(...prices);
    const high = Math.max(...prices);

    return { avg, low, high, count: prices.length, url: `https://www.grailed.com/shop?query=${encodeURIComponent(query)}` };
  } catch {
    return null;
  }
}

async function refreshResaleCache() {
  // Collect product titles from first active region's snapshot
  const activeKey = Object.keys(REGIONS).find(key => {
    if (ACTIVE_REGIONS && !ACTIVE_REGIONS.includes(key)) return false;
    const w = WEBHOOKS[key];
    return w && !w.startsWith('PASTE');
  });
  const regionSnapshot = activeKey ? snapshot[activeKey] : null;
  if (!regionSnapshot || !Object.keys(regionSnapshot).length) {
    console.log(`[Resale] No snapshot yet — skipping cache refresh`);
    return;
  }

  const titles = [...new Set(Object.values(regionSnapshot).map(p => p.title))];
  console.log(`[Resale] Refreshing cache for ${titles.length} products...`);

  let updated = 0;
  let failed = 0;

  for (const title of titles) {
    try {
      const data = await grailedLookupSingle(title);
      if (data) {
        resaleCache[title] = { ...data, fetchedAt: Date.now() };
        updated++;
      }
    } catch {
      failed++;
    }
    // Be polite — 1 request per second
    await new Promise(r => setTimeout(r, RESALE_DELAY_MS));
  }

  saveResaleCache();
  console.log(`[Resale] Cache refresh done: ${updated} updated, ${failed} failed, ${titles.length} total`);
}

// Background resale cache refresh loop
async function resaleCacheLoop() {
  while (true) {
    if (Date.now() - exchangeRatesUpdatedAt > FX_REFRESH_MS) {
      await refreshExchangeRates();
    }
    await refreshResaleCache();
    console.log(`[Resale] Next refresh in ${RESALE_REFRESH_MS / 1000 / 60 / 60}h`);
    await new Promise(r => setTimeout(r, RESALE_REFRESH_MS));
  }
}

// ─── SNAPSHOT ────────────────────────────────────────────────────────────────

function loadSnapshot() {
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
      console.log(`[Snapshot] Loaded from ${SNAPSHOT_FILE}`);
    }
  } catch (err) {
    console.error(`[Snapshot] Failed to load: ${err.message}`);
    snapshot = {};
  }
}

function saveSnapshot() {
  try {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
  } catch (err) {
    console.error(`[Snapshot] Failed to save: ${err.message}`);
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toLocaleTimeString('en-US', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function extractNumericId(gid) {
  // gid://shopify/ProductVariant/47407745335426 -> 47407745335426
  return gid.split('/').pop();
}

function isCoolingDown(key) {
  return cooldowns[key] && (Date.now() - cooldowns[key]) < ALERT_COOLDOWN_MS;
}

// ─── DISCORD ─────────────────────────────────────────────────────────────────

async function sendDiscordAlert(webhookUrl, embed) {
  // Validate fields
  if (embed.fields) {
    for (const f of embed.fields) {
      if (!f.value || f.value.trim() === '') f.value = '—';
    }
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    const wait = ((data.retry_after || 2) + 0.5) * 1000;
    console.log(`[Discord] Rate limited — waiting ${Math.round(wait)}ms`);
    await new Promise(r => setTimeout(r, wait));
    return sendDiscordAlert(webhookUrl, embed);
  }

  if (res.status === 400) {
    const body = await res.text().catch(() => '');
    console.error(`[Discord] 400 error: ${body}`);
    console.error(`[Discord] Embed title: ${embed.title}`);
  }
}

async function sendAlert(region, product, variants, isNew) {
  const webhookUrl = WEBHOOKS[region.webhookKey];
  if (!webhookUrl || webhookUrl.startsWith('PASTE')) return;

  const cooldownKey = `${region.webhookKey}:${product.title}`;
  if (isCoolingDown(cooldownKey)) return;
  cooldowns[cooldownKey] = Date.now();
  onRestockDetected();

  const price = product.priceRange?.minVariantPrice?.amount;
  const currencyCode = product.priceRange?.minVariantPrice?.currencyCode || region.currency;
  const symbol = CURRENCY_SYMBOLS[currencyCode] || '$';
  const priceDisplay = price ? `${symbol}${Math.round(Number(price))}` : 'N/A';

  const productUrl = `${region.baseUrl}/products/${product.handle}`;
  const imageUrl = product.images?.edges?.[0]?.node?.url || null;

  // Build size lines with ATC links
  const availableVariants = variants.filter(v => v.availableForSale);
  const sizeLines = availableVariants.map(v => {
    const variantId = extractNumericId(v.id);
    const atcUrl = `${region.baseUrl}/cart/${variantId}:1`;
    return `🟢 **[${v.title}](${atcUrl})**`;
  }).join('\n');

  // Resale from cache — convert USD → local currency for non-US regions
  const resaleRaw = getResaleFromCache(product.title);
  let resale = null;
  let isApprox = false;
  if (resaleRaw && region.currency === 'USD') {
    resale = resaleRaw;
  } else if (resaleRaw) {
    const avgLocal = convertUSD(resaleRaw.avg, region.currency);
    if (avgLocal !== null) {
      resale = {
        avg: avgLocal,
        low: convertUSD(resaleRaw.low, region.currency),
        high: convertUSD(resaleRaw.high, region.currency),
        count: resaleRaw.count,
        url: resaleRaw.url,
      };
      isApprox = true;
    }
  }

  const tag = isNew ? '🆕 NEW DROP' : '🔄 RESTOCK';
  const color = isNew ? EMBED_COLOR_NEW : EMBED_COLOR_RESTOCK;

  const fields = [
    { name: '🏷️ Retail', value: priceDisplay, inline: true },
    { name: '🗂️ Category', value: product.productType || '—', inline: true },
    { name: `${region.flag} Region`, value: region.label, inline: true },
  ];

  if (resale) {
    const profitAvg = Math.round(resale.avg - Number(price || 0));
    const profitEmoji = profitAvg > 0 ? '📈' : '📉';
    const approx = isApprox ? '≈' : '';
    fields.push({
      name: '💰 Resale (Grailed)',
      value: `Avg: **${approx}${symbol}${resale.avg}** | Low: ${approx}${symbol}${resale.low} | High: ${approx}${symbol}${resale.high}\n${profitEmoji} Est. Profit: **${approx}${symbol}${profitAvg}** | [Search](${resale.url})`,
      inline: false,
    });
  }

  if (sizeLines) {
    fields.push({
      name: `📦 In Stock (${availableVariants.length})`,
      value: sizeLines.slice(0, 1024),
      inline: false,
    });
  }

  const timeStr = new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: true, timeZoneName: 'short',
  });

  const embed = {
    title: `${tag}: ${product.title}`,
    url: productUrl,
    color,
    thumbnail: imageUrl ? { url: imageUrl } : undefined,
    fields,
    footer: { text: `Palace Monitors | ${region.label} | ${timeStr}` },
    timestamp: new Date().toISOString(),
  };

  await sendDiscordAlert(webhookUrl, embed);
  console.log(`[${ts()}][${region.webhookKey}] 📣 ${tag}: ${product.title}`);
}

// ─── MONITOR LOGIC ───────────────────────────────────────────────────────────

async function checkRegion(regionKey, region) {
  try {
    const products = await fetchProducts(region);

    const sample = products.slice(0, 3).map(p => p.title);
    console.log(`[${ts()}][${regionKey}] ${products.length} products | Sample: ${sample.join(' | ')}`);

    const prevRegion = snapshot[regionKey] || {};
    const newRegion = {};

    for (const product of products) {
      const pid = product.id;
      const variants = product.variants.edges.map(e => e.node);
      const prevProduct = prevRegion[pid];

      // Build new variant map
      const variantMap = {};
      for (const v of variants) {
        variantMap[v.id] = v.availableForSale;
      }
      newRegion[pid] = { title: product.title, type: product.productType, variants: variantMap };

      if (!prevProduct) {
        // New product — only alert if it has stock and snapshot isn't empty (first run)
        if (product.availableForSale && Object.keys(prevRegion).length > 0) {
          await sendAlert(region, product, variants, true);
        }
        continue;
      }

      // Check for restocks: variant went from unavailable/missing to available
      const restockedVariants = [];
      for (const v of variants) {
        const wasAvailable = prevProduct.variants?.[v.id];
        if (v.availableForSale && wasAvailable === false) {
          restockedVariants.push(v);
        }
      }

      if (restockedVariants.length > 0) {
        await sendAlert(region, product, variants, false);
      }
    }

    snapshot[regionKey] = newRegion;
    saveSnapshot();

  } catch (err) {
    console.error(`[${ts()}][${regionKey}] Error: ${err.message}`);
  }
}

// ─── MAIN LOOP ───────────────────────────────────────────────────────────────

async function pollCycle() {
  const intervalMs = inWave ? FAST_POLL_MS : SLOW_POLL_MS;
  const mode = inWave ? `wave (${intervalMs/1000}s)` : `quiet (${intervalMs/1000}s)`;
  console.log(`[${ts()}] Polling... [${mode}]`);

  const activeWebhooks = Object.entries(WEBHOOKS).filter(([, v]) => v && !v.startsWith('PASTE'));
  if (!activeWebhooks.length) {
    console.error('No webhooks configured! Set PALACE_WEBHOOK_US (etc) as env vars.');
    process.exit(1);
  }

  const regionsToCheck = Object.entries(REGIONS).filter(([key]) => {
    if (ACTIVE_REGIONS && !ACTIVE_REGIONS.includes(key)) return false;
    return WEBHOOKS[key] && !WEBHOOKS[key].startsWith('PASTE');
  });

  for (const [key, region] of regionsToCheck) {
    await checkRegion(key, region);
  }
}

async function main() {
  console.log('👑 Palace Monitor starting...');
  loadSnapshot();
  loadResaleCache();
  await refreshExchangeRates();

  const activeRegions = Object.entries(REGIONS)
    .filter(([key]) => {
      if (ACTIVE_REGIONS && !ACTIVE_REGIONS.includes(key)) return false;
      return WEBHOOKS[key] && !WEBHOOKS[key].startsWith('PASTE');
    })
    .map(([key, r]) => `${r.flag} ${key}`);

  console.log(`Active regions: ${activeRegions.join(', ') || 'NONE'}`);
  console.log(`Poll intervals: quiet ${SLOW_POLL_MS/1000}s / wave ${FAST_POLL_MS/1000}s · wave cooldown ${WAVE_COOLDOWN_MS/1000}s`);
  console.log(`Resale cache: ${Object.keys(resaleCache).length} items, refreshes every ${RESALE_REFRESH_MS / 1000 / 60 / 60}h`);

  // Start resale cache refresh in background (waits 30s for first snapshot to build)
  setTimeout(() => resaleCacheLoop().catch(err => console.error('[Resale] Loop error:', err)), 30 * 1000);

  while (true) {
    await pollCycle();
    checkWaveStatus();
    const delay = inWave ? FAST_POLL_MS : SLOW_POLL_MS;
    await new Promise(r => setTimeout(r, delay));
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
