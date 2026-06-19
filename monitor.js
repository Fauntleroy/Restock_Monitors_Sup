// Supreme Restock Monitor — US
// Features: NEW vs RESTOCK detection, Grailed Algolia sold-listings lookup (no API key), GOAT link, wave mode, ATC cart links
//
// SETUP:
//   1. Run: npm install
//   2. Paste your Discord webhook URLs below
//   3. Run: node monitor.js

import fetch  from 'node-fetch';
import fs     from 'fs';
import http   from 'http';
import { HttpsProxyAgent } from 'https-proxy-agent';

// ─── HEALTH CHECK SERVER (Railway requires an HTTP listener) ──────────────────
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
}).listen(PORT, () => console.log(`[Health] Listening on port ${PORT}`));

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const WEBHOOKS = {
  US: process.env.WEBHOOK_US || '',
  UK: process.env.WEBHOOK_UK || '',
  EU: process.env.WEBHOOK_EU || '',
  JP: process.env.WEBHOOK_JP || '',
  ASIA: process.env.WEBHOOK_ASIA || '',
};

const REGIONS = {
  US: { label:'Supreme US', flag:'🇺🇸', baseUrl:'https://us.supreme.com', collections:['new','shoes','all'], currency:'USD', webhookKey:'US' },
  UK: { label:'Supreme UK', flag:'🇬🇧', baseUrl:'https://uk.supreme.com', collections:['new','shoes','all'], currency:'GBP', webhookKey:'UK' },
  EU: { label:'Supreme EU', flag:'🇪🇺', baseUrl:'https://eu.supreme.com', collections:['new','shoes','all'], currency:'EUR', webhookKey:'EU' },
  JP: { label:'Supreme JP', flag:'🇯🇵', baseUrl:'https://jp.supreme.com', collections:['new','shoes','all'], currency:'JPY', webhookKey:'JP' },
  ASIA: { label:'Supreme Asia', flag:'🌏', baseUrl:'https://shop.supreme.com', collections:['new','shoes','all'], currency:'SGD', webhookKey:'ASIA' },
};

// ACTIVE_REGIONS env var controls which regions this instance monitors
// e.g. ACTIVE_REGIONS=US or ACTIVE_REGIONS=UK,EU
// If not set, all regions with a webhook configured will run
const ACTIVE_REGIONS = process.env.ACTIVE_REGIONS
  ? process.env.ACTIVE_REGIONS.split(',').map(r => r.trim().toUpperCase())
  : null;

const SLOW_POLL_MS      = 3 * 1000;       // 3 sec quiet mode
const FAST_POLL_MS      = 3 * 1000;       // 3 sec wave mode (same speed — always fast)
const REQUEST_TIMEOUT   = 15 * 1000;
const SNAPSHOT_FILE     = process.env.SNAPSHOT_PATH || 'snapshot.json';
const RESALE_CACHE_FILE = process.env.RESALE_CACHE_PATH || 'supreme-resale-cache.json';
const RESALE_REFRESH_MS = 12 * 60 * 60 * 1000;  // refresh resale cache every 12 hours
const RESALE_DELAY_MS   = 1000;                   // 1s between lookups

// Wave mode: activate Thursday 10:50 AM ET, run until 11:30 AM ET
const WAVE_START_HOUR   = 10;
const WAVE_START_MIN    = 50;
const WAVE_END_HOUR     = 11;
const WAVE_END_MIN      = 30;
const WAVE_COOLDOWN_MS  = 30 * 60 * 1000; // extend wave 30 min after last restock

// ─── STATE ───────────────────────────────────────────────────────────────────

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
  const now = new Date();
  // Convert to ET (UTC-4 during summer / EDT)
  const etOffset = -4;
  const et = new Date(now.getTime() + etOffset * 60 * 60 * 1000);
  const h = et.getUTCHours();
  const m = et.getUTCMinutes();
  const isThursday = et.getUTCDay() === 4;
  const inWindow = isThursday &&
    (h > WAVE_START_HOUR || (h === WAVE_START_HOUR && m >= WAVE_START_MIN)) &&
    (h < WAVE_END_HOUR   || (h === WAVE_END_HOUR   && m <  WAVE_END_MIN));

  if (inWindow && !inWave) {
    inWave = true;
    lastRestockAt = Date.now();
    console.log(`[${ts()}] 📅 📅 Thursday drop window open — wave mode ON`);
  } else if (inWave && !inWindow && Date.now() - lastRestockAt > WAVE_COOLDOWN_MS) {
    inWave = false;
    console.log(`[${ts()}] 💤 💤 Wave mode OFF — returning to quiet mode`);
  }
}

// ─── CURRENCY & EXCHANGE RATES ──────────────────────────────────────────────
// Converts Grailed/StockX USD prices → local currency. Refreshed once per day.

const CURRENCY_SYMBOLS = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', SGD: 'S$' };

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
      console.log(`[FX] Rates updated — GBP:${data.rates.GBP} EUR:${data.rates.EUR} JPY:${data.rates.JPY} SGD:${data.rates.SGD}`);
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const ts     = () => new Date().toISOString().slice(11, 19);
const pick   = arr => arr[Math.floor(Math.random() * arr.length)];
const jitter = () => new Promise(r => setTimeout(r, 300 + Math.random() * 700));

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
];

