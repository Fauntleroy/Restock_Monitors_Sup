// One Piece TCG Restock Monitor — multi-shop Shopify watcher
// Cloned from ftp-monitor.js; polls each shop's One Piece collection via
// public /collections/<handle>/products.json (no auth, no GraphQL needed).
//
// Env:
//   TCG_WEBHOOK       Discord webhook (optional — hub feed still works without)
//   TCG_SHOPS         override shop list: "domain/collection-handle,..." pairs
//   TCG_KEYWORDS      comma list; product title must contain one (sealed-product default)
//   CALENDAR_API_URL / CALENDAR_API_KEY   mirror hits into the hub restocks feed
//   SLOW_POLL_MS / FAST_POLL_MS / WAVE_COOLDOWN_MS / SNAPSHOT_PATH / PROXIES

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

const WEBHOOK = process.env.TCG_WEBHOOK || '';

// Known shops: label + currency by domain. Anything unknown gets domain + USD.
const SHOP_META = {
  'collectorstore.com':   { label: 'Collector Store', short: 'CS',    currency: 'USD' },
  'facetofacegames.com':  { label: 'F2F Games',       short: 'F2F',   currency: 'CAD' },
  'totalcards.net':       { label: 'Total Cards UK',  short: 'TC UK', currency: 'GBP' },
  'fugitivetoys.com':     { label: 'Fugitive Toys',   short: 'FUGI',  currency: 'USD' },
  'store.401games.ca':    { label: '401 Games',       short: '401',   currency: 'CAD' },
};

const DEFAULT_SHOPS = [
  'collectorstore.com/one-piece-card',
  'facetofacegames.com/one-piece-sealed',
  'totalcards.net/all-one-piece',
  'fugitivetoys.com/one-piece',
];

const SHOPS = (process.env.TCG_SHOPS
  ? process.env.TCG_SHOPS.split(',').map(s => s.trim()).filter(Boolean)
  : DEFAULT_SHOPS
).map(entry => {
  const slash = entry.indexOf('/');
  const domain = slash === -1 ? entry : entry.slice(0, slash);
  const handle = slash === -1 ? 'all' : entry.slice(slash + 1);
  const meta = SHOP_META[domain] || { label: domain.replace(/^(store|www)\./, ''), currency: 'USD' };
  return { key: domain, domain, handle, baseUrl: `https://${domain}`, ...meta };
});

// Sealed product only by default — card singles restock constantly and would
// flood the channel. Title must contain at least one keyword (case-insens).
const KEYWORDS = (process.env.TCG_KEYWORDS ||
  'booster,box,deck,display,bundle,collection,tin,case,carton,starter,premium,treasure,pack'
).split(',').map(k => k.trim().toLowerCase()).filter(Boolean);

// Aftermarket noise filter — graded slabs etc. are resale listings, not retail.
const EXCLUDES = (process.env.TCG_EXCLUDE || 'psa,bgs,cgc,graded,slab')
  .split(',').map(k => k.trim().toLowerCase()).filter(Boolean);

// Best Buy official Products API — the true RETAIL source (MSRP + real ATC
// links). Dormant until BESTBUY_API_KEY is set (free: developer.bestbuy.com).
const BESTBUY_API_KEY = process.env.BESTBUY_API_KEY || '';
const BESTBUY_QUERY   = process.env.BESTBUY_QUERY || 'one piece card game';
const BESTBUY_SHOP    = { key: 'bestbuy', label: 'Best Buy', short: 'BEST BUY', currency: 'USD', baseUrl: 'https://www.bestbuy.com' };

const SLOW_POLL_MS     = Number(process.env.SLOW_POLL_MS ?? 60 * 1000);
const FAST_POLL_MS     = Number(process.env.FAST_POLL_MS ?? 15 * 1000);
const WAVE_COOLDOWN_MS = Number(process.env.WAVE_COOLDOWN_MS ?? 5 * 60 * 1000);
const ALERT_USERNAME   = process.env.ALERT_USERNAME   || 'Lawrence · Finest Leaks';
const ALERT_AVATAR_URL = process.env.ALERT_AVATAR_URL || 'https://fauntleroy-drop-calendar-production.up.railway.app/assets/lawrence2-avatar.png';
const REQUEST_TIMEOUT  = 15 * 1000;
const SNAPSHOT_FILE    = process.env.SNAPSHOT_PATH || 'tcg-snapshot.json';
const ALERT_COOLDOWN_MS   = 5 * 60 * 1000;
const MAX_PAGES_PER_SHOP  = 4;      // 4 × 250 = 1000 products per collection, plenty
const EMBED_COLOR_NEW     = 0xE74C3C;
const EMBED_COLOR_RESTOCK = 0x2ECC71;

