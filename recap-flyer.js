// ─── SELLOUT RECAP FLYER ──────────────────────────────────────────────────────
//
// Renders the weekly sell-out recap as a 1080×1350 PNG flyer (4:5 aspect ratio
// — fits Discord nicely and works for IG/Twitter shares). Top 3 fastest
// sellouts get a podium spotlight; items 4-8 appear in a clean list below.
//
// Tech: Satori (JSX-like → SVG) + @resvg/resvg-js (SVG → PNG). No headless
// Chrome / Puppeteer overhead. Fires once per drop (40×/year) so total
// rendering cost is negligible.
//
// Fonts: Inter Regular + Bold, downloaded once at first use from rsms/inter
// GitHub raw URLs and cached in memory.

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import fetch from 'node-fetch';

// ─── FONT LOADING ────────────────────────────────────────────────────────────

const FONT_URLS = {
  regular: 'https://github.com/rsms/inter/raw/master/docs/font-files/Inter-Regular.otf',
  bold:    'https://github.com/rsms/inter/raw/master/docs/font-files/Inter-Bold.otf',
};

let cachedFonts = null;

async function loadFonts() {
  if (cachedFonts) return cachedFonts;
  try {
    const [regularRes, boldRes] = await Promise.all([
      fetch(FONT_URLS.regular),
      fetch(FONT_URLS.bold),
    ]);
    if (!regularRes.ok || !boldRes.ok) {
      throw new Error(`Font fetch failed: ${regularRes.status} / ${boldRes.status}`);
    }
    const [regular, bold] = await Promise.all([
      regularRes.arrayBuffer(),
      boldRes.arrayBuffer(),
    ]);
    cachedFonts = [
      { name: 'Inter', data: regular, weight: 400, style: 'normal' },
      { name: 'Inter', data: bold,    weight: 700, style: 'normal' },
    ];
    console.log(`[Flyer] Inter fonts loaded (${(regular.byteLength + bold.byteLength) / 1024 | 0} KB)`);
    return cachedFonts;
  } catch (err) {
    console.error(`[Flyer] Font load failed: ${err.message}`);
    throw err;
  }
}

// ─── IMAGE PRE-FETCH ─────────────────────────────────────────────────────────

async function imageToDataUrl(url) {
  if (!url) return null;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function fmtTime(ms) {
  if (ms == null || ms < 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s > 0 ? `${m}m ${s.toString().padStart(2,'0')}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2,'0')}m`;
}

function speedColor(ms) {
  if (ms <  60 * 1000)      return '#E74C3C';
  if (ms < 300 * 1000)      return '#F39C12';
  return '#95A5A6';
}

const RED   = '#E74C3C';
const DARK  = '#0F0F0F';
const GREY  = '#6E6E6E';
const LIGHT = '#F5F5F5';
const WHITE = '#FFFFFF';
const BLACK = '#000000';

// ─── FLYER NODE TREE ─────────────────────────────────────────────────────────

function podiumCard({ rank, imageUrl, title, colorway, size, elapsed, isFirst }) {
  const imageSize = isFirst ? 280 : 200;
  const nameSize  = isFirst ? 28  : 22;
  const timeSize  = isFirst ? 56  : 40;

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        flex: 1,
        gap: 8,
      },
      children: [
        // Rank badge above image
        {
          type: 'div',
          props: {
            style: {
              fontSize: isFirst ? 36 : 28,
              fontWeight: 700,
              color: RED,
              marginBottom: 4,
            },
            children: `#${rank}`,
          },
        },
        // Image
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: imageSize,
              height: imageSize,
              borderRadius: 16,
              backgroundColor: LIGHT,
              overflow: 'hidden',
              border: `4px solid ${isFirst ? RED : DARK}`,
              alignItems: 'center',
              justifyContent: 'center',
            },
            children: imageUrl
              ? [{ type: 'img', props: { src: imageUrl, width: imageSize - 8, height: imageSize - 8, style: { objectFit: 'contain' } } }]
              : [{ type: 'div', props: { style: { color: GREY, fontSize: 14 }, children: 'No image' } }],
          },
        },
        // Time
        {
          type: 'div',
          props: {
            style: {
              fontSize: timeSize,
              fontWeight: 700,
              color: speedColor(elapsed),
              lineHeight: 1,
              marginTop: 8,
            },
            children: fmtTime(elapsed),
          },
        },
        // Product name
        {
          type: 'div',
          props: {
            style: {
              fontSize: nameSize,
              fontWeight: 700,
              color: DARK,
              textAlign: 'center',
              maxWidth: isFirst ? 360 : 240,
              lineHeight: 1.1,
              marginTop: 4,
            },
            children: title,
          },
        },
        // Colorway · Size
        {
          type: 'div',
          props: {
            style: {
              fontSize: isFirst ? 20 : 16,
              color: GREY,
              textAlign: 'center',
              maxWidth: isFirst ? 360 : 240,
              marginTop: 2,
            },
            children: [colorway, size].filter(Boolean).join(' · '),
          },
        },
      ],
    },
  };
}

