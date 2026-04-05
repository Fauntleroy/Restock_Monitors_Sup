/**
 * Supreme Restock Monitor — LOCAL TEST VERSION
 * ─────────────────────────────────────────────────────────────────
 * - Wave detector: fast polling during restock windows, slow otherwise
 * - Alerts on EVERY restock — resellers and regular cops both covered
 * - Restocked size called out, all in-stock sizes shown below
 * - Per-size resale prices + profit indicators from StockX
 * - New items marked 🆕 when no StockX data exists yet
 *
 * HOW TO RUN:
 *   1. Paste your Discord webhook URL below
 *   2. node test.js
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ─── YOUR WEBHOOKS ────────────────────────────────────────────────────────────

const WEBHOOKS = {
  US: 'https://discord.com/api/webhooks/1478830089536929883/g-O9Sy5A_29pYBxptaW5vFZTVL91HiF8LjEsOpat4Jatx9SMd7Pqhaxn1zSApsMYFF3J',
  // EU: 'YOUR_EU_WEBHOOK',
  // UK: 'YOUR_UK_WEBHOOK',
  // JP: 'YOUR_JP_WEBHOOK',
};

// ─── POLLING CONFIG ───────────────────────────────────────────────────────────

const SLOW_POLL_MS         = 5 * 60 * 1000;  // 5 min — quiet periods, barely uses proxies
const FAST_POLL_MS         = 3_000;           // 3 sec — during a restock wave
const WAVE_COOLDOWN_MS     = 30 * 60 * 1000; // stay fast for 30 min after last restock
const SUPREME_STOCK_URL    = 'https://www.supremenewyork.com/mobile_stock.json';
const SUPREME_BASE_URL     = 'https://www.supremenewyork.com';
const STOCKX_BASE_URL      = 'https://stockx.com';

// ─── WAVE STATE ───────────────────────────────────────────────────────────────

let lastRestockAt   = null;   // timestamp of most recent restock detected
let currentInterval = null;   // reference to the active setInterval
let inWave          = false;  // are we currently in fast-poll mode?

function isInWave() {
  if (!lastRestockAt) return false;
  return Date.now() - lastRestockAt < WAVE_COOLDOWN_MS;
}

/**
 * Called every time a restock is detected.
 * Resets the wave timer and kicks into fast mode if not already there.
 */
function onRestockDetected() {
  lastRestockAt = Date.now();

  if (!inWave) {
    inWave = true;
    console.log(`[${ts()}] 🌊 WAVE STARTED — switching to fast poll (${FAST_POLL_MS / 1000}s)`);
    reschedule(FAST_POLL_MS);
  }
}

/**
 * Called after each poll cycle to check if the wave has ended.
 * If it's been 30+ min since the last restock, drop back to slow polling.
 */
function checkWaveStatus() {
  if (inWave && !isInWave()) {
    inWave = false;
    const idleFor = Math.round((Date.now() - lastRestockAt) / 60000);
    console.log(`[${ts()}] 💤 Wave ended (no restocks for ${idleFor} min) — switching to slow poll (${SLOW_POLL_MS / 60000} min)`);
    reschedule(SLOW_POLL_MS);
  }
}

/** Cancel existing interval and set a new one at the given speed */
function reschedule(intervalMs) {
  if (currentInterval) clearInterval(currentInterval);
  currentInterval = setInterval(pollCycle, intervalMs);
}

// ─── STOCK STATE ──────────────────────────────────────────────────────────────

const previousStock = new Map();
const resaleCache   = new Map();
const priceHistory  = new Map();
let   isFirstRun    = true;

// ─── STOCKX — SIZE-SPECIFIC PRICING ──────────────────────────────────────────

const STOCKX_SIZE_MAP = {
  'XSmall': 'XS', 'X-Small': 'XS',
  'Small':  'S',
  'Medium': 'M',
  'Large':  'L',
  'XLarge': 'XL',  'X-Large': 'XL',
  'XXLarge':'XXL', 'XX-Large':'XXL',
};

