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

// Inter via jsdelivr-hosted @fontsource (.woff — Satori supports TTF, OTF, WOFF;
// NOT WOFF2). These URLs are version-pinned and stable.
const FONT_URLS = {
  regular: 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5/files/inter-latin-400-normal.woff',
  bold:    'https://cdn.jsdelivr.net/npm/@fontsource/inter@5/files/inter-latin-700-normal.woff',
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

// Finest theme palette — gold + black + white. Reds kept only for the time
// pills (visual urgency for "this sold out fast").
const GOLD       = '#D4AF37';
const GOLD_DEEP  = '#A87C1B';
const BLACK      = '#0A0A0A';
const DARK       = '#1A1A1A';
const GREY       = '#6E6E6E';
const LIGHT      = '#EEEEEE';
const WHITE      = '#FFFFFF';
const RED        = '#E74C3C';
const LOGO_URL   = process.env.LOGO_URL || null; // hosted PNG URL of LF logo; falls back to gold text

// ─── FLYER NODE TREE ─────────────────────────────────────────────────────────

function podiumCard({ rank, imageUrl, title, colorway, size, elapsed, isFirst }) {
  const imageSize = isFirst ? 260 : 180;
  const nameSize  = isFirst ? 26  : 20;
  const timeSize  = isFirst ? 52  : 36;
  const borderClr = isFirst ? GOLD : BLACK;

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        flex: 1,
        gap: 6,
      },
      children: [
        // Rank badge
        {
          type: 'div',
          props: {
            style: {
              fontSize: isFirst ? 34 : 26,
              fontWeight: 700,
              color: borderClr,
              marginBottom: 2,
              letterSpacing: 1,
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
              borderRadius: 12,
              backgroundColor: LIGHT,
              overflow: 'hidden',
              border: `${isFirst ? 5 : 3}px solid ${borderClr}`,
              alignItems: 'center',
              justifyContent: 'center',
            },
            children: imageUrl
              ? [{ type: 'img', props: { src: imageUrl, width: imageSize - 10, height: imageSize - 10, style: { objectFit: 'contain' } } }]
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
              marginTop: 6,
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
              color: BLACK,
              textAlign: 'center',
              maxWidth: isFirst ? 340 : 220,
              lineHeight: 1.1,
              marginTop: 2,
            },
            children: title,
          },
        },
        // Colorway · Size
        {
          type: 'div',
          props: {
            style: {
              fontSize: isFirst ? 18 : 14,
              color: GREY,
              textAlign: 'center',
              maxWidth: isFirst ? 340 : 220,
              marginTop: 1,
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
        padding: '6px 36px',
        borderBottom: `1px solid ${LIGHT}`,
        gap: 14,
        height: 50,
      },
      children: [
        // Rank
        {
          type: 'div',
          props: {
            style: { fontSize: 18, fontWeight: 700, color: GOLD_DEEP, width: 32 },
            children: `${rank}`,
          },
        },
        // Image
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              width: 40,
              height: 40,
              borderRadius: 6,
              backgroundColor: LIGHT,
              overflow: 'hidden',
              alignItems: 'center',
              justifyContent: 'center',
            },
            children: imageUrl
              ? [{ type: 'img', props: { src: imageUrl, width: 40, height: 40, style: { objectFit: 'contain' } } }]
              : [],
          },
        },
        // Name + meta
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', flex: 1, gap: 1 },
            children: [
              {
                type: 'div',
                props: {
                  style: { fontSize: 16, fontWeight: 700, color: BLACK, maxWidth: 620, overflow: 'hidden' },
                  children: title,
                },
              },
              {
                type: 'div',
                props: {
                  style: { fontSize: 12, color: GREY },
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
            style: { fontSize: 22, fontWeight: 700, color: speedColor(elapsed) },
            children: fmtTime(elapsed),
          },
        },
      ],
    },
  };
}

