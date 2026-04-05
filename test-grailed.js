// Run with: node test-grailed.js
// Extracts Grailed's Algolia config and tests a sold listings search

import fetch from 'node-fetch';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const ITEM = 'Find God Football Jersey';

// ── Step 1: Extract Algolia config from Grailed's __NEXT_DATA__ ───────────────

console.log('\nFetching Grailed homepage to extract Algolia config...');
const pageRes = await fetch('https://www.grailed.com', {
  headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
  redirect: 'follow',
});

const html    = await pageRes.text();
const marker  = '__NEXT_DATA__';
const idx     = html.indexOf(marker);
const start   = html.indexOf('>', idx) + 1;
const end     = html.indexOf('</script>', start);
const nextData = JSON.parse(html.slice(start, end));

const algolia = nextData?.props?.initialProps?.globalData?.public_config?.algolia;
console.log('\nFull Algolia config:');
console.log(JSON.stringify(algolia, null, 2));

if (!algolia?.apiKey) {
  console.log('\n⚠️  No apiKey in algolia config — printing full public_config:');
  console.log(JSON.stringify(nextData?.props?.initialProps?.globalData?.public_config, null, 2));
  process.exit(1);
}

const { appId, apiKey } = algolia;
const SOLD_INDEX = 'Listing_sold_by_high_price_production';

console.log(`\n✅ App ID: ${appId}`);
console.log(`✅ API Key: ${apiKey}`);
console.log(`✅ Using index: ${SOLD_INDEX}\n`);

// ── Step 2: Query Algolia for sold Supreme items ──────────────────────────────

console.log(`Searching Algolia for sold: "Supreme ${ITEM}"\n`);

const algoliaRes = await fetch(
  `https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/${SOLD_INDEX}/query`,
  {
    method: 'POST',
    headers: {
      'X-Algolia-Application-Id': appId,
      'X-Algolia-API-Key':        apiKey,
      'Content-Type':             'application/json',
    },
    body: JSON.stringify({
      query:               `Supreme ${ITEM}`,
      hitsPerPage:         20,
      attributesToRetrieve: ['title', 'designer_names', 'sold_price', 'price', 'size', 'category'],
    }),
  }
);

console.log(`Algolia status: ${algoliaRes.status}`);
const algoliaData = await algoliaRes.json();

if (algoliaData.hits?.length > 0) {
  console.log(`\n✅ Got ${algoliaData.hits.length} results. First 5:\n`);
  algoliaData.hits.slice(0, 5).forEach((h, i) => {
    console.log(`  ${i+1}. ${h.title} | sold_price: ${h.sold_price} | price: ${h.price?.amount} | size: ${h.size}`);
  });

  const prices = algoliaData.hits
    .map(h => h.sold_price || h.price?.amount)
    .filter(p => p != null && p > 0);

  if (prices.length > 0) {
    prices.sort((a, b) => a - b);
    const mid    = Math.floor(prices.length / 2);
    const median = Math.round(prices.length % 2 !== 0 ? prices[mid] : (prices[mid-1] + prices[mid]) / 2);
    console.log(`\n  All prices: ${prices.map(p => '$'+p).join(', ')}`);
    console.log(`  Median: $${median}`);
  }
} else {
  console.log('\n⚠️  No hits. Full response:');
  console.log(JSON.stringify(algoliaData, null, 2).slice(0, 1000));
}