const LANGS = ['en-US,en;q=0.9', 'en-GB,en;q=0.9', 'en-US,en;q=0.8,es;q=0.6'];

// ─── PROXY POOL ──────────────────────────────────────────────────────────────
// Three input sources, all optional, merged into one pool:
//   1. proxies.txt (or $PROXIES_PATH) — one per line, file-based (existing)
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
  // 1. file
  try {
    const raw = fs.readFileSync(process.env.PROXIES_PATH || 'proxies.txt', 'utf8');
    inputs.push(...raw.split('\n'));
  } catch { /* no file is fine */ }
  // 2. PROXIES env (list)
  if (process.env.PROXIES) inputs.push(...process.env.PROXIES.split(/[\n,]/));
  // 3. PROXY env (singular shorthand)
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

// ─── FETCH PAGE ──────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const proxy = proxyPool.next();
  const agent = proxy ? new HttpsProxyAgent(proxy.url) : undefined;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':                pick(UAS),
        'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language':           pick(LANGS),
        'Accept-Encoding':           'gzip, deflate, br',
        'Connection':                'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest':            'document',
        'Sec-Fetch-Mode':            'navigate',
        'Sec-Fetch-Site':            'none',
        'Sec-Fetch-User':            '?1',
        'Cache-Control':             'max-age=0',
      },
      agent,
      signal: ctrl.signal,
      redirect: 'follow',
    });

    clearTimeout(timer);

    if ([403, 429, 503].includes(res.status)) {
      proxyPool.ban(proxy);
      // Diagnostic dump on blocks so we can see WHY (Cloudflare challenge vs
      // raw rate limit vs proxy auth fail), WHERE (which proxy / direct), and
      // any retry-after hint.
      let body = '';
      try { body = (await res.text()).slice(0, 200); } catch {}
      const via   = proxy ? proxy.url.replace(/:[^@:/]+@/, ':***@') : 'DIRECT (no proxy in use)';
      const cfRay = res.headers.get('cf-ray')      || '-';
      const ra    = res.headers.get('retry-after') || '-';
      const srv   = res.headers.get('server')      || '-';
      console.warn(`[Blocked] ${res.status} ${url} | via=${via} | server=${srv} | cf-ray=${cfRay} | retry-after=${ra} | body="${body.replace(/\s+/g, ' ').trim()}"`);
      throw new Error(`Blocked: ${res.status}`);
    }

    proxyPool.ok(proxy);
    const finalHost     = new URL(res.url).hostname;
    const requestedHost = new URL(url).hostname;
    if (finalHost !== requestedHost && !['shop.supreme.com', 'us.supreme.com'].includes(requestedHost)) {
      console.warn(`[Redirect] ${requestedHost} → ${finalHost}`);
    }
    return await res.text();

  } catch (err) {
    clearTimeout(timer);
    if (err.name !== 'AbortError') proxyPool.ban(proxy);
    throw err;
  }
}

// ─── PARSE PRODUCTS FROM HTML ─────────────────────────────────────────────────

function parseProductsFromHtml(html) {
  const tag   = 'id="products-json">';
  const start = html.indexOf(tag);
  if (start === -1) return null;

  const jsonStart = start + tag.length;
  const jsonEnd   = html.indexOf('</script>', jsonStart);
  if (jsonEnd === -1) return null;

  try {
    return JSON.parse(html.slice(jsonStart, jsonEnd).trim());
  } catch (err) {
    console.error('[Parse] Failed to parse products JSON:', err.message);
    return null;
  }
}

// ─── FETCH ALL PRODUCTS ───────────────────────────────────────────────────────

