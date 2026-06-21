// ─── SELLOUT RECAP ────────────────────────────────────────────────────────────
//
// Tracks which products sell out after each Thursday drop, per region, and
// posts a recap to Discord at two times:
//   • Recap #1 — DROP + RECAP1_DELAY_MIN (default 5 min)
//   • Recap #2 — DROP + RECAP2_DELAY_MIN (default 180 min / 3 h)
//
// Accuracy choices (the differentiators vs SupremeCommunity's slow times page):
//   • The recap is anchored to the regional drop instant (Thursday 11:00 local
//     by default — env DROP_HOUR / DROP_MIN per service). Each region resolves
//     its own local time via Intl.DateTimeFormat (DST-correct).
//   • A sellout is confirmed only after SELLOUT_CONFIRM_READS consecutive
//     `available: false` reads (default 2) — kills transient API hiccups.
//   • If a variant we saw in stock during the drop disappears from Supreme's
//     product feed entirely, that's also treated as a confirmed sellout.
//   • Time-to-sellout is "how long the variant was actually available"
//     (soldOutMs − droppedMs), not "minutes since drop" — accurate for both
//     new drops and restocks that go during the drop window.
//
// Format mirrors the existing restock alerts: one embed per product, colorway
// in the title, sizes listed as lines with per-size time-to-sellout. Ranked
// fastest first.

import fs from 'fs';

// ─── CONFIG (env-tunable) ────────────────────────────────────────────────────

const DROP_HOUR             = Number(process.env.DROP_HOUR ?? 11);
const DROP_MIN              = Number(process.env.DROP_MIN ?? 0);
// Recap timing: RECAP1 = quick recap shortly after drop.
// RECAP2 = fuller picture later. Set either to 0 to disable that recap.
const RECAP1_DELAY_MIN      = Number(process.env.RECAP1_DELAY_MIN ?? 10);
const RECAP2_DELAY_MIN      = Number(process.env.RECAP2_DELAY_MIN ?? 0);
const SELLOUT_CONFIRM_READS = Math.max(1, Number(process.env.SELLOUT_CONFIRM_READS ?? 2));
const DROP_STATE_FILE       = process.env.DROP_STATE_PATH || 'drop-state.json';
const PRE_DROP_TOLERANCE_MIN = 2;          // allow observations starting 2 min before drop
const DROP_WINDOW_HOURS     = 24;          // track sellouts for 24h after drop

// ─── STATE ───────────────────────────────────────────────────────────────────

// Map<regionKey, RegionDropState>
// RegionDropState = {
//   dropDate: 'YYYY-MM-DD',           // local-to-region drop date
//   dropInstantMs: number,             // wall-clock ms of drop in region tz
//   products: {
//     [productKey]: {
//       title, colorway, url, image, category, retail,
//       firstSeenMs,
//       sizes: { [variantId]: { name, atcUrl, droppedMs, soldOutMs|null, pendingFalse } },
//       soldOutMs: number|null,
//     }
//   },
//   recap1Fired: boolean,
//   recap2Fired: boolean,
// }
const dropStateByRegion = new Map();

let deps = {
  webhooks:   {},
  regions:    {},
  queueAlert: null,
  ts:         () => new Date().toISOString().slice(11, 19),
};

export function init(_deps) {
  deps = { ...deps, ..._deps };
  loadState();
  console.log(`[Recap] Init — drop=${DROP_HOUR}:${String(DROP_MIN).padStart(2,'0')} local · ` +
              `recaps at +${RECAP1_DELAY_MIN}m and +${RECAP2_DELAY_MIN}m · ` +
              `confirm=${SELLOUT_CONFIRM_READS} reads`);
}

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────

function loadState() {
  try {
    if (!fs.existsSync(DROP_STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DROP_STATE_FILE, 'utf8'));
    for (const [regionKey, state] of Object.entries(raw)) {
      dropStateByRegion.set(regionKey, state);
    }
    console.log(`[Recap] Loaded state for ${dropStateByRegion.size} region(s) from ${DROP_STATE_FILE}`);
  } catch (err) {
    console.error(`[Recap] Load failed: ${err.message}`);
  }
}

