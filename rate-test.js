import fetch from 'node-fetch';
import http from 'http';

const PORT = process.env.PORT || 8080;
const TARGET = process.env.TARGET_URL || 'https://us.supreme.com/collections/all';

// Phase 1: 5s for 10 min, Phase 2: 3s for 10 min, Phase 3: 1s for 10 min
// If all pass, Phase 4: 1s for 24 hours
const PHASES = [
  { interval: 5, duration: 10 * 60 * 1000, label: '5s for 10 min' },
  { interval: 3, duration: 10 * 60 * 1000, label: '3s for 10 min' },
  { interval: 1, duration: 10 * 60 * 1000, label: '1s for 10 min' },
  { interval: 1, duration: 24 * 60 * 60 * 1000, label: '1s for 24 hours' },
];

let results = [];
let currentPhase = null;
let phaseStats = { ok: 0, warn: 0, ban: 0, total: 0 };

// Health check
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'running',
    currentPhase,
    phaseStats,
    lastResults: results.slice(-10),
  }));
}).listen(PORT, () => console.log(`[Health] Listening on port ${PORT}`));

async function ping(intervalSec, attempt) {
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
    const bodyLen = body.length;

    let signal, banned = false;
    if (res.status === 403) { signal = '🚫 403 FORBIDDEN'; banned = true; }
    else if (res.status === 429) { signal = '🚫 429 RATE LIMITED'; banned = true; }
    else if (res.status === 503) { signal = '⚠️ 503 SERVICE UNAVAIL'; banned = true; }
    else if (hasProducts) { signal = '✅ OK'; }
    else if (hasChallenge) { signal = '⚠️ CHALLENGE'; banned = true; }
    else if (bodyLen < 1000) { signal = '⚠️ SHORT RESPONSE'; banned = true; }
    else { signal = '⚠️ NO PRODUCTS'; }

    // Only log every 10th request to keep logs clean, or if there's a problem
    if (attempt % 10 === 0 || attempt === 1 || banned || !hasProducts) {
      console.log(`[${intervalSec}s] #${attempt} | ${signal} | ${res.status} | ${elapsed}ms | ${bodyLen} bytes`);
    }

    results.push({ interval: intervalSec, attempt, signal, status: res.status, elapsed, bodyLen, time: new Date().toISOString() });
    // Keep results array from growing forever
    if (results.length > 500) results = results.slice(-250);

    return banned;

  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`[${intervalSec}s] #${attempt} | 🚫 ${err.name} | ${elapsed}ms`);
    results.push({ interval: intervalSec, attempt, signal: `🚫 ${err.name}`, elapsed, time: new Date().toISOString() });
    return true;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runTest() {
  console.log(`\n========================================`);
  console.log(`Supreme Rate Limit Test`);
  console.log(`Target: ${TARGET}`);
  console.log(`Phases: ${PHASES.map(p => p.label).join(' → ')}`);
  console.log(`========================================\n`);

  for (let p = 0; p < PHASES.length; p++) {
    const phase = PHASES[p];
    currentPhase = phase.label;
    phaseStats = { ok: 0, warn: 0, ban: 0, total: 0 };
    let consecutiveBans = 0;

    const totalRequests = Math.floor(phase.duration / (phase.interval * 1000));
    console.log(`\n━━━ PHASE ${p + 1}: ${phase.label} (${totalRequests} requests) ━━━`);

    const phaseStart = Date.now();

    for (let i = 1; i <= totalRequests; i++) {
      const banned = await ping(phase.interval, i);

      phaseStats.total++;
      if (banned) {
        phaseStats.ban++;
        consecutiveBans++;
      } else {
        phaseStats.ok++;
        consecutiveBans = 0;
      }

      // 5 consecutive bans = this interval is too aggressive
      if (consecutiveBans >= 5) {
        const elapsed = Math.round((Date.now() - phaseStart) / 1000);
        console.log(`\n🛑 BANNED at ${phase.interval}s after ${elapsed}s (${i} requests)`);
        console.log(`Stats: ${phaseStats.ok} OK / ${phaseStats.ban} banned out of ${phaseStats.total}`);
        console.log(`\nSafe limit is somewhere above ${phase.interval}s`);
        console.log(`Process staying alive for health check inspection.`);
        await sleep(999999999);
        return;
      }

      // Log summary every 60 seconds
      if (i % Math.max(1, Math.floor(60 / phase.interval)) === 0) {
        const elapsed = Math.round((Date.now() - phaseStart) / 1000);
        const pct = ((phaseStats.ok / phaseStats.total) * 100).toFixed(1);
        console.log(`  📊 ${elapsed}s in | ${phaseStats.ok}/${phaseStats.total} OK (${pct}%) | ${phaseStats.ban} banned`);
      }

      await sleep(phase.interval * 1000);
    }

    const elapsed = Math.round((Date.now() - phaseStart) / 1000);
    const pct = ((phaseStats.ok / phaseStats.total) * 100).toFixed(1);
    console.log(`\n✅ PHASE ${p + 1} PASSED: ${phase.label}`);
    console.log(`   ${phaseStats.ok}/${phaseStats.total} OK (${pct}%) in ${elapsed}s | ${phaseStats.ban} banned`);

    if (p < PHASES.length - 1) {
      console.log(`\n⏳ 30s cooldown before next phase...\n`);
      await sleep(30000);
    }
  }

  console.log(`\n🏆 ALL PHASES PASSED — Supreme allows 1 req/sec sustained for 24 hours!`);
  console.log(`Process staying alive for health check inspection.`);
  await sleep(999999999);
}

runTest().catch(err => {
  console.error('Test failed:', err);
});