async function fetchAllProducts(region) {
  const allProducts = [];
  const seenIds = new Set();
  let complete = true;
  const collections = region.collections || [region.collection || 'all'];

  for (const collection of collections) {
  let page = 1;
  while (true) {
    const url = `${region.baseUrl}/collections/${collection}?page=${page}`;
    let html;
    let fetchError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        html = await fetchPage(url);
        fetchError = null;
        break;
      } catch (err) {
        fetchError = err;
        if (attempt < 3) {
          console.warn(`[${ts()}][${region.webhookKey}] Page ${page} attempt ${attempt} failed — retrying in 3s...`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }
    if (fetchError) {
      console.error(`[${ts()}][${region.webhookKey}] Page ${page} failed after 3 attempts: ${fetchError.message}`);
      complete = false;
      break;
    }

    const data = parseProductsFromHtml(html);
    if (!data || !data.products || !data.products.length) {
      // Any parse failure (page 1 OR later pages) means we have incomplete data
      // for this collection — must NOT commit it to the snapshot, otherwise the
      // missing variants get re-flagged as new/restock on the next full fetch.
      if (page === 1) {
        console.error(`[${ts()}][${region.webhookKey}] Could not find products-json in HTML for ${collection}`);
      } else {
        console.warn(`[${ts()}][${region.webhookKey}] Page ${page} of ${collection} parsed empty — marking cycle incomplete`);
      }
      complete = false;
      break;
    }

    for (const product of data.products) {
      const pid = product.url || product.title;
      if (!seenIds.has(pid)) {
        seenIds.add(pid);
        allProducts.push(product);
      }
    }

    const total = data.allProductsCount || 0;
    if (seenIds.size >= total || data.products.length < 250) break;

    page++;
    await jitter();
  }
  } // end collections loop

  return { products: allProducts, complete };
}

// ─── RESALE LOOKUP ────────────────────────────────────────────────────────────
//
// Strategy:
//   1. KicksDB StockX API (primary) — search by title+colorway, get avg_price +
//      per-size lowest_ask. Requires KICKSDB_API_KEY env var.
//   2. Grailed Algolia (fallback) — scrapes public sold listings if KicksDB
//      has no data or key is not set.
//   3. Build a StockX direct link from the slug if found, else GOAT search URL.

const KICKSDB_API_KEY = process.env.KICKSDB_API_KEY || '';
const KICKSDB_BASE    = 'https://api.kicks.dev';

const resaleCache  = new Map();   // in-memory (loaded from file)
const priceHistory = new Map();

// ── Resale cache persistence ─────────────────────────────────────────────────

function loadResaleCache() {
  try {
    if (fs.existsSync(RESALE_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(RESALE_CACHE_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) resaleCache.set(k, v);
      console.log(`[Resale] Loaded cache: ${resaleCache.size} items`);
    }
  } catch (err) {
    console.error(`[Resale] Failed to load cache: ${err.message}`);
  }
}

function saveResaleCacheFile() {
  try {
    const obj = {};
    for (const [k, v] of resaleCache) obj[k] = v;
    fs.writeFileSync(RESALE_CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error(`[Resale] Failed to save cache: ${err.message}`);
  }
}

const SIZE_MAP = {
  'XSmall':'XS','X-Small':'XS','Small':'S','Medium':'M','Large':'L',
  'XLarge':'XL','X-Large':'XL','XXLarge':'XXL','XX-Large':'XXL',
};

// ── KicksDB helpers ───────────────────────────────────────────────────────────

async function kicksdbSearch(query) {
  if (!KICKSDB_API_KEY) return null;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(
      `${KICKSDB_BASE}/v3/stockx/products?query=${encodeURIComponent(query)}`,
      {
        headers: { 'Authorization': KICKSDB_API_KEY, 'Accept': 'application/json' },
        signal: ctrl.signal,
      }
    );
    clearTimeout(timer);
    if (!res.ok) { console.warn(`[KicksDB] Search ${res.status}`); return null; }
    const data = await res.json();
    return data.data?.[0] || null; // top result
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[KicksDB] Search failed: ${err.message}`);
    return null;
  }
}

async function kicksdbVariants(productId) {
  if (!KICKSDB_API_KEY) return null;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  try {
    const res = await fetch(
      `${KICKSDB_BASE}/v3/stockx/products/${productId}?display[variants]=true`,
      {
        headers: { 'Authorization': KICKSDB_API_KEY, 'Accept': 'application/json' },
        signal: ctrl.signal,
      }
    );
    clearTimeout(timer);
    if (!res.ok) { console.warn(`[KicksDB] Variants ${res.status}`); return null; }
    const data = await res.json();
    return data.data?.variants || null;
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[KicksDB] Variants failed: ${err.message}`);
    return null;
  }
}

// ── Grailed Algolia fallback ──────────────────────────────────────────────────

// Grailed Algolia — public credentials (refreshed from __NEXT_DATA__ each session)
const GRAILED_ALGOLIA = {
  appId:      'MNRWEFSS2Q',
  searchKey:  'c89dbaddf15fe70e1941a109bf7c2a3d',   // publicSearchKey
  soldIndex:  'Listing_sold_production',             // most-recent sold first
  refreshedAt: 0,
};

async function refreshGrailedCredentials() {
  // Re-fetch at most once per hour
  if (Date.now() - GRAILED_ALGOLIA.refreshedAt < 60 * 60 * 1000) return;

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
    const res   = await fetch('https://www.grailed.com', {
      headers: { 'User-Agent': pick(UAS), 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);

    const html    = await res.text();
    const marker  = '__NEXT_DATA__';
    const idx     = html.indexOf(marker);
    if (idx === -1) return;

    const start    = html.indexOf('>', idx) + 1;
    const end      = html.indexOf('</script>', start);
    const nextData = JSON.parse(html.slice(start, end));
    const algolia  = nextData?.props?.initialProps?.globalData?.public_config?.algolia;

    if (algolia?.appId && (algolia.publicSearchKey || algolia.apiKey)) {
      GRAILED_ALGOLIA.appId     = algolia.appId;
      GRAILED_ALGOLIA.searchKey = algolia.publicSearchKey || algolia.apiKey;
      GRAILED_ALGOLIA.refreshedAt = Date.now();
      console.log(`[Resale] Grailed credentials refreshed (appId: ${GRAILED_ALGOLIA.appId})`);
    }
  } catch (err) {
    console.warn(`[Resale] Could not refresh Grailed credentials: ${err.message} — using hardcoded fallback`);
  }
}

async function grailedQuery(index, query) {
  const { appId, searchKey } = GRAILED_ALGOLIA;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);

  const res = await fetch(
    `https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/${index}/query`,
    {
      method:  'POST',
      headers: {
        'X-Algolia-Application-Id': appId,
        'X-Algolia-API-Key':        searchKey,
        'Content-Type':             'application/json',
      },
      body: JSON.stringify({
        query,
        hitsPerPage:          30,
        attributesToRetrieve: ['title', 'designer_names', 'sold_price', 'price', 'size', 'category'],
      }),
      signal: ctrl.signal,
    }
  );
  clearTimeout(timer);
  if (!res.ok) throw new Error(`Algolia ${res.status}`);
  const data = await res.json();
  return data.hits || [];
}

function medianPrice(hits) {
  const prices = hits
    .map(h => h.sold_price ?? h.price?.amount)
    .filter(p => p != null && p > 5 && p < 50000);
  if (!prices.length) return null;
  prices.sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  return {
    median: Math.round(prices.length % 2 !== 0 ? prices[mid] : (prices[mid-1] + prices[mid]) / 2),
    count: prices.length,
  };
}

async function fetchResaleData(title, colorway, sku, handle) {
  const key    = `${title}::${colorway || ''}`;
  const cached = resaleCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < RESALE_REFRESH_MS) return cached;

  const goatQuery = encodeURIComponent(`supreme ${title}${colorway ? ' ' + colorway : ''}`);
  const goatUrl   = `https://www.goat.com/search?query=${goatQuery}`;

  let overallResale = null;
  let sizeResale    = {};
  let resaleSource  = null;
  let stockxUrl     = goatUrl;

  // ── Pass 1: KicksDB StockX (primary) ─────────────────────────────────────────
  if (KICKSDB_API_KEY) {
    const searchQuery = `Supreme ${title}${colorway ? ' ' + colorway : ''}`;
    console.log(`[Resale] KicksDB lookup: "${searchQuery}"`);
    const product = await kicksdbSearch(searchQuery);

    if (product) {
      console.log(`[Resale] KicksDB ✓ "${product.title}" — avg: $${product.avg_price} (rank: ${product.rank})`);
      overallResale = product.avg_price ? Math.round(product.avg_price) : null;
      resaleSource  = 'StockX (KicksDB)';
      if (product.link) stockxUrl = product.link;

      // Fetch per-size lowest_ask
      const variants = await kicksdbVariants(product.id);
      if (variants?.length) {
        for (const v of variants) {
          if (v.size && v.lowest_ask) {
            const sizeKey = v.size.toString().toUpperCase().replace('US ', '');
            sizeResale[sizeKey] = v.lowest_ask;
          }
        }
        console.log(`[Resale] KicksDB variants: ${Object.keys(sizeResale).length} sizes with ask data`);
      }
    } else {
      console.log(`[Resale] KicksDB: no results for "${searchQuery}" — falling back to Grailed`);
    }
  }

  // ── Pass 2: Grailed Algolia (fallback) ────────────────────────────────────────
  if (overallResale === null) {
    await refreshGrailedCredentials();

    const words      = title.split(/\s+/);
    const shortTitle = words.slice(0, Math.max(3, Math.ceil(words.length / 2))).join(' ');
    const queries = [
      `Supreme ${title}${colorway ? ' ' + colorway : ''}`,
      `Supreme ${title}`,
      `Supreme ${shortTitle}`,
    ].filter((q, i, arr) => arr.indexOf(q) === i);

    console.log(`[Resale] Grailed sold lookup: "${queries[0]}"`);

    try {
      for (const q of queries) {
        const hits   = await grailedQuery(GRAILED_ALGOLIA.soldIndex, q);
        const result = medianPrice(hits);
        if (result) {
          overallResale = result.median;
          resaleSource  = 'Grailed (sold)';
          console.log(`[Resale] Grailed sold ✓ "${title}" — median: $${overallResale} (${result.count} listings, query: "${q}")`);
          break;
        }
        console.log(`[Resale] Grailed sold: 0 hits for "${q}"`);
      }

      if (overallResale === null) {
        console.log(`[Resale] No sold data — trying active Grailed listings...`);
        for (const q of queries) {
          const hits   = await grailedQuery('Listing_by_heat_production', q);
          const result = medianPrice(hits);
          if (result) {
            overallResale = result.median;
            resaleSource  = 'Grailed (ask)';
            console.log(`[Resale] Grailed ask ✓ "${title}" — median ask: $${overallResale} (${result.count} listings, query: "${q}")`);
            break;
          }
          console.log(`[Resale] Grailed ask: 0 hits for "${q}"`);
        }
      }
    } catch (err) {
      console.warn(`[Resale] Grailed fetch failed: ${err.message}`);
    }
  }

  if (overallResale) {
    const h = priceHistory.get(key) || [];
    h.push(overallResale);
    if (h.length > 10) h.shift();
    priceHistory.set(key, h);
  }

  let trend = null;
  const h = priceHistory.get(key) || [];
  if (h.length >= 2) {
    const pct = ((h[h.length-1] - h[h.length-2]) / h[h.length-2]) * 100;
    if (pct > 3) trend = '📈 Rising'; else if (pct < -3) trend = '📉 Falling'; else trend = '→ Stable';
  }

  const result = {
    overallResale,
    sizeResale,
    trend,
    stockxUrl,
    source: resaleSource,
    fetchedAt: Date.now(),
  };
  resaleCache.set(key, result);
  saveResaleCacheFile();
  return result;
}


