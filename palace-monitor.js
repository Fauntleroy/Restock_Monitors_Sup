// Palace Skateboards Restock Monitor
// Regions: US, UK
// Features: password-page alert, NEW vs RESTOCK detection, Grailed resale lookup, GOAT link, wave mode, ATC links
//
// SETUP:
//   1. Run: npm install  (same node_modules as supreme monitor)
//   2. Run: node palace-monitor.js

import fetch from 'node-fetch';
import fs    from 'fs';
import { HttpsProxyAgent } from 'https-proxy-agent';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const WEBHOOKS = {
  US: 'https://discord.com/api/webhooks/1427398239870521395/TJfg_sylutNAoZWje7ywIHQrySorEf5hOmxIFmQSute5UtzZYPhwK74__vpIJJvg1l_8',
  UK: 'https://discord.com/api/webhooks/1427398257469952060/w8xhUzr1iLbw2iRywgPTLDKUtbiQZEzrnBzWnt5zUivM8WYUjlCONtu_RWeuGe7AIafu',
};

const REGIONS = {
  US: { label:'Palace US', flag:'🇺🇸', baseUrl:'https://shop-usa.palaceskateboards.com', currency:'USD', webhookKey:'US' },
  UK: { label:'Palace UK', flag:'🇬🇧', baseUrl:'https://shop.palaceskateboards.com',     currency:'GBP', webhookKey:'UK' },
};

const SLOW_POLL_MS    = 5 * 60 * 1000;   // 5 min quiet mode
const FAST_POLL_MS    = 15 * 1000;       // 15 sec wave mode
const REQUEST_TIMEOUT = 15 * 1000;
const SNAPSHOT_FILE   = 'palace-snapshot.json';

// Wave mode: Palace drops Fridays
//   UK  — 11:00 AM GMT  → activate 10:50 UTC, end 11:30 UTC
//   US  — 11:00 AM ET   → activate 15:50 UTC, end 16:30 UTC
const WAVE_COOLDOWN_MS = 30 * 60 * 1000;

// ─── STATE ───────────────────────────────────────────────────────────────────

let inWave        = false;
let lastRestockAt = 0;

// Track password-page state per region so we only alert on change
const passwordState = { US: null, UK: null }; // null = unknown, true = up, false = down

function onRestockDetected() {
  lastRestockAt = Date.now();
  if (!inWave) {
    inWave = true;
    console.log(`[${ts()}] 🌊 Wave mode ON`);
  }
}

function checkWaveStatus() {
  const now   = new Date();
  const h     = now.getUTCHours();
  const m     = now.getUTCMinutes();
  const isFri = now.getUTCDay() === 5;

  const inUkWindow = isFri && (h > 10 || (h === 10 && m >= 50)) && (h < 11 || (h === 11 && m < 30));
  const inUsWindow = isFri && (h > 15 || (h === 15 && m >= 50)) && (h < 16 || (h === 16 && m < 30));
  const inWindow   = inUkWindow || inUsWindow;

  if (inWindow && !inWave) {
    inWave = true;
    lastRestockAt = Date.now();
    const which = inUkWindow ? 'UK' : 'US';
    console.log(`[${ts()}] 📅 Friday ${which} drop window — wave mode ON`);
  } else if (inWave && !inWindow && Date.now() - lastRestockAt > WAVE_COOLDOWN_MS) {
    inWave = false;
    console.log(`[${ts()}] 💤 Wave mode OFF`);
  }
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

// ─── COOKIE-AWARE FETCH ───────────────────────────────────────────────────────
//
// Shopify does a cookie-handshake redirect on first visit (_shopify_visit).
// node-fetch follows redirects without re-sending cookies, causing an infinite
// loop. We handle redirects manually, collecting Set-Cookie headers each hop.

async function fetchWithCookies(url, options = {}, agent) {
  const cookies = new Map();
  let currentUrl = url;

  for (let hop = 0; hop < 15; hop++) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);

    const cookieHeader = cookies.size > 0
      ? [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
      : undefined;

    const res = await fetch(currentUrl, {
      ...options,
      headers: {
        ...options.headers,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      agent,
      signal:   ctrl.signal,
      redirect: 'manual',   // we handle redirects ourselves
    });
    clearTimeout(timer);

    // Collect any Set-Cookie headers
    const raw = res.headers.raw?.() ?? {};
    for (const cookie of (raw['set-cookie'] || [])) {
      const [nameVal] = cookie.split(';');
      const eqIdx = nameVal.indexOf('=');
      if (eqIdx > 0) {
        cookies.set(nameVal.slice(0, eqIdx).trim(), nameVal.slice(eqIdx + 1).trim());
      }
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) break;
      currentUrl = loc.startsWith('http') ? loc : new URL(loc, currentUrl).href;
      continue;
    }

    return { res, finalUrl: currentUrl };
  }

  throw new Error(`maximum redirect reached at: ${currentUrl}`);
}