async function fetchStockXResale(productName, colorway) {
  const cacheKey = `${productName}::${colorway || ''}`;
  const cached   = resaleCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) return cached;

  const searchName = colorway
    ? `Supreme ${productName} ${colorway}`
    : `Supreme ${productName}`;

  try {
    const q   = encodeURIComponent(searchName);
    const res = await fetch(`${STOCKX_BASE_URL}/api/browse?_search=${q}&dataType=product`, {
      headers: {
        'User-Agent':       'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept':           'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'Accept-Language':  'en-US,en;q=0.9',
      },
    });

    if (!res.ok) return null;
    const data     = await res.json();
    const products = data?.Products || data?.products || [];
    if (!products.length) return null;

    const top           = products[0];
    const market        = top.market || top.Market || {};
    const retailPrice   = top.retailPrice || top.RetailPrice || null;
    const urlKey        = top.urlKey || top.UrlKey || '';
    const stockxUrl     = urlKey ? `${STOCKX_BASE_URL}/${urlKey}` : null;
    const overallResale = market.lastSale || market.lowestAsk || market.averageDeadstockPrice || null;

    const sizeResale = {};
    const children   = top.children || top.variants || [];
    for (const child of children) {
      const sizeName  = child.shoeSize || child.size || child.traits?.size || '';
      const sizePrice = child.market?.lastSale || child.market?.lowestAsk || null;
      const mapped    = STOCKX_SIZE_MAP[sizeName] || sizeName;
      if (mapped && sizePrice) sizeResale[mapped] = sizePrice;
    }

    if (overallResale) {
      const hist = priceHistory.get(cacheKey) || [];
      hist.push(overallResale);
      if (hist.length > 10) hist.shift();
      priceHistory.set(cacheKey, hist);
    }

    let trend = '→ Stable';
    const hist = priceHistory.get(cacheKey) || [];
    if (hist.length >= 2) {
      const pct = ((hist[hist.length - 1] - hist[hist.length - 2]) / hist[hist.length - 2]) * 100;
      if (pct > 3)       trend = '📈 Rising';
      else if (pct < -3) trend = '📉 Falling';
    }

    const result = { retailPrice, overallResale, sizeResale, trend, stockxUrl, fetchedAt: Date.now() };
    resaleCache.set(cacheKey, result);
    return result;

  } catch (err) {
    console.warn(`[StockX] Failed for "${searchName}": ${err.message}`);
    return null;
  }
}

// ─── DISCORD ──────────────────────────────────────────────────────────────────

async function postToDiscord(regionKey, payload) {
  const url = WEBHOOKS[regionKey];
  if (!url) return;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) console.error(`[Discord] ${res.status} — ${await res.text()}`);
}

async function sendTestPing() {
  console.log('\n📡 Sending test ping to Discord...');
  await postToDiscord('US', {
    username: 'Supreme Monitor 🧪',
    embeds: [{
      title:       '✅ Monitor Online — Test Ping',
      description: [
        'Supreme Restock Monitor is connected with **wave detection** enabled.',
        '',
        '💤 **Quiet mode:** polls every 5 min (saves proxies)',
        '🌊 **Wave mode:** polls every 3 sec when restocks are happening',
        '⏱️ Stays in wave mode for 30 min after the last restock',
        '',
        '🟢 = profitable  🔴 = at/below retail  🆕 = new item  🔔 = just restocked',
      ].join('\n'),
      color:     0x00C853,
      footer:    { text: 'If you see this, the webhook is working!' },
      timestamp: new Date().toISOString(),
    }],
  });
  console.log('✅ Test ping sent!\n');
}

function fmt(n) { return n != null ? `$${Number(n).toFixed(0)}` : null; }