function saveState() {
  try {
    const obj = {};
    for (const [k, v] of dropStateByRegion) obj[k] = v;
    fs.writeFileSync(DROP_STATE_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error(`[Recap] Save failed: ${err.message}`);
  }
}

// ─── TIME / DROP CONTEXT ─────────────────────────────────────────────────────

function getRegionLocalParts(tz, when = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(when);
  const get = (t) => parts.find(p => p.type === t)?.value;
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0; // en-US edge: midnight reported as "24"
  return {
    year:    Number(get('year')),
    month:   Number(get('month')),
    day:     Number(get('day')),
    hour,
    minute:  Number(get('minute')),
    second:  Number(get('second')),
    weekday: get('weekday'), // 'Sun'..'Sat'
  };
}

// Returns the wall-clock ms of (wantH:wantM) on the local Y-M-D in `tz`.
// Works by guessing UTC = that wall time, then nudging by the observed offset.
function localTimeToInstantMs(tz, year, month, day, wantH, wantM) {
  const guess = Date.UTC(year, month - 1, day, wantH, wantM, 0);
  const p = getRegionLocalParts(tz, new Date(guess));
  const dayDiff = (Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(year, month - 1, day)) / 86400000;
  const observedMin = p.hour * 60 + p.minute;
  const wantedMin   = wantH * 60 + wantM;
  const totalDiffMin = dayDiff * 1440 + (observedMin - wantedMin);
  return guess - totalDiffMin * 60000;
}

const WEEKDAY_IDX = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };

function getDropContext(regionKey, now = new Date()) {
  const region = deps.regions[regionKey];
  if (!region || !region.tz) return null;
  const local = getRegionLocalParts(region.tz, now);
  const weekdayIdx = WEEKDAY_IDX[local.weekday];
  if (weekdayIdx == null) return null;
  const daysSinceThu = (weekdayIdx - 4 + 7) % 7; // 0 on Thursday, 1 on Fri, ..., 6 on Wed

  // Anchor at noon today (DST-safe), back up to last Thursday, then resolve drop instant.
  const noonTodayMs = localTimeToInstantMs(region.tz, local.year, local.month, local.day, 12, 0);
  const thuNoonMs   = noonTodayMs - daysSinceThu * 86400000;
  const thuLocal    = getRegionLocalParts(region.tz, new Date(thuNoonMs));
  const dropInstantMs = localTimeToInstantMs(
    region.tz, thuLocal.year, thuLocal.month, thuLocal.day, DROP_HOUR, DROP_MIN,
  );
  const dropDate = `${thuLocal.year}-${String(thuLocal.month).padStart(2,'0')}-${String(thuLocal.day).padStart(2,'0')}`;
  const minutesSinceDrop = (now.getTime() - dropInstantMs) / 60000;
  const dropActive =
    minutesSinceDrop >= -PRE_DROP_TOLERANCE_MIN &&
    minutesSinceDrop <= DROP_WINDOW_HOURS * 60;

  return { dropDate, dropInstantMs, minutesSinceDrop, dropActive, region };
}

// ─── OBSERVATION HOOKS ───────────────────────────────────────────────────────

function ensureRegionState(regionKey, ctx) {
  let state = dropStateByRegion.get(regionKey);
  if (!state || state.dropDate !== ctx.dropDate) {
    state = {
      dropDate:      ctx.dropDate,
      dropInstantMs: ctx.dropInstantMs,
      products:      {},
      recap1Fired:   false,
      recap2Fired:   false,
    };
    dropStateByRegion.set(regionKey, state);
    saveState();
    console.log(`[Recap] New drop tracked: ${regionKey} ${ctx.dropDate} (instant=${new Date(ctx.dropInstantMs).toISOString()})`);
  }
  return state;
}

function productKey(product) {
  return product.handle || product.url || (product.title + '|' + (product.color || ''));
}