function listRow({ rank, imageUrl, title, colorway, size, elapsed }) {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        padding: '12px 36px',
        borderBottom: `1px solid ${LIGHT}`,
        gap: 16,
      },
      children: [
        // Rank
        {
          type: 'div',
          props: {
            style: { fontSize: 22, fontWeight: 700, color: GREY, width: 40 },
            children: `${rank}`,
          },
        },
        // Image
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: 56,
              height: 56,
              borderRadius: 8,
              backgroundColor: LIGHT,
              overflow: 'hidden',
              alignItems: 'center',
              justifyContent: 'center',
            },
            children: imageUrl
              ? [{ type: 'img', props: { src: imageUrl, width: 56, height: 56, style: { objectFit: 'contain' } } }]
              : [],
          },
        },
        // Name + meta
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', flex: 1, gap: 2 },
            children: [
              {
                type: 'div',
                props: {
                  style: { fontSize: 20, fontWeight: 700, color: DARK, maxWidth: 600, overflow: 'hidden' },
                  children: title,
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 15, color: GREY },
                  children: [colorway, size].filter(Boolean).join(' · '),
                },
              },
            ],
          },
        },
        // Time
        {
          type: 'div',
          props: {
            style: { fontSize: 26, fontWeight: 700, color: speedColor(elapsed) },
            children: fmtTime(elapsed),
          },
        },
      ],
    },
  };
}

// ─── BUILD FLYER ─────────────────────────────────────────────────────────────