async function postRestockAlert({
  name, colorway, category, productUrl, imageUrl,
  restockedSizes, allInStockSizes, resaleData,
}) {
  const { retailPrice, overallResale, sizeResale, trend, stockxUrl } = resaleData;
  const hasResaleData = overallResale != null || Object.keys(sizeResale).length > 0;

  // Build a single size line
  const buildSizeLine = (s, isRestocked = false) => {
    const mapped    = STOCKX_SIZE_MAP[s.sizeName] || s.sizeName;
    const sizePrice = sizeResale[mapped] || overallResale || null;
    const profit    = sizePrice && retailPrice ? sizePrice - retailPrice : null;

    let indicator;
    if (!hasResaleData)         indicator = '🆕';
    else if (sizePrice == null) indicator = '❓';
    else if (profit > 0)        indicator = '🟢';
    else                        indicator = '🔴';

    const priceStr = sizePrice
      ? ` · ${fmt(sizePrice)}${profit != null
          ? (profit > 0 ? ` (+${fmt(profit)})` : ` (-${fmt(Math.abs(profit))})`)
          : ''}`
      : '';

    return `${indicator} **[${s.sizeName}](${s.atcUrl})**${priceStr}${isRestocked ? '  🔔' : ''}`;
  };

  const restockedNames = new Set(restockedSizes.map(s => s.sizeName));
  const restockedLines = restockedSizes.map(s => buildSizeLine(s, true)).join('\n');
  const allSizeLines   = (allInStockSizes || restockedSizes)
    .map(s => buildSizeLine(s, restockedNames.has(s.sizeName)))
    .join('\n');

  // Embed color
  let color;
  if (!hasResaleData) {
    color = 0x3498DB; // blue — new item
  } else {
    const ratio     = overallResale && retailPrice ? overallResale / retailPrice : 1;
    const anyProfit = restockedSizes.some(s => {
      const mapped    = STOCKX_SIZE_MAP[s.sizeName] || s.sizeName;
      const sizePrice = sizeResale[mapped] || overallResale || null;
      return sizePrice && retailPrice && sizePrice > retailPrice;
    });
    color = !anyProfit   ? 0xE74C3C
      : ratio >= 2.0     ? 0x00C853
      : ratio >= 1.5     ? 0x2ECC71
      :                    0xF1C40F;
  }

  // Title badge
  const anyProfitable = hasResaleData && restockedSizes.some(s => {
    const mapped    = STOCKX_SIZE_MAP[s.sizeName] || s.sizeName;
    const sizePrice = sizeResale[mapped] || overallResale || null;
    return sizePrice && retailPrice && sizePrice > retailPrice;
  });
  const titleBadge = !hasResaleData ? '🆕' : anyProfitable ? '🟢 RESTOCK —' : '🔴 RESTOCK —';

  // Fields
  const fields = [];
  if (hasResaleData) {
    fields.push(
      { name: '🏷️ Retail',    value: fmt(retailPrice)   || 'N/A', inline: true },
      { name: '💰 Avg Resale', value: fmt(overallResale) || 'N/A', inline: true },
      { name: '📈 Trend',      value: trend,                        inline: true },
    );
  } else {
    fields.push(
      { name: '🏷️ Retail',  value: fmt(retailPrice) || 'N/A', inline: true },
      { name: '💰 Resale',   value: '🆕 No data yet',          inline: true },
      { name: '📈 Trend',    value: '— New item',               inline: true },
    );
  }

  fields.push(
    { name: '🗂️ Category', value: category || '—', inline: true },
    { name: '🔗 StockX',   value: stockxUrl ? `[View Listing](${stockxUrl})` : 'Not listed yet', inline: true },
    { name: '\u200b',      value: '\u200b', inline: true },
    {
      name:   `🔔 Just Restocked (${restockedSizes.length})`,
      value:  restockedLines || '—',
      inline: false,
    },
    {
      name: hasResaleData
        ? `📦 All In Stock (${(allInStockSizes || restockedSizes).length}) — 🟢 profit  🔴 at/below retail  ❓ no size data  🔔 just restocked`
        : `📦 All In Stock (${(allInStockSizes || restockedSizes).length}) — 🆕 New item, resale data appears after first sales  🔔 just restocked`,
      value:  allSizeLines || '—',
      inline: false,
    },
  );

  await postToDiscord('US', {
    username:   'Supreme Monitor 🇺🇸',
    avatar_url: 'https://www.supremenewyork.com/favicon.ico',
    embeds: [{
      title:     `${titleBadge} ${name}${colorway ? ` (${colorway})` : ''}`,
      url:        productUrl,
      color,
      thumbnail:  imageUrl ? { url: imageUrl } : undefined,
      fields,
      footer:    { text: `Supreme Monitor • ${new Date().toLocaleTimeString()} • ${inWave ? '🌊 wave mode' : '💤 quiet mode'}` },
      timestamp: new Date().toISOString(),
    }],
  });
}