// ─── BACKGROUND RESALE CACHE REFRESH ────────────────────────────────────────

async function refreshResaleCache() {
  // Find the first active region to fetch product list from
  const activeRegion = Object.entries(REGIONS).find(([key, r]) => {
    const w = WEBHOOKS[r.webhookKey];
    if (!w || w.startsWith('PASTE')) return false;
    if (ACTIVE_REGIONS && !ACTIVE_REGIONS.includes(key)) return false;
    return true;
  });

  if (!activeRegion) {
    console.log(`[Resale] No active region — skipping cache refresh`);
    return;
  }

  const [regionKey, region] = activeRegion;
  console.log(`[Resale] Refreshing cache — fetching ${regionKey} product list...`);
  try {
    const { products } = await fetchAllProducts(region);
    console.log(`[Resale] Found ${products.length} products to cache`);

    let updated = 0;
    let skipped = 0;

    for (const product of products) {
      const title    = product.title;
      const colorway = product.color || null;
      const sku      = product.variants?.[0]?.sku || null;
      const handle   = product.handle || null;
      const key      = `${title}::${colorway || ''}`;

      // Skip if cache is still fresh
      const cached = resaleCache.get(key);
      if (cached && Date.now() - cached.fetchedAt < RESALE_REFRESH_MS) {
        skipped++;
        continue;
      }

      const data = await fetchResaleData(title, colorway, sku, handle);
      if (data?.overallResale) updated++;

      // Be polite — 1s between lookups
      await new Promise(r => setTimeout(r, RESALE_DELAY_MS));
    }

    saveResaleCacheFile();
    console.log(`[Resale] Cache refresh done: ${updated} updated, ${skipped} still fresh, ${products.length} total`);
  } catch (err) {
    console.error(`[Resale] Cache refresh failed: ${err.message}`);
  }
}

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