export async function buildRecapFlyer({
  region,
  rows,           // [{ product:{title,colorway,url,image}, size:{name}, elapsed }]
  totalProducts,
  totalVariants,
  dropDate,
  delayMin,
}) {
  const fonts = await loadFonts();

  // Pre-fetch images for top 8 to keep rendering reliable (Satori's runtime
  // image fetch can hang/fail; data URLs are stable).
  const top8 = rows.slice(0, 8);
  const dataUrls = await Promise.all(top8.map(r => imageToDataUrl(r.product.image)));

  const top3 = top8.slice(0, 3).map((r, i) => ({ ...r, imageUrl: dataUrls[i] }));
  const listed = top8.slice(3).map((r, i) => ({ ...r, imageUrl: dataUrls[i + 3] }));
  const remainderCount = Math.max(0, rows.length - 8);

  const delayStr = delayMin >= 60 ? `${Math.round(delayMin/60)}h` : `${delayMin}m`;

  // Podium order: rank 2 on left, rank 1 in center, rank 3 on right.
  const podiumChildren = [];
  if (top3[1]) podiumChildren.push(podiumCard({ rank: 2, ...top3[1].product, size: top3[1].size.name, colorway: top3[1].product.colorway, title: top3[1].product.title, imageUrl: top3[1].imageUrl, elapsed: top3[1].elapsed, isFirst: false }));
  if (top3[0]) podiumChildren.push(podiumCard({ rank: 1, ...top3[0].product, size: top3[0].size.name, colorway: top3[0].product.colorway, title: top3[0].product.title, imageUrl: top3[0].imageUrl, elapsed: top3[0].elapsed, isFirst: true }));
  if (top3[2]) podiumChildren.push(podiumCard({ rank: 3, ...top3[2].product, size: top3[2].size.name, colorway: top3[2].product.colorway, title: top3[2].product.title, imageUrl: top3[2].imageUrl, elapsed: top3[2].elapsed, isFirst: false }));

  const listChildren = listed.map((r, i) => listRow({
    rank:    i + 4,
    imageUrl: r.imageUrl,
    title:    r.product.title,
    colorway: r.product.colorway,
    size:     r.size.name,
    elapsed:  r.elapsed,
  }));

  const node = {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: 1080,
        height: 1350,
        backgroundColor: WHITE,
        fontFamily: 'Inter',
      },
      children: [
        // Header bar (red)
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              backgroundColor: RED,
              color: WHITE,
              padding: '24px 40px',
              alignItems: 'center',
              justifyContent: 'space-between',
              height: 110,
              boxSizing: 'border-box',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column' },
                  children: [
                    { type: 'div', props: { style: { fontSize: 22, fontWeight: 400, letterSpacing: 2, opacity: 0.9 }, children: 'FINEST MONITORS' } },
                    { type: 'div', props: { style: { fontSize: 44, fontWeight: 700, letterSpacing: -1, lineHeight: 1 }, children: `${region.label} Sell-Out Times` } },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' },
                  children: [
                    { type: 'div', props: { style: { fontSize: 18, opacity: 0.9 }, children: 'DROP' } },
                    { type: 'div', props: { style: { fontSize: 36, fontWeight: 700 }, children: `+${delayStr}` } },
                  ],
                },
              },
            ],
          },
        },

        // Podium row
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'flex-end',
              justifyContent: 'space-around',
              padding: '40px 30px 30px',
              height: 540,
              boxSizing: 'border-box',
            },
            children: podiumChildren.length ? podiumChildren : [{
              type: 'div',
              props: {
                style: { color: GREY, fontSize: 28, textAlign: 'center', width: '100%' },
                children: 'No sellouts tracked yet.',
              },
            }],
          },
        },

        // Section divider — "Also moved fast"
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              padding: '0 40px',
              gap: 20,
              marginTop: 4,
            },
            children: [
              { type: 'div', props: { style: { flex: 1, height: 2, backgroundColor: LIGHT } } },
              { type: 'div', props: { style: { fontSize: 18, fontWeight: 700, color: GREY, letterSpacing: 2 }, children: 'ALSO MOVED FAST' } },
              { type: 'div', props: { style: { flex: 1, height: 2, backgroundColor: LIGHT } } },
            ],
          },
        },

        // List
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', flex: 1, padding: '8px 0' },
            children: listChildren,
          },
        },

        // Footer
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              backgroundColor: DARK,
              color: WHITE,
              padding: '20px 40px',
              alignItems: 'center',
              justifyContent: 'space-between',
              height: 90,
              boxSizing: 'border-box',
            },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column' },
                  children: [
                    { type: 'div', props: { style: { fontSize: 16, opacity: 0.7 }, children: 'WEEKLY SELL-OUT TRACKER' } },
                    { type: 'div', props: { style: { fontSize: 22, fontWeight: 700 }, children: dropDate } },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' },
                  children: [
                    { type: 'div', props: { style: { fontSize: 16, opacity: 0.7 }, children: 'SOLD OUT' } },
                    { type: 'div', props: { style: { fontSize: 22, fontWeight: 700 }, children: `${rows.length} / ${totalVariants} variants${remainderCount > 0 ? ` (+${remainderCount} more)` : ''}` } },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };

  const svg = await satori(node, { width: 1080, height: 1350, fonts });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1080 } }).render().asPng();
  return png;
}