// ─── FAKE RESTOCK PREVIEWS ────────────────────────────────────────────────────

async function sendFakeRestocks() {
  console.log(`[${ts()}] 🧪 Sending fake restock #1 — known item, Medium just restocked...`);
  await postRestockAlert({
    name: 'Box Logo Hooded Sweatshirt', colorway: 'Red', category: 'Sweatshirts',
    productUrl: 'https://www.supremenewyork.com/shop/1/', imageUrl: null,
    restockedSizes: [
      { sizeName: 'Medium', atcUrl: 'https://www.supremenewyork.com/shop/1/add?style=1&size=2' },
    ],
    allInStockSizes: [
      { sizeName: 'Small',   atcUrl: 'https://www.supremenewyork.com/shop/1/add?style=1&size=1' },
      { sizeName: 'Medium',  atcUrl: 'https://www.supremenewyork.com/shop/1/add?style=1&size=2' },
      { sizeName: 'Large',   atcUrl: 'https://www.supremenewyork.com/shop/1/add?style=1&size=3' },
      { sizeName: 'XLarge',  atcUrl: 'https://www.supremenewyork.com/shop/1/add?style=1&size=4' },
      { sizeName: 'XXLarge', atcUrl: 'https://www.supremenewyork.com/shop/1/add?style=1&size=5' },
    ],
    resaleData: {
      retailPrice: 168, overallResale: 485, trend: '📈 Rising',
      stockxUrl: 'https://stockx.com/supreme-box-logo-hooded-sweatshirt-red',
      sizeResale: { S: 520, M: 498, L: 312, XL: 175, XXL: 140 },
    },
  });

  await new Promise(r => setTimeout(r, 1500));

  console.log(`[${ts()}] 🧪 Sending fake restock #2 — new item, no StockX data yet...`);
  await postRestockAlert({
    name: 'Washed Chino Pant', colorway: 'Olive', category: 'Pants',
    productUrl: 'https://www.supremenewyork.com/shop/2/', imageUrl: null,
    restockedSizes: [
      { sizeName: 'Small', atcUrl: 'https://www.supremenewyork.com/shop/2/add?style=1&size=1' },
    ],
    allInStockSizes: [
      { sizeName: 'Small',  atcUrl: 'https://www.supremenewyork.com/shop/2/add?style=1&size=1' },
      { sizeName: 'Medium', atcUrl: 'https://www.supremenewyork.com/shop/2/add?style=1&size=2' },
      { sizeName: 'Large',  atcUrl: 'https://www.supremenewyork.com/shop/2/add?style=1&size=3' },
    ],
    resaleData: { retailPrice: 148, overallResale: null, trend: null, stockxUrl: null, sizeResale: {} },
  });

  console.log(`[${ts()}] ✅ Both previews sent — check Discord!\n`);
}

// ─── SUPREME STOCK CHECK ──────────────────────────────────────────────────────