// ─── DISCORD RATE LIMIT QUEUE ─────────────────────────────────────────────────

const alertQueue    = [];
const alertCooldown = new Map();
const ALERT_COOLDOWN_WAVE_MS  = 30 * 1000;
const ALERT_COOLDOWN_QUIET_MS = 5 * 60 * 1000;
let   queueRunning  = false;

async function queueAlert(payload, cooldownKey) {
  if (cooldownKey) {
    const cooldownMs = inWave ? ALERT_COOLDOWN_WAVE_MS : ALERT_COOLDOWN_QUIET_MS;
    const last = alertCooldown.get(cooldownKey);
    if (last && Date.now() - last < cooldownMs) {
      console.log(`[${ts()}] Skipping duplicate (cooldown ${cooldownMs/1000}s): ${cooldownKey}`);
      return;
    }
    alertCooldown.set(cooldownKey, Date.now());
  }

  alertQueue.push(payload);
  if (!queueRunning) processQueue();
}

async function processQueue() {
  queueRunning = true;
  while (alertQueue.length > 0) {
    const payload = alertQueue.shift();
    try {
      const res = await fetch(payload.webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload.body),
      });
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const wait = ((data.retry_after || 1) + 0.1) * 1000;
        console.log(`[Discord] Rate limited — waiting ${wait}ms`);
        alertQueue.unshift(payload);
        await new Promise(r => setTimeout(r, wait));
      } else if (!res.ok) {
        const errText = await res.text();
        console.error(`[Discord] ${res.status} — ${errText}`);
        if (res.status === 400) {
          console.error(`[Discord] Payload debug: ${JSON.stringify(payload.body.embeds?.[0]?.title)} | fields: ${payload.body.embeds?.[0]?.fields?.map(f => f.name + '=' + (f.value?.slice(0,30) || 'EMPTY')).join(', ')}`);
        }
      }
    } catch (err) {
      console.error(`[Discord] Send failed: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 600));
  }
  queueRunning = false;
}

// ─── DISCORD ALERT ────────────────────────────────────────────────────────────

const fmt = n => n != null ? `$${Number(n).toFixed(0)}` : null;

async function postRestockAlert({ region, productTitle, colorway, category, productUrl, imageUrl, restocked, allInStock, isNewItem, resaleData, retailPrice }) {
  const { overallResale: rawResale, sizeResale: rawSizeResale, trend, stockxUrl, source } = resaleData;

  // Convert USD resale → local currency for non-US regions
  const currCode = region.currency || 'USD';
  const isConverted = currCode !== 'USD';
  const sym = CURRENCY_SYMBOLS[currCode] || '$';
  const approx = isConverted ? '≈' : '';
  const overallResale = isConverted && rawResale != null ? convertUSD(rawResale, currCode) : rawResale;
  const sizeResale = {};
  for (const [size, price] of Object.entries(rawSizeResale || {})) {
    sizeResale[size] = isConverted ? convertUSD(price, currCode) : price;
  }

  const fmtP = n => n != null ? `${sym}${Number(n).toFixed(0)}` : null;
  const fmtR = n => n != null ? `${approx}${sym}${Number(n).toFixed(0)}` : null;
  const resaleLabel = source === 'StockX (KicksDB)' ? '💰 Avg (StockX)' : source === 'Grailed (ask)' ? '💰 Avg Ask (Grailed)' : '💰 Avg Resale (Grailed)';
  const hasData = overallResale != null || Object.values(sizeResale).some(p => p != null);

  const buildLine = (v, isNew = false) => {
    const mapped    = SIZE_MAP[v.sizeName] || v.sizeName;
    const sp        = sizeResale[mapped] || overallResale || null;
    const profit    = sp && retailPrice ? sp - retailPrice : null;
    const indicator = !hasData ? '🆕' : sp == null ? '❓' : profit > 0 ? '🟢' : '🔴';
    const priceStr  = sp ? ` · ${fmtR(sp)}${profit != null ? (profit > 0 ? ` (+${fmtR(profit)})` : ` (-${fmtR(Math.abs(profit))})`) : ''}` : '';
    return `${indicator} **[${v.sizeName}](${v.atcUrl})**${priceStr}${isNew ? '  🔔' : ''}`;
  };

  const restockedNames = new Set(restocked.map(v => v.sizeName));
  const restockedLines = restocked.map(v => buildLine(v, true)).join('\n');
  const allLines       = (allInStock || restocked).map(v => buildLine(v, restockedNames.has(v.sizeName))).join('\n');

  const anyProfit = hasData && restocked.some(v => {
    const sp = sizeResale[SIZE_MAP[v.sizeName] || v.sizeName] || overallResale || null;
    return sp && retailPrice && sp > retailPrice;
  });
  const ratio = overallResale && retailPrice ? overallResale / retailPrice : 1;
  const color = !hasData ? 0x3498DB : !anyProfit ? 0xE74C3C : ratio >= 2.0 ? 0x00C853 : ratio >= 1.5 ? 0x2ECC71 : 0xF1C40F;
  const badge = isNewItem
    ? (anyProfit ? '🟢 NEW ITEM —' : '🆕 NEW ITEM —')
    : (anyProfit ? '🟢 RESTOCK —'  : '🔴 RESTOCK —');

  const fields = hasData
    ? [
        { name: '🏷️ Retail',     value: fmtP(retailPrice)   || 'N/A', inline: true },
        { name: resaleLabel,      value: fmtR(overallResale) || 'N/A', inline: true },
        { name: '📈 Trend',       value: trend || '—',               inline: true },
      ]
    : [
        { name: '🏷️ Retail',  value: fmtP(retailPrice) || 'N/A', inline: true },
        { name: '💰 Resale',  value: '🆕 No data yet',              inline: true },
        { name: '📈 Trend',   value: '— New item',                 inline: true },
      ];

  fields.push(
    { name: '🗂️ Category',             value: category || '—',  inline: true },
    { name: `${region.flag} Region`,   value: region.label || '—',     inline: true },
    { name: '🔗 GOAT',                 value: stockxUrl ? `[Search GOAT](${stockxUrl})` : 'N/A', inline: true },
    { name: `🔔 Just Restocked (${restocked.length})`,  value: restockedLines || '—', inline: false },
    {
      name: hasData
        ? `📦 All In Stock (${(allInStock || restocked).length}) — 🟢 profit  🔴 at/below retail  ❓ no size data  🔔 just restocked`
        : `📦 All In Stock (${(allInStock || restocked).length}) — 🆕 New item, resale appears after first sales  🔔 just restocked`,
      value:  allLines || '—',
      inline: false,
    },
  );

  // Ensure no empty field values — Discord rejects embeds with empty strings
  for (const f of fields) {
    if (!f.value || f.value.trim() === '') f.value = '—';
  }

  const webhookUrl = WEBHOOKS[region.webhookKey];
  if (!webhookUrl || webhookUrl.startsWith('PASTE')) return;

  const cooldownKey = `${region.webhookKey}:${productTitle}:${colorway || ''}`;

  await queueAlert({
    webhookUrl,
    body: {
      embeds: [{
        title:       `${badge}: ${productTitle}${colorway ? ` — ${colorway}` : ''}`,
        url:         productUrl,
        color,
        thumbnail:   imageUrl ? { url: imageUrl } : undefined,
        fields,
        footer:      { text: `Finest Monitors | ${region.label} | ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short' })}` },
        timestamp:   new Date().toISOString(),
      }],
    },
  }, cooldownKey);
}

