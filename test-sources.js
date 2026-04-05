// Run with: node test-sources.js
// Tests multiple resale data sources and reports which ones work

import fetch from 'node-fetch';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const ITEM  = 'Find God Football Jersey';
const QUERY = `Supreme ${ITEM}`;

console.log(`\nTesting resale sources for: "${QUERY}"\n`);
console.log('='.repeat(60));

// ── Helper ────────────────────────────────────────────────────────────────────

async function tryFetch(label, url, options = {}) {
  console.log(`\n[${label}] Fetching...`);
  try {
    const ctrl  = new AbortController();
    setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, { ...options, signal: ctrl.signal, redirect: 'follow' });
    console.log(`[${label}] Status: ${res.status}`);
    return { res, text: await res.text() };
  } catch (err) {
    console.log(`[${label}] FAILED: ${err.message}`);
    return null;
  }
}

// ── 1. Grailed — try to get __NEXT_DATA__ JSON from their search page ─────────

const grailedResult = await tryFetch(
  'Grailed',
  `https://www.grailed.com/shop?query=${encodeURIComponent(QUERY)}`,
  { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } }
);

if (grailedResult) {
  const { text: html } = grailedResult;
  const marker = '__NEXT_DATA__';
  const idx = html.indexOf(marker);
  if (idx === -1) {
    console.log('[Grailed] No __NEXT_DATA__ found');
    const snippet = html.slice(0, 500);
    console.log('[Grailed] Page start:', snippet);
  } else {
    console.log('[Grailed] ✅ Found __NEXT_DATA__');
    const start = html.indexOf('>', idx) + 1;
    const end   = html.indexOf('</script>', start);
    try {
      const json   = JSON.parse(html.slice(start, end));
      const props  = JSON.stringify(json).slice(0, 800);
      console.log('[Grailed] Data preview:', props);
    } catch (e) {
      console.log('[Grailed] Could not parse JSON:', e.message);
    }
  }
}

// ── 2. Depop — JSON search API ────────────────────────────────────────────────

const depopResult = await tryFetch(
  'Depop',
  `https://www.depop.com/search/?q=${encodeURIComponent(QUERY)}&sold=true`,
  { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' } }
);

if (depopResult) {
  const { text: html } = depopResult;
  const marker = '__NEXT_DATA__';
  const idx = html.indexOf(marker);
  if (idx === -1) {
    console.log('[Depop] No __NEXT_DATA__ found');
  } else {
    console.log('[Depop] ✅ Found __NEXT_DATA__');
    const start = html.indexOf('>', idx) + 1;
    const end   = html.indexOf('</script>', start);
    try {
      const json  = JSON.parse(html.slice(start, end));
      console.log('[Depop] Data preview:', JSON.stringify(json).slice(0, 800));
    } catch (e) {
      console.log('[Depop] Could not parse JSON:', e.message);
    }
  }
}

// ── 3. Mercari US — public search API ────────────────────────────────────────

const mercariResult = await tryFetch(
  'Mercari',
  'https://api.mercari.com/items/get_items?' + new URLSearchParams({
    keyword:    QUERY,
    status:     'sold_out',
    sort_order: 'created_time:desc',
    limit:      20,
  }),
  { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' } }
);

if (mercariResult) {
  const { text } = mercariResult;
  try {
    const json  = JSON.parse(text);
    const items = json?.data || json?.items || [];
    if (items.length > 0) {
      console.log(`[Mercari] ✅ Got ${items.length} items`);
      console.log('[Mercari] First item:', JSON.stringify(items[0]).slice(0, 400));
    } else {
      console.log('[Mercari] No items in response');
      console.log('[Mercari] Response preview:', text.slice(0, 400));
    }
  } catch {
    console.log('[Mercari] Not JSON. Response:', text.slice(0, 400));
  }
}

// ── 4. eBay Finding API — only if you have an App ID ─────────────────────────

const EBAY_APP_ID = ''; // ← paste your App ID here if you have it, otherwise leave blank

if (EBAY_APP_ID) {
  const ebayResult = await tryFetch(
    'eBay API',
    'https://svcs.ebay.com/services/search/FindingService/v1?' + new URLSearchParams({
      'OPERATION-NAME':              'findCompletedItems',
      'SERVICE-VERSION':             '1.0.0',
      'SECURITY-APPNAME':            EBAY_APP_ID,
      'RESPONSE-DATA-FORMAT':        'JSON',
      'keywords':                    QUERY,
      'itemFilter(0).name':          'SoldItemsOnly',
      'itemFilter(0).value':         'true',
      'paginationInput.entriesPerPage': '10',
    })
  );
  if (ebayResult) {
    try {
      const json  = JSON.parse(ebayResult.text);
      const items = json?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
      console.log(`[eBay API] ✅ Got ${items.length} sold items`);
      if (items[0]) console.log('[eBay API] First price:', items[0]?.sellingStatus?.[0]?.currentPrice?.[0]?.__value__);
    } catch {
      console.log('[eBay API] Response:', ebayResult.text.slice(0, 400));
    }
  }
} else {
  console.log('\n[eBay API] Skipped — no App ID set');
}

console.log('\n' + '='.repeat(60));
console.log('Done. Paste results above and we\'ll implement the winner.\n');