const CURRENCY_SYMBOLS = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', AUD: 'A$', CAD: 'C$' };

// ─── PROXY POOL (optional — these shops are polled direct today) ─────────────

function parseProxyEntry(raw) {
  const s = String(raw || '').trim();
  if (!s || s.startsWith('#')) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const parts = s.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  if (parts.length === 2) return `http://${s}`;
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
  if (parsed.length) console.log(`[Proxy] Loaded ${parsed.length} proxy URL(s)`);
  else               console.log(`[Proxy] No proxies configured — polling direct`);
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

// ─── STATE ───────────────────────────────────────────────────────────────────

let snapshot  = {};  // { shopKey: { productId: { title, variants: { variantId: available } } } }
let cooldowns = {};  // { "shop:title": timestamp }

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

// ─── FETCH ───────────────────────────────────────────────────────────────────

async function fetchShopProducts(shop) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES_PER_SHOP; page++) {
    const url = `${shop.baseUrl}/collections/${shop.handle}/products.json?limit=250&page=${page}`;
    const proxy = proxyPool.next();
    const agent = proxy ? new HttpsProxyAgent(proxy.url) : undefined;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      agent,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    if (res.status === 429 || res.status === 403 || res.status === 503) {
      proxyPool.ban(proxy);
      throw new Error(`Blocked: ${res.status}`);
    }
    if (!res.ok) {
      proxyPool.ban(proxy);
      throw new Error(`HTTP ${res.status}`);
    }
    proxyPool.ok(proxy);

    const json = await res.json();
    const products = json?.products;
    if (!Array.isArray(products)) throw new Error('No products array');
    all.push(...products);
    if (products.length < 250) break;
  }
  return all;
}

function matchesKeywords(title) {
  const t = (title || '').toLowerCase();
  if (EXCLUDES.some(k => t.includes(k))) return false;
  if (!KEYWORDS.length) return true;
  return KEYWORDS.some(k => t.includes(k));
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

function isCoolingDown(key) {
  return cooldowns[key] && (Date.now() - cooldowns[key]) < ALERT_COOLDOWN_MS;
}

// ─── DISCORD ─────────────────────────────────────────────────────────────────

async function sendDiscordAlert(embed) {
  if (!WEBHOOK || WEBHOOK.startsWith('PASTE')) return;

  if (embed.fields) {
    for (const f of embed.fields) {
      if (!f.value || f.value.trim() === '') f.value = '—';
    }
  }

  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ALERT_USERNAME, avatar_url: ALERT_AVATAR_URL, embeds: [embed] }),
  });

  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    const wait = ((data.retry_after || 2) + 0.5) * 1000;
    console.log(`[Discord] Rate limited — waiting ${Math.round(wait)}ms`);
    await new Promise(r => setTimeout(r, wait));
    return sendDiscordAlert(embed);
  }

  if (res.status === 400) {
    const body = await res.text().catch(() => '');
    console.error(`[Discord] 400 error: ${body}`);
    console.error(`[Discord] Embed title: ${embed.title}`);
  }
}

// Mirrors alerts into the Fauntleroy's Finest hub. No-op unless
// CALENDAR_API_URL (+ CALENDAR_API_KEY) env vars are set on the service.
const CALENDAR_API_URL = (process.env.CALENDAR_API_URL || '').replace(/\/$/, '');
const CALENDAR_API_KEY = process.env.CALENDAR_API_KEY || '';

async function postToCalendar(entry) {
  if (!CALENDAR_API_URL) return;
  try {
    const res = await fetch(`${CALENDAR_API_URL}/api/restocks`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CALENDAR_API_KEY },
      body:    JSON.stringify(entry),
    });
    if (!res.ok) console.error(`[Calendar] ${res.status} posting restock`);
  } catch (err) {
    console.error(`[Calendar] Post failed: ${err.message}`);
  }
}