// ─── SNAPSHOT ─────────────────────────────────────────────────────────────────

const previousStock = new Map();
const firstRunDone  = {};
let   isFirstRun    = true;

function saveSnapshot() {
  try {
    const obj = {};
    for (const [k, v] of previousStock) obj[k] = v;
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[Snapshot] Save failed:', e.message);
  }
}

function loadSnapshot() {
  try {
    const obj = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    for (const [k, v] of Object.entries(obj)) {
      previousStock.set(k, v);
    }
    for (const regionKey of Object.keys(REGIONS)) {
      const hasRegionData = [...previousStock.keys()].some(k => k.startsWith(regionKey + ':'));
      if (hasRegionData) firstRunDone[regionKey] = true;
    }
    const doneRegions = Object.keys(firstRunDone).join(', ');
    if (doneRegions) console.log(`[Snapshot] Loaded — ${previousStock.size} variants (${doneRegions} ready)`);
    if (Object.keys(firstRunDone).length > 0) isFirstRun = false;
  } catch {
    // No snapshot file yet — normal on first run
  }
}

// ─── STOCK CHECK ──────────────────────────────────────────────────────────────

async function checkStock(region) {
  await jitter();
  const { products, complete } = await fetchAllProducts(region);

  if (products.length < 10) {
    console.warn(`[${ts()}][${region.webhookKey}] Too few products (${products.length}) — skipping cycle`);
    return;
  }

  // Log first 3 product names for region verification
  const sample = products.slice(0, 3).map(p => `${p.title}${p.color ? ' — ' + p.color : ''}`);
  console.log(`[${ts()}][${region.webhookKey}] ${products.length} products | Sample: ${sample.join(' | ')}`);

  if (!complete) {
    console.warn(`[${ts()}][${region.webhookKey}] Incomplete fetch — alerting on partial data, snapshot unchanged`);
  }

  const pendingStock = new Map(previousStock);
  for (const [key] of previousStock) {
    if (key.startsWith(region.webhookKey + ':')) pendingStock.delete(key);
  }

  let restocksThisCycle = 0;
  const pendingAlerts   = [];

  for (const product of products) {
    const productTitle = product.title;
    const colorway     = product.color || null;
    const productUrl   = `${region.baseUrl}${product.url}`;
    const imageUrl     = product.image ? `https:${product.image}` : null;
    const category     = product.product_type || '—';
    const variants     = product.variants || [];

    const restocked  = [];
    const allInStock = [];

    for (const variant of variants) {
      const key      = `${region.webhookKey}:${variant.id}`;
      const sizeName = variant.title;
      const atcUrl   = `${region.baseUrl}/cart/${variant.id}:1?storefront=true`;
      const price    = variant.price ? variant.price / 100 : null;

      if (!isFirstRun && firstRunDone[region.webhookKey] && variant.available) {
        const prev = previousStock.get(key);
        if (prev === false) {
          restocked.push({ sizeName, atcUrl, price, isNew: false });
        } else if (prev === undefined) {
          restocked.push({ sizeName, atcUrl, price, isNew: true });
        }
      }

      if (variant.available) {
        allInStock.push({ sizeName, atcUrl, price });
        pendingStock.set(key, true);
      } else {
        pendingStock.set(key, false);
      }
    }

    if (!restocked.length) continue;

    // Collect — do not fire alerts inline. We apply a sanity check below to
    // catch snapshot-reset false positives before they spam Discord.
    restocksThisCycle++;
    pendingAlerts.push({ product, productTitle, colorway, category, productUrl, imageUrl, restocked, allInStock });
  }

  // Sanity check: a single cycle "restocking" many products outside the drop
  // window is almost always snapshot drift from a silently-bad prior fetch.
  // During the wave window (Thursday drop or recent-restock cooldown), legit
  // bursts of 30–70+ items are expected — use a much higher threshold then.
  // Snapshot still updates either way so suppressed cycles re-baseline quietly.
  const MAX_RESTOCKS_QUIET = Number(process.env.MAX_RESTOCKS_PER_CYCLE ?? 10);
  const MAX_RESTOCKS_WAVE  = Number(process.env.MAX_RESTOCKS_PER_WAVE_CYCLE ?? 250);
  const restockThreshold   = inWave ? MAX_RESTOCKS_WAVE : MAX_RESTOCKS_QUIET;
  if (pendingAlerts.length > restockThreshold) {
    console.warn(`[${ts()}][${region.webhookKey}] ⚠️ Suppressed ${pendingAlerts.length} restock alerts (> ${restockThreshold}, ${inWave ? 'wave' : 'quiet'} mode). Likely snapshot drift — re-baselining without spamming. Items: ${pendingAlerts.slice(0, 5).map(a => a.productTitle).join(', ')}${pendingAlerts.length > 5 ? ', ...' : ''}`);
  } else {
    for (const a of pendingAlerts) {
      onRestockDetected();
      console.log(`[${ts()}][${region.webhookKey}] 👀 ${a.productTitle} (${a.colorway}) — looking up resale...`);
      const sku         = a.product.variants?.[0]?.sku || null;
      const handle      = a.product.handle || null;
      const resaleData  = await fetchResaleData(a.productTitle, a.colorway, sku, handle);
      const retailPrice = a.restocked[0]?.price || null;
      const isNewItem   = a.restocked.some(r => r.isNew);

      await postRestockAlert({
        region, productTitle: a.productTitle, colorway: a.colorway, category: a.category,
        productUrl: a.productUrl, imageUrl: a.imageUrl,
        restocked: a.restocked, allInStock: a.allInStock,
        isNewItem,
        resaleData: resaleData || {
          retailPrice, overallResale: null, sizeResale: {}, trend: null, stockxUrl: null, source: null,
        },
        retailPrice,
      });
    }
  }

  if (complete) {
    for (const [key] of [...previousStock]) {
      if (key.startsWith(region.webhookKey + ':')) previousStock.delete(key);
    }
    for (const [key, val] of pendingStock) {
      if (key.startsWith(region.webhookKey + ':')) previousStock.set(key, val);
    }

    if (!firstRunDone[region.webhookKey]) {
      console.log(`[${ts()}][${region.webhookKey}] ✅ Snapshot done — ${previousStock.size} variants tracked`);
      firstRunDone[region.webhookKey] = true;
    }

    if (Object.keys(firstRunDone).length >= Object.keys(REGIONS).filter(k => {
      const w = WEBHOOKS[k]; return w && !w.startsWith('PASTE');
    }).length) {
      isFirstRun = false;
    }
    saveSnapshot();
  } else {
    console.warn(`[${ts()}][${region.webhookKey}] Snapshot NOT updated (incomplete fetch)`);
  }

  if (restocksThisCycle > 0) {
    console.log(`[${ts()}] ${restocksThisCycle} restock(s) this cycle`);
  }

  checkWaveStatus();
}

