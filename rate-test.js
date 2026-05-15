import fetch from 'node-fetch';
import http from 'http';

const PORT = process.env.PORT || 8080;
const TARGET = process.env.TARGET_URL || 'https://us.supreme.com/collections/all';

// Intervals to test (in seconds) — ramps up aggression
const INTERVALS = [5, 3, 2, 1];
const REQUESTS_PER_INTERVAL = 20; // send 20 requests at each speed before moving on

let results = [];
let running = true;

// Health check so Fly doesn't kill us
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'running', results }));
}).listen(PORT, () => console.log(`[Health] Listening on port ${PORT}`));

async function testRequest(intervalSec, attempt) {
  const start = Date.now();
  try {
    const res = await fetch(TARGET, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    const elapsed = Date.now() - start;
    const body = await res.text();
    const hasProducts = body.includes('products-json');
    const hasChallenge = body.includes('challenge') || body.includes('captcha') || body.includes('cf-browser-verification');
    const finalUrl = res.url;
    const bodyLen = body.length;

    const result = {
      interval: intervalSec,
      attempt,
      status: res.status,
      elapsed,
      bodyLen,
      hasProducts,
      hasChallenge,
      redirected: finalUrl !== TARGET,
      finalUrl: finalUrl !== TARGET ? finalUrl : null,
      time: new Date().toISOString(),
    };

    // Detect ban signals
    let banned = false;
    if (res.status === 403) { result.signal = '🚫 403 FORBIDDEN'; banned = true; }
    else if (res.status === 429) { result.signal = '🚫 429 RATE LIMITED'; banned = true; }
    else if (res.status === 503) { result.signal = '⚠️ 503 SERVICE UNAVAILABLE'; banned = true; }
    else if (hasChallenge) { result.signal = '⚠️ CHALLENGE/CAPTCHA'; banned = true; }
    else if (bodyLen < 1000) { result.signal = '⚠️ SUSPICIOUSLY SHORT RESPONSE'; }
    else if (!hasProducts) { result.signal = '⚠️ NO PRODUCT DATA'; }
    else { result.signal = '✅ OK'; }

    console.log(`[${intervalSec}s] #${attempt} | ${result.signal} | ${res.status} | ${elapsed}ms | ${bodyLen} bytes${result.redirected ? ' | REDIRECT → ' + result.finalUrl : ''}`);

    results.push(result);
    return banned;

  } catch (err) {
    const elapsed = Date.now() - start;
    const result = {
      interval: intervalSec,
      attempt,
      status: 'ERROR',
      elapsed,
      error: err.message,
      signal: `🚫 ${err.name}: ${err.message}`,
      time: new Date().toISOString(),
    };
    console.log(`[${intervalSec}s] #${attempt} | ${result.signal} | ${elapsed}ms`);
    results.push(result);
    return err.message.includes('timeout') ? false : true; // network error = possible ban
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runTest() {
  console.log(`\n========================================`);
  console.log(`Supreme Rate Limit Test`);
  console.log(`Target: ${TARGET}`);
  console.log(`Intervals: ${INTERVALS.join('s, ')}s`);
  console.log(`Requests per interval: ${REQUESTS_PER_INTERVAL}`);
  console.log(`========================================\n`);

  for (const interval of INTERVALS) {
    console.log(`\n--- Testing ${interval}s interval (${REQUESTS_PER_INTERVAL} requests) ---`);
    let banCount = 0;

    for (let i = 1; i <= REQUESTS_PER_INTERVAL; i++) {
      if (!running) return;

      const banned = await testRequest(interval, i);
      if (banned) banCount++;

      // If we get 3 consecutive bans at this interval, stop this tier
      if (banCount >= 3) {
        console.log(`\n🛑 Hit ban threshold at ${interval}s interval after ${i} requests`);
        console.log(`\n========== RESULTS SUMMARY ==========`);
        printSummary();
        console.log(`\nSafe interval: ${INTERVALS[INTERVALS.indexOf(interval) - 1] || interval}s or slower`);
        console.log(`Banned at: ${interval}s`);

        // Keep the process alive so you can check /health
        console.log(`\nTest complete. Check results at http://localhost:${PORT}`);
        return;
      }

      // Wait for the interval before next request
      if (i < REQUESTS_PER_INTERVAL) {
        await sleep(interval * 1000);
      }
    }

    // Brief pause between tiers
    console.log(`✅ ${interval}s interval passed — moving to next tier in 10s\n`);
    await sleep(10000);
  }

  console.log(`\n========== ALL INTERVALS PASSED ==========`);
  printSummary();
  console.log(`\nSupreme didn't block at any interval down to 1s!`);
  console.log(`\nTest complete. Check results at http://localhost:${PORT}`);
}

function printSummary() {
  const grouped = {};
  for (const r of results) {
    if (!grouped[r.interval]) grouped[r.interval] = { ok: 0, warn: 0, ban: 0, avgElapsed: 0 };
    const g = grouped[r.interval];
    if (r.signal?.startsWith('✅')) g.ok++;
    else if (r.signal?.startsWith('⚠️')) g.warn++;
    else g.ban++;
    g.avgElapsed += (r.elapsed || 0);
  }

  console.log('\nInterval | OK | Warn | Ban | Avg Response');
  console.log('---------|-----|------|-----|-------------');
  for (const [interval, g] of Object.entries(grouped)) {
    const total = g.ok + g.warn + g.ban;
    const avg = Math.round(g.avgElapsed / total);
    console.log(`${interval.padStart(5)}s   | ${String(g.ok).padStart(3)} | ${String(g.warn).padStart(4)} | ${String(g.ban).padStart(3)} | ${avg}ms`);
  }
}

runTest().catch(err => {
  console.error('Test failed:', err);
});