async function sendAlert(shop, product, isNew) {
  const cooldownKey = `${shop.key}:${product.title}`;
  if (isCoolingDown(cooldownKey)) return;
  cooldowns[cooldownKey] = Date.now();
  onRestockDetected();

  const symbol = CURRENCY_SYMBOLS[shop.currency] || '$';
  const availableVariants = product.variants.filter(v => v.available);
  const minPrice = availableVariants.length
    ? Math.min(...availableVariants.map(v => Number(v.price)).filter(n => !Number.isNaN(n)))
    : Number(product.variants[0]?.price);
  const priceDisplay = Number.isFinite(minPrice) ? `${symbol}${minPrice.toFixed(2)}` : 'N/A';

  const productUrl = product.urlOverride || `${shop.baseUrl}/products/${product.handle}`;
  const imageUrl = product.images?.[0]?.src || null;

  // ATC lines: single-variant products get quantity permalinks (1x/2x/3x/5x),
  // multi-variant products get one 1x link per variant. Non-Shopify sources
  // (Best Buy) supply a ready-made ATC url instead.
  const atc = (id, qty) => `${shop.baseUrl}/cart/${id}:${qty}`;
  let atcLines;
  if (product.atcOverride) {
    atcLines = `🟢 **[Add to Cart](${product.atcOverride})**`;
  } else if (availableVariants.length === 1) {
    const id = availableVariants[0].id;
    atcLines = `🟢 [1x](${atc(id, 1)}) · [2x](${atc(id, 2)}) · [3x](${atc(id, 3)}) · [5x](${atc(id, 5)})`;
  } else {
    atcLines = availableVariants.slice(0, 12).map(v =>
      `🟢 **[${v.title}](${atc(v.id, 1)})**`
    ).join('\n');
  }

  const q = encodeURIComponent(product.title.slice(0, 80));
  const marketLinks = `[TCGplayer](https://www.tcgplayer.com/search/one-piece-card-game/product?q=${q}) · [StockX](https://stockx.com/search?s=${q}) · [eBay](https://www.ebay.com/sch/i.html?_nkw=${q})`;

  const tag = isNew ? '🆕 NEW' : '🔄 RESTOCK';
  const color = isNew ? EMBED_COLOR_NEW : EMBED_COLOR_RESTOCK;

  const fields = [
    { name: '🏷️ Price', value: priceDisplay, inline: true },
    { name: '🏪 Shop', value: shop.label, inline: true },
    { name: '📦 In Stock', value: String(availableVariants.length || '—'), inline: true },
    { name: '🛒 ATC', value: (atcLines || '—').slice(0, 1024), inline: false },
    { name: '💹 Market', value: marketLinks, inline: false },
  ];

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
    footer: { text: `TCG Radar | ${shop.label} | ${timeStr}` },
    timestamp: new Date().toISOString(),
  };

  postToCalendar({
    brand:  'One Piece',
    region: shop.short || shop.label,
    name:   product.title,
    price:  priceDisplay !== 'N/A' ? priceDisplay : null,
    url:    productUrl,
    img:    imageUrl,
    sizes:  product.atcOverride
      ? [{ size: 'ATC', atc: product.atcOverride }]
      : availableVariants.length === 1
        ? [1, 2, 3].map(n => ({ size: `${n}x`, atc: atc(availableVariants[0].id, n) }))
        : availableVariants.slice(0, 12).map(v => ({ size: v.title, atc: atc(v.id, 1) })),
    kind:   isNew ? 'new' : 'restock',
  }); // fire-and-forget

  await sendDiscordAlert(embed);
  console.log(`[${ts()}][${shop.key}] 📣 ${tag}: ${product.title}`);
}

// ─── MONITOR LOGIC ───────────────────────────────────────────────────────────