async function checkStock() {
  let data;
  try {
    const res = await fetch(SUPREME_STOCK_URL, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept':          'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer':         'https://www.supremenewyork.com/shop/all',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error(`[${ts()}] Supreme fetch failed: ${err.message}`);
    return;
  }

  let restocksThisCycle = 0;

  for (const [category, products] of Object.entries(data.products_and_categories || {})) {
    for (const product of products) {
      const { id: productId, name: productName } = product;

      let details;
      try {
        const res = await fetch(`${SUPREME_BASE_URL}/shop/${productId}.json`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' },
        });
        if (!res.ok) continue;
        details = await res.json();
      } catch { continue; }

      for (const style of (details?.styles || [])) {
        const styleId  = style.id;
        const colorway = style.name || null;
        const imageUrl = style.image_url_hi
          ? `https:${style.image_url_hi}`
          : style.image_url ? `https:${style.image_url}` : null;

        const restockedSizes  = [];
        const allInStockSizes = [];

        for (const size of (style.sizes || [])) {
          const key     = `${productId}:${styleId}:${size.id}`;
          const inStock = size.stock_level > 0;

          if (!isFirstRun && inStock && !previousStock.has(key)) {
            restockedSizes.push({
              sizeName: size.name,
              sizeId:   size.id,
              atcUrl:   `${SUPREME_BASE_URL}/shop/${productId}/add?style=${styleId}&size=${size.id}`,
            });
          }

          if (inStock) {
            allInStockSizes.push({
              sizeName: size.name,
              sizeId:   size.id,
              atcUrl:   `${SUPREME_BASE_URL}/shop/${productId}/add?style=${styleId}&size=${size.id}`,
            });
            previousStock.set(key, true);
          } else {
            previousStock.delete(key);
          }
        }

        if (!restockedSizes.length) continue;

        restocksThisCycle++;
        onRestockDetected(); // 🌊 kick wave detector

        console.log(`[${ts()}] 👀 Restock: ${productName} (${colorway}) — checking StockX...`);
        const resaleData = await fetchStockXResale(productName, colorway);

        await postRestockAlert({
          name: productName, colorway, category,
          productUrl:  `${SUPREME_BASE_URL}/shop/${productId}/`,
          imageUrl, restockedSizes, allInStockSizes,
          resaleData: resaleData || {
            retailPrice: null, overallResale: null,
            sizeResale: {}, trend: null, stockxUrl: null,
          },
        });
      }
    }
  }

  if (isFirstRun) {
    console.log(`[${ts()}] ✅ Snapshot done — tracking ${previousStock.size} in-stock sizes`);
    console.log(`[${ts()}] 💤 Quiet mode active — polling every ${SLOW_POLL_MS / 60000} min\n`);
    isFirstRun = false;
  }

  if (restocksThisCycle > 0) {
    console.log(`[${ts()}] 🌊 ${restocksThisCycle} restock(s) this cycle — wave timer reset`);
  }

  // Check if wave has cooled down after each poll
  checkWaveStatus();
}

// ─── POLL CYCLE ───────────────────────────────────────────────────────────────

async function pollCycle() {
  const mode = inWave ? `🌊 wave (${FAST_POLL_MS / 1000}s)` : `💤 quiet (${SLOW_POLL_MS / 60000}m)`;
  console.log(`[${ts()}] Checking Supreme stock... [${mode}]`);
  await checkStock();
}

function ts() { return new Date().toLocaleTimeString(); }

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Supreme Monitor — LOCAL TEST MODE');
  console.log(`  Quiet poll  : every ${SLOW_POLL_MS / 60000} min (no restock activity)`);
  console.log(`  Wave poll   : every ${FAST_POLL_MS / 1000}s (during restock window)`);
  console.log(`  Wave window : ${WAVE_COOLDOWN_MS / 60000} min after last restock`);
  console.log('  Filter      : NONE — all restocks alerted');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (WEBHOOKS.US === 'PASTE_YOUR_NEW_WEBHOOK_URL_HERE') {
    console.error('❌  Paste your Discord webhook URL at the top of test.js first!');
    process.exit(1);
  }

  await sendTestPing();
  await sendFakeRestocks();

  // Start in quiet mode — will automatically switch to wave mode when restocks hit
  console.log(`[${ts()}] Starting in quiet mode (needs proxies for Supreme access)...`);
  await checkStock();
  reschedule(SLOW_POLL_MS); // start the polling loop
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