// Called per variant per cycle from monitor.js's checkStock loop.
// `prev` = previousStock.get(`${region.webhookKey}:${variant.id}`) (bool | undefined).
export function observeVariant(region, product, variant, prev, now = Date.now()) {
  const ctx = getDropContext(region.webhookKey, new Date(now));
  if (!ctx || !ctx.dropActive) return;
  const state = ensureRegionState(region.webhookKey, ctx);
  const pKey = productKey(product);

  let p = state.products[pKey];
  if (!p) {
    // Only start tracking a product the first time we see it in stock during the drop.
    if (!variant.available) return;
    p = state.products[pKey] = {
      title:       product.title,
      colorway:    product.color || null,
      url:         region.baseUrl + product.url,
      image:       product.image ? `https:${product.image}` : null,
      category:    product.product_type || '—',
      retail:      variant.price ? variant.price / 100 : null,
      firstSeenMs: now,
      sizes:       {},
      soldOutMs:   null,
    };
  }

  const sKey = String(variant.id);
  let s = p.sizes[sKey];
  if (!s) {
    s = p.sizes[sKey] = {
      name:         variant.title,
      atcUrl:       `${region.baseUrl}/cart/${variant.id}:1?storefront=true`,
      droppedMs:    variant.available ? now : null,
      soldOutMs:    null,
      pendingFalse: 0,
    };
  }

  if (variant.available) {
    if (!s.droppedMs) s.droppedMs = now;
    s.soldOutMs    = null; // restock — un-mark
    s.pendingFalse = 0;
  } else {
    // Not available. Count consecutive false reads, then confirm sellout.
    if (prev === true) {
      s.pendingFalse = 1;            // just flipped
    } else if (s.pendingFalse > 0 && !s.soldOutMs) {
      s.pendingFalse += 1;           // still false
    }
    if (s.pendingFalse >= SELLOUT_CONFIRM_READS && !s.soldOutMs && s.droppedMs) {
      s.soldOutMs = now;
    }
  }

  recomputeProductSellout(p);
}

function recomputeProductSellout(p) {
  const droppedSizes = Object.values(p.sizes).filter(s => s.droppedMs);
  if (!droppedSizes.length)              { p.soldOutMs = null; return; }
  if (droppedSizes.some(s => !s.soldOutMs)) { p.soldOutMs = null; return; }
  p.soldOutMs = Math.max(...droppedSizes.map(s => s.soldOutMs));
}

// Called once per region at the end of a successful (complete) checkStock cycle.
// `seenKeys` = Set of `${region.webhookKey}:${variant.id}` keys observed this cycle.
// Detects "variant disappeared from feed entirely" as a confirmed sellout,
// then persists state.
export function observeCycleEnd(region, seenKeys, now = Date.now()) {
  const state = dropStateByRegion.get(region.webhookKey);
  if (!state) return;
  for (const p of Object.values(state.products)) {
    for (const [sKey, s] of Object.entries(p.sizes)) {
      const fullKey = `${region.webhookKey}:${sKey}`;
      if (s.droppedMs && !s.soldOutMs && !seenKeys.has(fullKey)) {
        s.pendingFalse = (s.pendingFalse || 0) + 1;
        if (s.pendingFalse >= SELLOUT_CONFIRM_READS) s.soldOutMs = now;
      }
    }
    recomputeProductSellout(p);
  }
  saveState();
}

// ─── RECAP RENDERING ─────────────────────────────────────────────────────────