// ─── PROXY POOL ──────────────────────────────────────────────────────────────

const proxyLines = (() => {
  try { return fs.readFileSync('proxies.txt','utf8').split('\n').map(l=>l.trim()).filter(Boolean); }
  catch { return []; }
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

// ─── PASSWORD PAGE CHECK ──────────────────────────────────────────────────────
//
// Palace locks the shop with a Shopify password page before drops.
// We detect this by checking if the main shop URL redirects to /password
// or returns a 401. Alert once when it goes UP, once when it comes DOWN.

async function checkPasswordPage(region) {
  const proxy = proxyPool.next();
  const agent = proxy ? new HttpsProxyAgent(proxy.url) : undefined;

  try {
    const { res, finalUrl } = await fetchWithCookies(
      region.baseUrl + '/',
      {
        headers: {
          'User-Agent':      pick(UAS),
          'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': pick(LANGS),
        },
      },
      agent
    );
    proxyPool.ok(proxy);

    // Password page: landed on /password URL, or got a 401
    const isPasswordUp =
      res.status === 401 ||
      finalUrl.includes('/password');

    // Also check body for inline password forms
    if (!isPasswordUp && res.status === 200) {
      const body = await res.text();
      return body.includes('storefront_password') ||
             body.includes('password_login') ||
             (body.includes('Opening Soon') && body.includes('Palace'));
    }

    return isPasswordUp;

  } catch (err) {
    proxyPool.ban(proxy);
    console.warn(`[${ts()}][${region.webhookKey}] Password check failed: ${err.message}`);
    return null;
  }
}

async function handlePasswordState(region, isUp) {
  if (isUp === null) return; // fetch failed — don't change state

  const prev = passwordState[region.webhookKey];

  if (isUp && prev !== true) {
    // Just went up
    passwordState[region.webhookKey] = true;
    console.log(`[${ts()}][${region.webhookKey}] 🔐 Password page UP — drop incoming!`);
    onRestockDetected(); // kick into wave mode
    await sendPasswordAlert(region, true);

  } else if (!isUp && prev === true) {
    // Just came down — shop is open
    passwordState[region.webhookKey] = false;
    console.log(`[${ts()}][${region.webhookKey}] 🟢 Password page DOWN — shop is OPEN`);
    await sendPasswordAlert(region, false);

  } else if (prev === null) {
    // First check — just record state silently
    passwordState[region.webhookKey] = isUp ? true : false;
    if (isUp) {
      console.log(`[${ts()}][${region.webhookKey}] 🔐 Password page is currently UP`);
    }
  }
}

async function sendPasswordAlert(region, isUp) {
  const webhookUrl = WEBHOOKS[region.webhookKey];
  if (!webhookUrl || webhookUrl.startsWith('PASTE')) return;

  const body = {
    embeds: [{
      title:     isUp
        ? `🔐 Password Page UP — ${region.label}`
        : `🟢 Shop OPEN — ${region.label}`,
      description: isUp
        ? `Palace ${region.flag} has put up the password page.\n**Drop is incoming — get ready!**\n\n[Visit Shop](${region.baseUrl})`
        : `The password page is down — the ${region.label} shop is now open.\n\n[Visit Shop](${region.baseUrl})`,
      color:     isUp ? 0xF39C12 : 0x00C853,
      footer:    { text: `Palace Monitor | ${region.label}` },
      timestamp: new Date().toISOString(),
    }],
  };

  await queueAlert({ webhookUrl, body }, null);
}

// ─── FETCH PRODUCTS (React Flight stream parser) ──────────────────────────────
//
// Palace uses Shopify Hydrogen — a headless React Router app on Oxygen hosting.
// Products are NOT in a JSON API endpoint; they're embedded in the HTML as a
// React Flight (server-component) stream in a streamController.enqueue() call.
//
// The stream is a flat reference array where objects use {"_KEY_IDX": VAL_IDX}
// shorthand. We decode this to extract product titles, handles, and variant
// availability without needing any API token.

function parseFlightStream(html) {
  // Extract the encoded stream string from: streamController.enqueue("...")
  const marker  = 'streamController.enqueue("';
  const start   = html.indexOf(marker);
  if (start === -1) return null;

  const innerStart = start + marker.length;
  const innerEnd   = html.indexOf('");', innerStart);
  if (innerEnd === -1) return null;

  const raw = html.slice(innerStart, innerEnd);

  // The raw value is a JS string literal — parse it as JSON string to unescape
  let decoded;
  try {
    decoded = JSON.parse('"' + raw + '"');
  } catch {
    return null;
  }

  let arr;
  try {
    arr = JSON.parse(decoded);
  } catch {
    return null;
  }

  if (!Array.isArray(arr)) return null;

  // Helper: resolve a ref-dict value
  const val = (v) => (typeof v === 'number' && v >= 0 && v < arr.length) ? arr[v] : null;

  // Decode a ref-dict: {"_KEY_IDX": VAL_IDX, ...} → {key: resolvedVal, ...}
  const decodeObj = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!k.startsWith('_')) continue;
      const keyStr = arr[parseInt(k.slice(1))];
      if (typeof keyStr !== 'string') continue;
      out[keyStr] = val(v);
    }
    return out;
  };

  // Walk array looking for product nodes.
  // Pattern: "tags" → [] → "PRODUCT TITLE" → "variants" → obj → "nodes" → [refs]
  const products = [];

  for (let i = 0; i < arr.length - 4; i++) {
    if (arr[i] !== 'tags') continue;
    if (!Array.isArray(arr[i + 1])) continue;
    const title = arr[i + 2];
    if (typeof title !== 'string' || title.length < 2) continue;

    // Find handle nearby (short alphanumeric ID before tags)
    let handle = null;
    for (let j = Math.max(0, i - 30); j < i; j++) {
      if (typeof arr[j] === 'string' && /^[a-z0-9]{8,14}$/.test(arr[j])) {
        handle = arr[j];
      }
    }

    // Find image nearby
    let imageUrl = null;
    for (let j = i - 30; j < i + 30; j++) {
      if (j < 0 || j >= arr.length) continue;
      if (typeof arr[j] === 'string' && arr[j].startsWith('https://cdn.shopify.com') && arr[j].includes('.jpg')) {
        imageUrl = arr[j];
        break;
      }
    }

    // Find nodes list
    let nodeRefs = null;
    for (let j = i + 3; j < Math.min(i + 15, arr.length); j++) {
      if (arr[j] === 'nodes' && Array.isArray(arr[j + 1])) {
        nodeRefs = arr[j + 1];
        break;
      }
    }
    if (!nodeRefs) continue;

    // Decode each variant
    const variants = [];
    for (const ref of nodeRefs) {
      if (typeof ref !== 'number' || ref < 0 || ref >= arr.length) continue;
      const vObj  = arr[ref];
      if (!vObj || typeof vObj !== 'object') continue;
      const v     = decodeObj(vObj);

      const gid   = v['id'] || '';
      const varId = typeof gid === 'string' ? gid.split('/').pop() : null;

      // Price
      let price = null;
      if (v['price'] && typeof v['price'] === 'object') {
        const p = decodeObj(v['price']);
        price   = p['amount'] != null ? parseFloat(p['amount']) : null;
      }

      // Size from selectedOptions
      let size = null;
      const opts = v['selectedOptions'];
      const optList = Array.isArray(opts) ? opts : (opts ? [opts] : []);
      for (const optRef of optList) {
        const opt     = decodeObj(optRef);
        const optName = opt['name'];
        if (typeof optName === 'string' && optName.toLowerCase() === 'size') {
          const rv = opt['value'];
          size = typeof rv === 'string' ? rv : (rv && typeof rv === 'object' ? decodeObj(rv)['name'] : null);
          break;
        }
      }

      variants.push({
        id:        varId,
        available: v['availableForSale'] === true,
        title:     size || 'One Size',
        price:     price,
      });
    }

    if (variants.length > 0) {
      products.push({ title, handle, imageUrl, variants });
    }
  }

  return products;
}