function logoBlock() {
  if (LOGO_URL) {
    return {
      type: 'img',
      props: { src: LOGO_URL, width: 72, height: 72, style: { objectFit: 'contain' } },
    };
  }
  // Text-based LF mark as placeholder until LOGO_URL is set
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        fontSize: 60,
        fontWeight: 700,
        color: GOLD,
        letterSpacing: -2,
        lineHeight: 1,
      },
      children: 'LF',
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

  // Pre-fetch images for top 23 (3 podium + up to 20 list rows) to keep
  // rendering reliable. Satori's runtime image fetch can hang/fail; data URLs
  // are stable.
  const MAX_LIST_ROWS = 20;
  const TOP_N = 3 + MAX_LIST_ROWS;
  const topN = rows.slice(0, TOP_N);
  const dataUrls = await Promise.all(topN.map(r => imageToDataUrl(r.product.image)));

  const top3 = topN.slice(0, 3).map((r, i) => ({ ...r, imageUrl: dataUrls[i] }));
  const listed = topN.slice(3).map((r, i) => ({ ...r, imageUrl: dataUrls[i + 3] }));
  const remainderCount = Math.max(0, rows.length - TOP_N);

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
        // Header bar (BLACK with gold accents)
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              backgroundColor: BLACK,
              color: WHITE,
              padding: '20px 40px',
              alignItems: 'center',
              justifyContent: 'space-between',
              height: 110,
              boxSizing: 'border-box',
              borderBottom: `4px solid ${GOLD}`,
            },
            children: [
              // Left: LF logo + title
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 18 },
                  children: [
                    logoBlock(),
                    {
                      type: 'div',
                      props: {
                        style: { display: 'flex', flexDirection: 'column' },
                        children: [
                          { type: 'div', props: { style: { fontSize: 16, fontWeight: 400, letterSpacing: 3, color: GOLD }, children: 'FINEST MONITORS' } },
                          { type: 'div', props: { style: { fontSize: 36, fontWeight: 700, letterSpacing: -1, lineHeight: 1.05 }, children: `${region.label} Sell-Out Times` } },
                        ],
                      },
                    },
                  ],
                },
              },
              // Right: DROP +Nm
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' },
                  children: [
                    { type: 'div', props: { style: { fontSize: 14, letterSpacing: 3, color: GOLD }, children: 'DROP' } },
                    { type: 'div', props: { style: { fontSize: 38, fontWeight: 700, color: WHITE }, children: `+${delayStr}` } },
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
              padding: '30px 30px 20px',
              height: 500,
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
              marginTop: 2,
              marginBottom: 4,
            },
            children: [
              { type: 'div', props: { style: { flex: 1, height: 2, backgroundColor: GOLD, opacity: 0.6 } } },
              { type: 'div', props: { style: { fontSize: 16, fontWeight: 700, color: GOLD_DEEP, letterSpacing: 3 }, children: 'ALSO MOVED FAST' } },
              { type: 'div', props: { style: { flex: 1, height: 2, backgroundColor: GOLD, opacity: 0.6 } } },
            ],
          },
        },

        // List
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', flex: 1, padding: '2px 0' },
            children: listChildren,
          },
        },

        // Footer (BLACK with gold accents)
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              backgroundColor: BLACK,
              color: WHITE,
              padding: '16px 40px',
              alignItems: 'center',
              justifyContent: 'space-between',
              height: 90,
              boxSizing: 'border-box',
              borderTop: `4px solid ${GOLD}`,
            },
            children: [
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column' },
                  children: [
                    { type: 'div', props: { style: { fontSize: 13, letterSpacing: 3, color: GOLD }, children: 'WEEKLY SELL-OUT TRACKER' } },
                    { type: 'div', props: { style: { fontSize: 22, fontWeight: 700 }, children: dropDate } },
                  ],
                },
              },
              {
                type: 'div',
                props: {
                  style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' },
                  children: [
                    { type: 'div', props: { style: { fontSize: 13, letterSpacing: 3, color: GOLD }, children: 'SOLD OUT' } },
                    { type: 'div', props: { style: { fontSize: 22, fontWeight: 700, color: GOLD }, children: `${rows.length} / ${totalVariants} variants${remainderCount > 0 ? ` (+${remainderCount} more)` : ''}` } },
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