function fmtDuration(ms) {
  if (ms == null || ms < 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm.toString().padStart(2, '0')}m`;
}

function speedEmoji(ms) {
  if (ms < 5  * 60_000) return '🔥';
  if (ms < 30 * 60_000) return '⚡';
  return '⏱';
}

const CURRENCY_SYMBOLS = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', SGD: 'S$' };

function buildProductEmbed(region, p) {
  // Earliest dropped time across sizes — "how long was this product available?"
  const droppedSizes = Object.values(p.sizes).filter(s => s.droppedMs);
  const firstDropped = droppedSizes.length
    ? Math.min(...droppedSizes.map(s => s.droppedMs))
    : p.firstSeenMs;
  const productElapsed = p.soldOutMs - firstDropped;
  const speed = speedEmoji(productElapsed);

  const sizeLines = Object.values(p.sizes)
    .filter(s => s.soldOutMs && s.droppedMs)
    .sort((a, b) => (a.soldOutMs - a.droppedMs) - (b.soldOutMs - b.droppedMs))
    .map(s => {
      const elapsed = s.soldOutMs - s.droppedMs;
      return `${speedEmoji(elapsed)} **[${s.name}](${s.atcUrl})** · lasted ${fmtDuration(elapsed)}`;
    })
    .join('\n');

  const sym = CURRENCY_SYMBOLS[region.currency] || '$';
  const retailStr = p.retail != null ? `${sym}${Math.round(p.retail)}` : 'N/A';
  const soldCount = Object.values(p.sizes).filter(s => s.soldOutMs).length;
  const totalSizes = Object.values(p.sizes).filter(s => s.droppedMs).length;

  return {
    title:     `⛔ SOLD OUT — ${p.title}${p.colorway ? ` — ${p.colorway}` : ''} · ${speed} ${fmtDuration(productElapsed)}`,
    url:       p.url,
    color:     productElapsed < 5  * 60_000 ? 0xC0392B
             : productElapsed < 30 * 60_000 ? 0xE67E22
             :                                 0x95A5A6,
    thumbnail: p.image ? { url: p.image } : undefined,
    fields: [
      { name: '🏷️ Retail',          value: retailStr,                  inline: true },
      { name: '⏱ Time to Sellout',  value: fmtDuration(productElapsed), inline: true },
      { name: '🗂️ Category',        value: p.category || '—',          inline: true },
      { name: `${region.flag} Region`, value: region.label,             inline: true },
      {
        name:  `⛔ Sizes Sold Out (${soldCount}/${totalSizes})`,
        value: sizeLines || '—',
        inline: false,
      },
    ],
    footer:    { text: `Finest Monitors | ${region.label}` },
    timestamp: new Date(p.soldOutMs).toISOString(),
  };
}

async function postRecap(regionKey, slot /* 1 | 2 */) {
  const state  = dropStateByRegion.get(regionKey);
  const region = deps.regions[regionKey];
  if (!state || !region) return;
  const webhook = deps.webhooks[regionKey];
  if (!webhook || webhook.startsWith('PASTE')) {
    console.warn(`[Recap] No webhook configured for ${regionKey} — skipping recap #${slot}`);
    return;
  }

  // Sort by product-level time-to-sellout (fastest first).
  const soldOut = Object.values(state.products)
    .filter(p => p.soldOutMs)
    .map(p => {
      const dropped = Object.values(p.sizes).filter(s => s.droppedMs);
      const firstDropped = dropped.length ? Math.min(...dropped.map(s => s.droppedMs)) : p.firstSeenMs;
      return { p, elapsed: p.soldOutMs - firstDropped };
    })
    .sort((a, b) => a.elapsed - b.elapsed)
    .map(x => x.p);

  const totalDropped = Object.keys(state.products).length;
  const delayMin = slot === 1 ? RECAP1_DELAY_MIN : RECAP2_DELAY_MIN;
  const delayStr = delayMin >= 60 ? `${Math.round(delayMin / 60)}h` : `${delayMin}m`;

  console.log(`[${deps.ts()}][${regionKey}] 🧾 Recap #${slot} (Drop +${delayStr}) — ${soldOut.length}/${totalDropped} sold out`);

  const header = {
    title:       `🧾 Sell-Out Recap — ${region.label} — Drop +${delayStr}`,
    description: soldOut.length
      ? `**${soldOut.length}** of ${totalDropped} dropped items have sold out so far. Ranked fastest first.`
      : `Nothing has sold out yet (${totalDropped} items tracked).`,
    color:       0x2C3E50,
    footer:      { text: `Finest Monitors | ${region.label} | Drop ${state.dropDate}` },
    timestamp:   new Date().toISOString(),
  };

  // Discord caps embeds at 10/message — batch (header + 9, then 10s).
  const productEmbeds = soldOut.map(p => buildProductEmbed(region, p));
  const messages = [[header, ...productEmbeds.slice(0, 9)]];
  for (let i = 9; i < productEmbeds.length; i += 10) {
    messages.push(productEmbeds.slice(i, i + 10));
  }

  for (const embeds of messages) {
    await deps.queueAlert({ webhookUrl: webhook, body: { embeds } });
  }
}

// ─── SCHEDULER ───────────────────────────────────────────────────────────────