async function checkShop(shop) {
  try {
    const all = await fetchShopProducts(shop);
    const products = all.filter(p => matchesKeywords(p.title));

    const prevShop = snapshot[shop.key] || {};
    const firstSync = Object.keys(prevShop).length === 0;
    const newShop = {};

    for (const product of products) {
      const pid = String(product.id);
      const prevProduct = prevShop[pid];

      const variantMap = {};
      for (const v of product.variants) variantMap[String(v.id)] = !!v.available;
      newShop[pid] = { title: product.title, variants: variantMap };

      const anyAvailable = product.variants.some(v => v.available);

      if (!prevProduct) {
        if (anyAvailable && !firstSync) {
          await sendAlert(shop, product, true);
        }
        continue;
      }

      const restocked = product.variants.some(v =>
        v.available && prevProduct.variants?.[String(v.id)] === false
      );
      if (restocked) {
        await sendAlert(shop, product, false);
      }
    }

    snapshot[shop.key] = newShop;
    console.log(`[${ts()}][${shop.key}] ${all.length} in collection, ${products.length} sealed${firstSync ? ' (baseline synced)' : ''}`);
  } catch (err) {
    console.error(`[${ts()}][${shop.key}] Error: ${err.message}`);
  }
}

// ─── BEST BUY (official Products API) ────────────────────────────────────────

async function checkBestBuy() {
  try {
    const url = `https://api.bestbuy.com/v1/products((search=${encodeURIComponent(BESTBUY_QUERY)}))` +
      `?apiKey=${BESTBUY_API_KEY}&format=json&pageSize=100` +
      `&show=sku,name,salePrice,onlineAvailability,url,image,addToCartUrl`;
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const items = (json.products || []).filter(p =>
      /one\s?piece/i.test(p.name || '') && matchesKeywords(p.name)
    );

    const prevShop = snapshot[BESTBUY_SHOP.key] || {};
    const firstSync = Object.keys(prevShop).length === 0;
    const newShop = {};

    for (const item of items) {
      const pid = String(item.sku);
      const available = !!item.onlineAvailability;
      const prevProduct = prevShop[pid];
      newShop[pid] = { title: item.name, variants: { [pid]: available } };

      const wasAvailable = prevProduct?.variants?.[pid];
      const isNew = !prevProduct;
      if ((isNew && available && !firstSync) || (available && wasAvailable === false)) {
        // Synthesize a Shopify-shaped product so sendAlert just works
        await sendAlert(BESTBUY_SHOP, {
          id: pid,
          title: item.name,
          handle: null,
          urlOverride: item.url,
          atcOverride: item.addToCartUrl || item.url,
          variants: [{ id: pid, title: 'Default', available, price: item.salePrice }],
          images: item.image ? [{ src: item.image }] : [],
        }, isNew);
      }
    }

    snapshot[BESTBUY_SHOP.key] = newShop;
    console.log(`[${ts()}][bestbuy] ${items.length} retail listings${firstSync ? ' (baseline synced)' : ''}`);
  } catch (err) {
    console.error(`[${ts()}][bestbuy] Error: ${err.message}`);
  }
}

// ─── MAIN LOOP ───────────────────────────────────────────────────────────────

async function pollCycle() {
  for (const shop of SHOPS) {
    await checkShop(shop);
  }
  if (BESTBUY_API_KEY) await checkBestBuy();
  saveSnapshot();
}

async function main() {
  console.log('🏴‍☠️ One Piece TCG Monitor starting...');
  console.log(`Shops: ${SHOPS.map(s => `${s.label} (/${s.handle})`).join(', ')}`);
  console.log(`Keywords: ${KEYWORDS.join(', ') || '(none — everything in collection)'}`);
  console.log(`Poll intervals: quiet ${SLOW_POLL_MS / 1000}s / wave ${FAST_POLL_MS / 1000}s`);
  if (!WEBHOOK) console.warn('[Discord] TCG_WEBHOOK not set — hub feed + logs only');
  if (!CALENDAR_API_URL) console.warn('[Calendar] CALENDAR_API_URL not set — Discord + logs only');
  console.log(BESTBUY_API_KEY
    ? `[BestBuy] Retail source ACTIVE (query: "${BESTBUY_QUERY}")`
    : '[BestBuy] Dormant — set BESTBUY_API_KEY (free at developer.bestbuy.com) to add true retail coverage');

  loadSnapshot();

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