// ─── POLL CYCLE ───────────────────────────────────────────────────────────────

async function pollCycle() {
  const fmtInterval = (ms) => ms >= 60000 ? `${ms / 60000}m` : `${ms / 1000}s`;
  const mode = inWave ? `wave (${fmtInterval(FAST_POLL_MS)})` : `quiet (${fmtInterval(SLOW_POLL_MS)})`;
  console.log(`[${ts()}] Polling... [${mode}]`);

  const activeRegions = Object.values(REGIONS).filter(r => {
    const w = WEBHOOKS[r.webhookKey];
    if (!w || w.startsWith('PASTE')) return false;
    if (ACTIVE_REGIONS && !ACTIVE_REGIONS.includes(r.webhookKey)) return false;
    return true;
  });

  await Promise.allSettled(activeRegions.map(r => checkStock(r)));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔴 Supreme Monitor starting...');

  const activeWebhooks = Object.entries(WEBHOOKS).filter(([, v]) => v && !v.startsWith('PASTE'));
  if (!activeWebhooks.length) {
    console.error('No webhooks configured! Paste your Discord webhook URLs in the WEBHOOKS config.');
    process.exit(1);
  }
  console.log(`✅ Webhooks active: ${activeWebhooks.map(([k]) => k).join(', ')}`);

  loadSnapshot();
  loadResaleCache();
  await refreshExchangeRates();
  checkWaveStatus();

  console.log(`Resale cache: ${resaleCache.size} items, refreshes every ${RESALE_REFRESH_MS / 1000 / 60 / 60}h`);

  // Start resale cache refresh in background (waits 60s for first snapshot to build)
  setTimeout(() => resaleCacheLoop().catch(err => console.error('[Resale] Loop error:', err)), 60 * 1000);

  while (true) {
    try {
      await pollCycle();
    } catch (err) {
      console.error(`[${ts()}] Poll error:`, err.message);
    }

    const delay = inWave ? FAST_POLL_MS : SLOW_POLL_MS;
    await new Promise(r => setTimeout(r, delay));
  }
}