async function fetchAllProducts(region) {
  // Fetch /collections/new — current season items
  // Fall back to /collections/all if new returns nothing
  const urls = [
    `${region.baseUrl}/collections/new`,
    `${region.baseUrl}/collections/all`,
  ];

  for (const url of urls) {
    let html;
    let fetchError;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const proxy = proxyPool.next();
        const agent = proxy ? new HttpsProxyAgent(proxy.url) : undefined;

        const { res, finalUrl } = await fetchWithCookies(
          url,
          {
            headers: {
              'User-Agent':      pick(UAS),
              'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
              'Accept-Language': pick(LANGS),
            },
          },
          agent
        );

        if (res.status === 401 || finalUrl.includes('/password')) {
          proxyPool.ok(proxy);
          return { products: [], complete: false, passwordProtected: true };
        }

        if ([403, 429, 503].includes(res.status)) {
          proxyPool.ban(proxy);
          throw new Error(`Blocked: ${res.status}`);
        }

        proxyPool.ok(proxy);
        html = await res.text();
        fetchError = null;
        break;

      } catch (err) {
        fetchError = err;
        if (attempt < 3) {
          console.warn(`[${ts()}][${region.webhookKey}] Attempt ${attempt} failed — retrying in 3s...`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    if (fetchError) {
      console.error(`[${ts()}][${region.webhookKey}] Fetch failed: ${fetchError.message}`);
      continue;
    }

    const products = parseFlightStream(html);
    if (products && products.length > 0) {
      console.log(`[${ts()}][${region.webhookKey}] Parsed ${products.length} products from ${url}`);
      return { products, complete: true, passwordProtected: false };
    }

    console.warn(`[${ts()}][${region.webhookKey}] No products parsed from ${url}`);
  }

  return { products: [], complete: false, passwordProtected: false };
}

// ─── RESALE LOOKUP ────────────────────────────────────────────────────────────

const resaleCache  = new Map();
const priceHistory = new Map();

const SIZE_MAP = {
  'XSmall':'XS','X-Small':'XS','Small':'S','Medium':'M','Large':'L',
  'XLarge':'XL','X-Large':'XL','XXLarge':'XXL','XX-Large':'XXL',
};

const GRAILED_ALGOLIA = {
  appId:       'MNRWEFSS2Q',
  searchKey:   'c89dbaddf15fe70e1941a109bf7c2a3d',
  soldIndex:   'Listing_sold_production',
  refreshedAt: 0,
};

async function refreshGrailedCredentials() {
  if (Date.now() - GRAILED_ALGOLIA.refreshedAt < 60 * 60 * 1000) return;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
    const res   = await fetch('https://www.grailed.com', {
      headers: { 'User-Agent': pick(UAS), 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: ctrl.signal, redirect: 'follow',
    });
    clearTimeout(timer);
    const html     = await res.text();
    const idx      = html.indexOf('__NEXT_DATA__');
    if (idx === -1) return;
    const start    = html.indexOf('>', idx) + 1;
    const end      = html.indexOf('</script>', start);
    const nextData = JSON.parse(html.slice(start, end));
    const algolia  = nextData?.props?.initialProps?.globalData?.public_config?.algolia;
    if (algolia?.appId && (algolia.publicSearchKey || algolia.apiKey)) {
      GRAILED_ALGOLIA.appId       = algolia.appId;
      GRAILED_ALGOLIA.searchKey   = algolia.publicSearchKey || algolia.apiKey;
      GRAILED_ALGOLIA.refreshedAt = Date.now();
      console.log(`[Resale] Grailed credentials refreshed (appId: ${GRAILED_ALGOLIA.appId})`);
    }
  } catch (err) {
    console.warn(`[Resale] Could not refresh Grailed credentials: ${err.message}`);
  }
}

async function grailedQuery(index, query) {
  const { appId, searchKey } = GRAILED_ALGOLIA;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  const res   = await fetch(
    `https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/${index}/query`,
    {
      method: 'POST',
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
    count:  prices.length,
  };
}

async function fetchResaleData(title, colorway) {
  const key    = `${title}::${colorway || ''}`;
  const cached = resaleCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) return cached;

  const goatQuery = encodeURIComponent(`palace ${title}${colorway ? ' ' + colorway : ''}`);
  const goatUrl   = `https://www.goat.com/search?query=${goatQuery}`;

  let overallResale = null;
  let resaleSource  = 'Grailed (sold)';

  await refreshGrailedCredentials();

  const words      = title.split(/\s+/);
  const shortTitle = words.slice(0, Math.max(3, Math.ceil(words.length / 2))).join(' ');
  const queries = [
    `Palace ${title}${colorway ? ' ' + colorway : ''}`,
    `Palace ${title}`,
    `Palace ${shortTitle}`,
  ].filter((q, i, arr) => arr.indexOf(q) === i);

  console.log(`[Resale] Grailed sold: "${queries[0]}"`);

  try {
    for (const q of queries) {
      const hits   = await grailedQuery(GRAILED_ALGOLIA.soldIndex, q);
      const result = medianPrice(hits);
      if (result) {
        overallResale = result.median;
        resaleSource  = 'Grailed (sold)';
        console.log(`[Resale] ✓ "${title}" — median sold: $${overallResale} (${result.count} hits)`);
        break;
      }
    }

    if (overallResale === null) {
      console.log(`[Resale] No sold data — trying active listings...`);
      for (const q of queries) {
        const hits   = await grailedQuery('Listing_by_heat_production', q);
        const result = medianPrice(hits);
        if (result) {
          overallResale = result.median;
          resaleSource  = 'Grailed (ask)';
          console.log(`[Resale] ✓ "${title}" — median ask: $${overallResale} (${result.count} hits)`);
          break;
        }
      }
    }
  } catch (err) {
    console.warn(`[Resale] Grailed fetch failed: ${err.message}`);
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
    retailPrice:  null,
    overallResale,
    sizeResale:   {},
    trend,
    stockxUrl:    goatUrl,
    source:       resaleSource,
    fetchedAt:    Date.now(),
  };
  resaleCache.set(key, result);
  return result;
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
      console.log(`[${ts()}] Skipping duplicate (cooldown): ${cooldownKey}`);
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
        console.error(`[Discord] ${res.status} — ${await res.text()}`);
      }
    } catch (err) {
      console.error(`[Discord] Send failed: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 600));
  }
  queueRunning = false;
}

// ─── DISCORD RESTOCK ALERT ────────────────────────────────────────────────────

const fmt = n => n != null ? `$${Number(n).toFixed(0)}` : null;

async function postRestockAlert({ region, productTitle, colorway, category, productUrl, imageUrl, restocked, allInStock, isNewItem, resaleData }) {
  const { retailPrice, overallResale, sizeResale, trend, stockxUrl, source } = resaleData;
  const resaleLabel = source === 'Grailed (ask)' ? '💰 Avg Ask (Grailed)' : '💰 Avg Resale';
  const hasData     = overallResale != null || Object.keys(sizeResale).length > 0;

  const buildLine = (v, isNew = false) => {
    const mapped    = SIZE_MAP[v.sizeName] || v.sizeName;
    const sp        = sizeResale[mapped] || overallResale || null;
    const profit    = sp && retailPrice ? sp - retailPrice : null;
    const indicator = !hasData ? '🆕' : sp == null ? '❓' : profit != null && profit > 0 ? '🟢' : '🔴';
    const priceStr  = sp ? ` · ${fmt(sp)}${profit != null ? (profit > 0 ? ` (+${fmt(profit)})` : ` (-${fmt(Math.abs(profit))})`) : ''}` : '';
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
        { name: '🏷️ Retail',  value: fmt(retailPrice)   || 'N/A', inline: true },
        { name: resaleLabel,   value: fmt(overallResale) || 'N/A', inline: true },
        { name: '📈 Trend',    value: trend || '—',               inline: true },
      ]
    : [
        { name: '🏷️ Retail',  value: fmt(retailPrice) || 'N/A', inline: true },
        { name: '💰 Resale',   value: '🆕 No data yet',          inline: true },
        { name: '📈 Trend',    value: '— New item',              inline: true },
      ];

  fields.push(
    { name: '🗂️ Category',           value: category || '—',  inline: true },
    { name: `${region.flag} Region`, value: region.label,     inline: true },
    { name: '🔗 GOAT',               value: stockxUrl ? `[Search GOAT](${stockxUrl})` : 'N/A', inline: true },
    { name: `🔔 Just Restocked (${restocked.length})`, value: restockedLines || '—', inline: false },
    {
      name: hasData
        ? `📦 All In Stock (${(allInStock || restocked).length}) — 🟢 profit  🔴 at/below retail  ❓ no size data  🔔 just restocked`
        : `📦 All In Stock (${(allInStock || restocked).length}) — 🆕 New item  🔔 just restocked`,
      value:  allLines || '—',
      inline: false,
    },
  );

  const webhookUrl = WEBHOOKS[region.webhookKey];
  if (!webhookUrl || webhookUrl.startsWith('PASTE')) return;

  await queueAlert({
    webhookUrl,
    body: {
      embeds: [{
        title:     `${badge}: ${productTitle}${colorway ? ` — ${colorway}` : ''}`,
        url:       productUrl,
        color,
        thumbnail: imageUrl ? { url: imageUrl } : undefined,
        fields,
        footer:    { text: `Palace Monitor | ${region.label}` },
        timestamp: new Date().toISOString(),
      }],
    },
  }, `${productTitle}:${colorway || ''}`);
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
    for (const [k, v] of Object.entries(obj)) previousStock.set(k, v);
    for (const regionKey of Object.keys(REGIONS)) {
      if ([...previousStock.keys()].some(k => k.startsWith(regionKey + ':')))
        firstRunDone[regionKey] = true;
    }
    const doneRegions = Object.keys(firstRunDone).join(', ');
    if (doneRegions) console.log(`[Snapshot] Loaded — ${previousStock.size} variants (${doneRegions} ready)`);
    if (Object.keys(firstRunDone).length > 0) isFirstRun = false;
  } catch {
    // No snapshot yet — normal on first run
  }
}

// ─── STOCK CHECK ──────────────────────────────────────────────────────────────

async function checkStock(region) {
  await jitter();

  // Password page check (runs every cycle — alerts only on state change)
  const isPasswordUp = await checkPasswordPage(region);
  await handlePasswordState(region, isPasswordUp);

  // If password page is up, products aren't accessible anyway
  if (passwordState[region.webhookKey] === true) {
    console.log(`[${ts()}][${region.webhookKey}] Password page up — skipping stock check`);
    return;
  }

  const { products, complete, passwordProtected } = await fetchAllProducts(region);

  if (passwordProtected) {
    // Products endpoint also confirmed password — update state if needed
    await handlePasswordState(region, true);
    return;
  }

  if (products.length < 5) {
    console.warn(`[${ts()}][${region.webhookKey}] Too few products (${products.length}) — skipping cycle`);
    return;
  }

  if (!complete) {
    console.warn(`[${ts()}][${region.webhookKey}] Incomplete fetch — alerting on partial data`);
  }

  const pendingStock = new Map(previousStock);
  for (const [key] of previousStock) {
    if (key.startsWith(region.webhookKey + ':')) pendingStock.delete(key);
  }

  let restocksThisCycle = 0;

  for (const product of products) {
    const productTitle = product.title;
    const colorway     = null;  // Palace doesn't separate colorway in title
    const productUrl   = product.handle ? `${region.baseUrl}/products/${product.handle}` : region.baseUrl;
    const imageUrl     = product.imageUrl || null;
    const category     = '—';
    const variants     = product.variants || [];

    const restocked  = [];
    const allInStock = [];

    for (const variant of variants) {
      const key      = `${region.webhookKey}:${variant.id}`;
      const sizeName = variant.title;
      const atcUrl   = variant.id ? `${region.baseUrl}/cart/${variant.id}:1` : region.baseUrl;
      const price    = variant.price || null;
      const avail    = variant.available;

      if (!isFirstRun && firstRunDone[region.webhookKey] && avail) {
        const prev = previousStock.get(key);
        if (prev === false)     restocked.push({ sizeName, atcUrl, price, isNew: false });
        else if (prev === undefined) restocked.push({ sizeName, atcUrl, price, isNew: true });
      }

      if (avail) {
        allInStock.push({ sizeName, atcUrl, price });
        pendingStock.set(key, true);
      } else {
        pendingStock.set(key, false);
      }
    }

    if (!restocked.length) continue;

    restocksThisCycle++;
    onRestockDetected();

    console.log(`[${ts()}][${region.webhookKey}] 👀 ${productTitle} — looking up resale...`);
    const resaleData = await fetchResaleData(productTitle, colorway);
    const isNewItem  = restocked.some(r => r.isNew);

    await postRestockAlert({
      region, productTitle, colorway, category,
      productUrl, imageUrl,
      restocked, allInStock,
      isNewItem,
      resaleData: resaleData || {
        retailPrice: null, overallResale: null, sizeResale: {}, trend: null, stockxUrl: null, source: null,
      },
    });
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
    }).length) isFirstRun = false;

    saveSnapshot();
  }

  if (restocksThisCycle > 0) {
    console.log(`[${ts()}] ${restocksThisCycle} restock(s) this cycle`);
  }

  checkWaveStatus();
}

// ─── POLL CYCLE ───────────────────────────────────────────────────────────────

async function pollCycle() {
  const mode = inWave ? `wave (${FAST_POLL_MS / 1000}s)` : `quiet (${SLOW_POLL_MS / 60000}m)`;
  console.log(`[${ts()}] Polling... [${mode}]`);

  const activeRegions = Object.values(REGIONS).filter(r => {
    const w = WEBHOOKS[r.webhookKey];
    return w && !w.startsWith('PASTE');
  });

  await Promise.allSettled(activeRegions.map(r => checkStock(r)));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('👑 Palace Monitor starting...');

  const activeWebhooks = Object.entries(WEBHOOKS).filter(([, v]) => !v.startsWith('PASTE'));
  if (!activeWebhooks.length) {
    console.error('No webhooks configured!');
    process.exit(1);
  }
  console.log(`✅ Webhooks active: ${activeWebhooks.map(([k]) => k).join(', ')}`);

  loadSnapshot();
  checkWaveStatus();

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

main();
