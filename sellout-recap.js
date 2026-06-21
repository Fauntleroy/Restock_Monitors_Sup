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
import { buildRecapFlyer } from './recap-flyer.js';

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

function buildFullListText(region, rows, totalVariants, totalProducts, dropDate, delayStr) {
  const lines = [
    `${region.label} — Sell-Out Recap — Drop ${dropDate}`,
    `Drop +${delayStr} · ${rows.length} of ${totalVariants} variants sold out across ${totalProducts} products`,
    `Ranked fastest first.`,
    '',
  ];
  rows.forEach((row, idx) => {
    const { product: p, size: s, elapsed } = row;
    const colorway = p.colorway || '—';
    const time = fmtDuration(elapsed);
    const rank = (idx + 1).toString().padStart(3, ' ');
    lines.push(`${rank}. ${p.title} — ${colorway} — ${s.name} — ${time}`);
  });
  lines.push('');
  lines.push('Generated by Finest Monitors.');
  return lines.join('\n');
}

const CURRENCY_SYMBOLS = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', SGD: 'S$' };

async function postRecap(regionKey, slot /* 1 | 2 */) {
  const state  = dropStateByRegion.get(regionKey);
  const region = deps.regions[regionKey];
  if (!state || !region) return;
  // Prefer a region-specific recap webhook (RECAP_WEBHOOK_<REGION>) so the
  // recap can land in a different Discord channel/thread than the restocks.
  // Falls back to the restock webhook if no recap-specific one is set.
  const webhook = process.env[`RECAP_WEBHOOK_${regionKey}`] || deps.webhooks[regionKey];
  if (!webhook || webhook.startsWith('PASTE')) {
    console.warn(`[Recap] No webhook configured for ${regionKey} — skipping recap #${slot}`);
    return;
  }

  // Flatten every sold-out variant into a single ranked list (fastest first).
  // One row per variant — matches the "Times" page format the user referenced.
  const rows = [];
  let totalVariants = 0;
  for (const p of Object.values(state.products)) {
    for (const s of Object.values(p.sizes)) {
      if (s.droppedMs) totalVariants++;
      if (s.soldOutMs && s.droppedMs) {
        rows.push({ product: p, size: s, elapsed: s.soldOutMs - s.droppedMs });
      }
    }
  }
  rows.sort((a, b) => a.elapsed - b.elapsed);

  const totalProducts = Object.keys(state.products).length;
  const delayMin = slot === 1 ? RECAP1_DELAY_MIN : RECAP2_DELAY_MIN;
  const delayStr = delayMin >= 60 ? `${Math.round(delayMin / 60)}h` : `${delayMin}m`;

  console.log(`[${deps.ts()}][${regionKey}] 🧾 Recap #${slot} (Drop +${delayStr}) — ${rows.length} variants sold across ${totalProducts} products`);

  // Discord embed description maxes at 4096 chars. Cap at 40 fastest rows.
  const MAX_RECAP_ITEMS = 40;
  const visibleRows = rows.slice(0, MAX_RECAP_ITEMS);
  const truncated   = rows.length - visibleRows.length;

  const lines = visibleRows.map((row, idx) => {
    const { product: p, size: s, elapsed } = row;
    const speed    = speedEmoji(elapsed);
    const nameLink = `[${p.title}](${p.url})`;
    const colorway = p.colorway ? `${p.colorway} · ` : '';
    const time     = fmtDuration(elapsed);
    return `**${idx + 1}.** ${nameLink} · ${colorway}${s.name} · \`${time}\` ${speed}`;
  });

  let description = rows.length === 0
    ? `_No items have sold out yet — ${totalVariants} variants tracked across ${totalProducts} products._`
    : lines.join('\n');
  if (truncated > 0) {
    description += `\n\n_… and ${truncated} more (showing top ${MAX_RECAP_ITEMS} fastest)_`;
  }

  // Try to render the flyer PNG. If it works, post via multipart so Discord
  // shows the image as the embed hero. If anything fails, fall back to the
  // text-only embed so the data still lands.
  let pngBuffer = null;
  try {
    pngBuffer = await buildRecapFlyer({
      region,
      rows,
      totalProducts,
      totalVariants,
      dropDate: state.dropDate,
      delayMin,
    });
    console.log(`[${deps.ts()}][${regionKey}] 🖼️ Recap flyer rendered (${pngBuffer.length} bytes)`);
  } catch (e) {
    console.error(`[Recap] Flyer render failed — falling back to text embed:`, e.message);
  }

  if (pngBuffer) {
    const heroEmbed = {
      title:     `🧾 ${region.label} Sell-Out Times — Drop +${delayStr}`,
      color:     0xE74C3C, // Finest red
      image:     { url: 'attachment://sellout-recap.png' },
      footer:    { text: `Finest Monitors · ${region.label} · ${rows.length} / ${totalVariants} variants sold · Drop ${state.dropDate}` },
      timestamp: new Date().toISOString(),
    };
    try {
      const fullListText = buildFullListText(region, rows, totalVariants, totalProducts, state.dropDate, delayStr);
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ embeds: [heroEmbed] }));
      form.append('files[0]', new Blob([pngBuffer], { type: 'image/png' }), 'sellout-recap.png');
      form.append('files[1]', new Blob([fullListText], { type: 'text/plain' }), `sellout-recap-${state.dropDate}.txt`);
      const res = await fetch(webhook, { method: 'POST', body: form });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Discord ${res.status}: ${txt.slice(0, 200)}`);
      }
      return;
    } catch (e) {
      console.error(`[Recap] Multipart upload failed — falling back to text embed:`, e.message);
    }
  }

  // Fallback: text-only embed via the queue.
  const embed = {
    title:       `🧾 ${region.label} Sell-Out Times — Drop +${delayStr}`,
    description,
    color:       0xE74C3C,
    footer:      { text: `Finest Monitors · ${region.label} · ${rows.length} / ${totalVariants} variants sold · Drop ${state.dropDate}` },
    timestamp:   new Date().toISOString(),
  };
  await deps.queueAlert({ webhookUrl: webhook, body: { embeds: [embed] } });
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

// Generate a synthetic recap using REAL products from the current catalog.
// Used by TEST_RECAP_USE_SNAPSHOT mode — gives a realistic preview with real
// product names, colorways, and images so we know image fetching + layout
// work end-to-end before the next live Thursday drop.
export async function sendSnapshotTestRecap(regionKey, products) {
  const region = deps.regions[regionKey];
  if (!region) { console.error(`[Recap] Unknown region: ${regionKey}`); return; }
  const ctx = getDropContext(regionKey);
  if (!ctx)   { console.error(`[Recap] No drop context for ${regionKey}`); return; }
  const d = ctx.dropInstantMs;

  // Pick up to 30 products that have at least one available variant.
  const pool = (products || []).filter(p => (p.variants || []).some(v => v.available));
  // Stable-ish sampling: take from the start of the list (the first 30 products
  // shown on the site). Simulates the "newest items" being the ones tracked.
  const sampled = pool.slice(0, 30);

  const fakeProducts = {};
  let i = 0;
  for (const p of sampled) {
    const availVariants = (p.variants || []).filter(v => v.available);
    if (!availVariants.length) continue;
    const pKey = p.handle || p.url || (p.title + '|' + (p.color || ''));

    // Pick 1-3 sizes per product.
    const numSizes = Math.min(availVariants.length, 1 + Math.floor(Math.random() * 3));
    const picked = availVariants.slice().sort(() => Math.random() - 0.5).slice(0, numSizes);

    const sizes = {};
    let productSoldOutMs = 0;
    for (const v of picked) {
      i++;
      // Generate plausible sellout times: top few items go fast (5-60s),
      // rest spread between 30s and 5min. Adds a rank-influenced bias so the
      // ranking looks realistic.
      const baseMs = (i <= 3 ? (5 + Math.random() * 25)
                    : i <= 10 ? (15 + Math.random() * 90)
                    :           (60 + Math.random() * 240)) * 1000;
      const soldOutMs = d + baseMs;
      sizes[String(v.id)] = {
        name:        v.title,
        atcUrl:      `${region.baseUrl}/cart/${v.id}:1?storefront=true`,
        droppedMs:   d,
        soldOutMs,
        pendingFalse: SELLOUT_CONFIRM_READS,
      };
      productSoldOutMs = Math.max(productSoldOutMs, soldOutMs);
    }

    fakeProducts[pKey] = {
      title:       p.title,
      colorway:    p.color || null,
      url:         region.baseUrl + (p.url || ''),
      image:       p.image ? `https:${p.image}` : null,
      category:    p.product_type || '—',
      retail:      p.variants?.[0]?.price ? p.variants[0].price / 100 : null,
      firstSeenMs: d,
      sizes,
      soldOutMs:   productSoldOutMs,
    };
  }

  const fake = {
    dropDate:      ctx.dropDate,
    dropInstantMs: d,
    products:      fakeProducts,
    recap1Fired:   false,
    recap2Fired:   false,
  };

  console.log(`[Recap] Snapshot test recap — ${Object.keys(fakeProducts).length} real products synthesized for ${regionKey}`);

  const prev = dropStateByRegion.get(regionKey);
  dropStateByRegion.set(regionKey, fake);
  try {
    await postRecap(regionKey, 1);
  } finally {
    if (prev) dropStateByRegion.set(regionKey, prev);
    else      dropStateByRegion.delete(regionKey);
  }
}

// Curated test recap: takes a hand-curated list of items with their real
// sellout times and tries to match each against the current catalog. Used
// to verify image pulling and visual layout with known data.
function matchColor(a, b) {
  if (!b) return true;
  const A = (a || '').toLowerCase().trim();
  const B = b.toLowerCase().trim();
  return A === B || A.includes(B) || B.includes(A);
}

function findCatalogMatch(products, titleHint, color, sizeName) {
  const hint = titleHint.toLowerCase();
  const candidates = products.filter(p =>
    p.title.toLowerCase().includes(hint) && matchColor(p.color, color)
  );
  if (!candidates.length) return null;
  for (const p of candidates) {
    const v = (p.variants || []).find(v => (v.title || '').toLowerCase() === (sizeName || '').toLowerCase());
    if (v) return { product: p, variant: v };
  }
  // Fallback: first candidate with its first available variant.
  const p = candidates[0];
  const v = (p.variants || [])[0];
  return v ? { product: p, variant: v } : null;
}

export async function sendCuratedTestRecap(regionKey, products, items) {
  const region = deps.regions[regionKey];
  if (!region) { console.error(`[Recap] Unknown region: ${regionKey}`); return; }
  const ctx = getDropContext(regionKey);
  if (!ctx)   { console.error(`[Recap] No drop context for ${regionKey}`); return; }
  const d = ctx.dropInstantMs;

  const fakeProducts = {};
  let matched = 0, missed = 0;
  const matchLog = [];

  for (const item of items) {
    const match = findCatalogMatch(products, item.titleHint, item.color, item.sizeName);
    if (!match) {
      matchLog.push(`  ❌ ${item.titleHint} · ${item.color || '—'} · ${item.sizeName || '—'} · ${item.timeSec}s`);
      missed++;
      continue;
    }
    matched++;
    const { product: p, variant: v } = match;
    const pKey = (p.handle || p.url || p.title) + '|' + (p.color || '');
    const soldOutMs = d + (item.timeSec * 1000);
    matchLog.push(`  ✓  ${p.title} · ${p.color || '—'} · ${v.title} · ${item.timeSec}s  ${p.image ? '[img ok]' : '[no img]'}`);

    if (!fakeProducts[pKey]) {
      fakeProducts[pKey] = {
        title:       p.title,
        colorway:    p.color || null,
        url:         region.baseUrl + (p.url || ''),
        image:       p.image ? `https:${p.image}` : null,
        category:    p.product_type || '—',
        retail:      v.price ? v.price / 100 : null,
        firstSeenMs: d,
        sizes:       {},
        soldOutMs:   0,
      };
    }
    fakeProducts[pKey].sizes[String(v.id)] = {
      name:         v.title,
      atcUrl:       `${region.baseUrl}/cart/${v.id}:1?storefront=true`,
      droppedMs:    d,
      soldOutMs,
      pendingFalse: SELLOUT_CONFIRM_READS,
    };
    fakeProducts[pKey].soldOutMs = Math.max(fakeProducts[pKey].soldOutMs, soldOutMs);
  }

  console.log(`[Recap] Curated test recap — matched ${matched}/${items.length} items (${missed} missed):`);
  matchLog.forEach(l => console.log(l));

  const fake = {
    dropDate:      ctx.dropDate,
    dropInstantMs: d,
    products:      fakeProducts,
    recap1Fired:   false,
    recap2Fired:   false,
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