async function testLiveAlert() {
  const region = REGIONS.US;
  const TARGET_SLUG = 'l6waldktjrs4gntj';
  console.log(`Searching for product "${TARGET_SLUG}" in collections feed...`);

  const { products } = await fetchAllProducts(region);
  if (!products.length) { console.error('No products found!'); return; }

  const product = products.find(p => p.url && p.url.includes(TARGET_SLUG));
  if (!product) {
    console.error(`Product not found! Available slugs (first 5):`);
    products.slice(0, 5).forEach(p => console.log(' ', p.url));
    return;
  }

  const productTitle = product.title;
  const colorway     = product.color || null;
  const productUrl   = `${region.baseUrl}${product.url}`;
  const imageUrl     = product.image ? `https:${product.image}` : null;
  const category     = product.product_type || '—';

  const allInStock = product.variants.map(v => ({
    sizeName: v.title,
    atcUrl:   `${region.baseUrl}/cart/${v.id}:1?storefront=true`,
    price:    v.price ? v.price / 100 : null,
  }));

  const restocked = allInStock.map(v => ({ ...v, isNew: false }));

  console.log(`Testing with: ${productTitle} (${colorway}) — ${allInStock.length} sizes`);
  const sku    = product.variants?.[0]?.sku || null;
  const handle = product.handle || null;
  const resaleData = await fetchResaleData(productTitle, colorway, sku, handle);

  await postRestockAlert({
    region, productTitle, colorway, category,
    productUrl, imageUrl,
    restocked, allInStock,
    isNewItem: false,
    retailPrice: restocked[0]?.price || null,
    resaleData: resaleData || {
      overallResale: null, sizeResale: {}, trend: null, stockxUrl: null, source: null,
    },
  });
  console.log('Test alert sent! Check Discord.');
}

// To test a single alert: comment out main() and uncomment testLiveAlert()
// testLiveAlert();
main();