// Called every poll cycle from monitor.js.
export async function tickSchedule(activeRegionKeys = null) {
  if (!deps.queueAlert) return;
  const keys = activeRegionKeys || Object.keys(deps.regions);
  for (const k of keys) {
    if (!deps.regions[k]) continue;
    const ctx = getDropContext(k);
    if (!ctx) continue;
    const state = dropStateByRegion.get(k);
    if (!state || state.dropDate !== ctx.dropDate) continue;
    const m = ctx.minutesSinceDrop;
    if (RECAP1_DELAY_MIN > 0 && !state.recap1Fired && m >= RECAP1_DELAY_MIN) {
      state.recap1Fired = true;
      saveState();
      try { await postRecap(k, 1); } catch (e) { console.error(`[Recap] #1 ${k} failed:`, e.message); }
    }
    if (RECAP2_DELAY_MIN > 0 && !state.recap2Fired && m >= RECAP2_DELAY_MIN) {
      state.recap2Fired = true;
      saveState();
      try { await postRecap(k, 2); } catch (e) { console.error(`[Recap] #2 ${k} failed:`, e.message); }
    }
  }
}

// ─── TEST HOOK ───────────────────────────────────────────────────────────────
//
// `node monitor.js --test-recap [REGION]` posts a synthetic recap so the
// Discord format can be eyeballed without waiting for Thursday. Restores
// real state after sending so it doesn't pollute production.

export async function sendTestRecap(regionKey) {
  const region = deps.regions[regionKey];
  if (!region) { console.error(`[Recap] Unknown region: ${regionKey}`); return; }
  const ctx = getDropContext(regionKey);
  if (!ctx)   { console.error(`[Recap] No drop context for ${regionKey}`); return; }
  const d = ctx.dropInstantMs;

  const fake = {
    dropDate:      ctx.dropDate,
    dropInstantMs: d,
    recap1Fired:   false,
    recap2Fired:   false,
    products: {
      'fake-box-logo': {
        title: 'Box Logo Tee', colorway: 'Red',
        url: `${region.baseUrl}/products/test-1`, image: null,
        category: 'T-Shirts/Top', retail: 60, firstSeenMs: d,
        sizes: {
          't1': { name: 'Medium', atcUrl: '#', droppedMs: d, soldOutMs: d + 2 * 60_000,        pendingFalse: SELLOUT_CONFIRM_READS },
          't2': { name: 'Large',  atcUrl: '#', droppedMs: d, soldOutMs: d + 4 * 60_000 + 12_000, pendingFalse: SELLOUT_CONFIRM_READS },
        },
        soldOutMs: d + 4 * 60_000 + 12_000,
      },
      'fake-jacket': {
        title: 'Work Jacket', colorway: 'Black',
        url: `${region.baseUrl}/products/test-2`, image: null,
        category: 'Jackets/Top', retail: 248, firstSeenMs: d,
        sizes: {
          'j1': { name: 'Medium', atcUrl: '#', droppedMs: d, soldOutMs: d + 18 * 60_000, pendingFalse: SELLOUT_CONFIRM_READS },
          'j2': { name: 'Large',  atcUrl: '#', droppedMs: d, soldOutMs: d + 22 * 60_000, pendingFalse: SELLOUT_CONFIRM_READS },
          'j3': { name: 'XLarge', atcUrl: '#', droppedMs: d, soldOutMs: d + 35 * 60_000, pendingFalse: SELLOUT_CONFIRM_READS },
        },
        soldOutMs: d + 35 * 60_000,
      },
      'fake-cap': {
        title: 'Camp Cap', colorway: 'White',
        url: `${region.baseUrl}/products/test-3`, image: null,
        category: 'Accessories/Top', retail: 54, firstSeenMs: d,
        sizes: {
          'c1': { name: 'OS', atcUrl: '#', droppedMs: d, soldOutMs: d + 47 * 1000, pendingFalse: SELLOUT_CONFIRM_READS },
        },
        soldOutMs: d + 47 * 1000,
      },
    },
  };

  const prev = dropStateByRegion.get(regionKey);
  dropStateByRegion.set(regionKey, fake);
  try {
    await postRecap(regionKey, 1);
  } finally {
    if (prev) dropStateByRegion.set(regionKey, prev);
    else      dropStateByRegion.delete(regionKey);
  }
}

// Diagnostic export (don't rely on this externally).
export const _internal = { dropStateByRegion, getDropContext };
