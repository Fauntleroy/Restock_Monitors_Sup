// Quick test — run with: node test-ebay.js
// Fetches eBay sold listings for a Supreme item and shows what prices we get back

import fetch from 'node-fetch';

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

const searchQuery = 'Supreme Find God Football Jersey';

const url = 'https://www.ebay.com/sch/i.html'
  + `?_nkw=${encodeURIComponent(searchQuery)}`
  + '&LH_Sold=1&LH_Complete=1&_sacat=0&_sop=13';

console.log(`\nFetching: ${url}\n`);

const res = await fetch(url, {
  headers: {
    'User-Agent':      pick(UAS),
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection':      'keep-alive',
  },
  redirect: 'follow',
});

console.log(`HTTP status: ${res.status}\n`);
const html = await res.text();

// ── Show raw HTML snippet around first price hit ─────────────────────────────
const priceIdx = html.indexOf('s-item__price');
if (priceIdx === -1) {
  console.log('⚠️  Could not find "s-item__price" anywhere in the HTML.');
  console.log('    eBay may have returned a bot-check page.\n');
  console.log('── First 2000 chars of response ──');
  console.log(html.slice(0, 2000));
} else {
  console.log('✅ Found "s-item__price" in HTML. Raw snippet:\n');
  console.log('---');
  console.log(html.slice(Math.max(0, priceIdx - 30), priceIdx + 300));
  console.log('---\n');
}

// ── Run the updated regex (same one now in monitor.js) ───────────────────────
const priceRegex = /class="s-item__price"[\s\S]{0,200}?\$([\d,]+(?:\.\d{2})?)/g;
const prices = [];
let m;
while ((m = priceRegex.exec(html)) !== null) {
  const val = parseFloat(m[1].replace(/,/g, ''));
  if (!isNaN(val) && val > 5 && val < 50000) prices.push(val);
}

if (prices.length === 0) {
  console.log('❌ Regex matched 0 prices.');
  console.log('   Paste the snippet above and we\'ll fix the pattern.\n');
} else {
  prices.sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median = Math.round(
    prices.length % 2 !== 0
      ? prices[mid]
      : (prices[mid - 1] + prices[mid]) / 2
  );
  console.log(`✅ Extracted ${prices.length} prices:`);
  console.log(`   All:    ${prices.map(p => '$' + p).join(', ')}`);
  console.log(`   Median: $${median}\n`);
}
