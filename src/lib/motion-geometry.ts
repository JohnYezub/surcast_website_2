// Build-time geometry for the landing-page motion ("swell trains").
// Everything here runs in component frontmatter during `astro build`; the
// output is plain SVG path data, so no geometry code ships to the browser.
// A fixed seed keeps the markup deterministic between builds.

const SEED = 20261011;

/** mulberry32 PRNG → floats in [0, 1). */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;
const r1 = (n: number) => Math.round(n * 10) / 10;
const polyline = (pts: [number, number][]) =>
  pts.map(([x, y], i) => `${i ? 'L' : 'M'}${r1(x)} ${r1(y)}`).join('');

/* ---------- 1 · Hero swell trains ---------- */

export interface SwellLine { d: string; color: string; opacity: number; width: number; delay: string }

// y0, wavelength, amplitude, opacity, stroke width, colour
const TRAINS: [number, number, number, number, number, string][] = [
  [250, 640, 26, 0.2, 1.5, 'var(--accent-2)'],
  [380, 384, 14, 0.16, 1.2, 'var(--accent-2)'],
  [460, 480, 18, 0.4, 1.4, 'var(--m-mfwam)'],
  [540, 960, 34, 0.14, 1.6, 'var(--accent-2)'],
  [640, 320, 10, 0.1, 1.1, 'var(--accent-2)'],
];

/** Two stacked layers (A = trains 1, 4; B = trains 2, 3, 5), each 3840px wide = two 1920px tiles. */
export function heroSwell(): { a: SwellLine[]; b: SwellLine[] } {
  const rnd = mulberry32(SEED);
  const lines = TRAINS.map(([y0, lambda, amp, opacity, width, color], i) => {
    const phi = rnd() * TAU;
    const phi2 = rnd() * TAU;
    const y = (x: number) =>
      y0 + amp * (0.75 + 0.25 * Math.sin((TAU * x) / 1920 + phi2)) * Math.sin((TAU * x) / lambda + phi);
    // Relative segments, deltas taken between rounded absolutes so nothing drifts.
    let prev = r1(y(0));
    let d = `M0 ${prev}l`;
    const segs: string[] = [];
    for (let x = 16; x <= 3840; x += 16) {
      const cur = r1(y(x));
      segs.push(`16 ${r1(cur - prev)}`);
      prev = cur;
    }
    d += segs.join(' ');
    return { d, color, opacity, width, delay: `${(i * 0.12).toFixed(2)}s` };
  });
  return { a: [lines[0], lines[3]], b: [lines[1], lines[2], lines[4]] };
}

/* ---------- 2 · Feature-row motifs (560×560 box) ---------- */

const CX = 280;
const CY = 290;
const ringNoise = (t: number) => 0.11 * Math.sin(2 * t) + 0.06 * Math.sin(3 * t) + 0.035 * Math.sin(5 * t);

export interface Ring { d: string; opacity: number; delay: string }
export interface Pin { x: number; y: number; ember: boolean; delay: string }

/** Spots map: offset "bathymetry" contours plus pins dropped along ring 210. */
export function mapMotif(): { rings: Ring[]; pins: Pin[] } {
  const rnd = mulberry32(SEED + 1);
  const phase = rnd() * TAU;
  const at = (r: number, deg: number): [number, number] => {
    const t = (deg * Math.PI) / 180;
    const rr = r * (1 + ringNoise(t + phase));
    return [CX + rr * Math.cos(t), CY + rr * Math.sin(t)];
  };
  const rings = [150, 180, 210, 240].map((r, i) => {
    const pts: [number, number][] = [];
    for (let deg = 0; deg < 360; deg += 5) pts.push(at(r, deg));
    return { d: `${polyline(pts)}Z`, opacity: [0.4, 0.3, 0.22, 0.14][i], delay: `${(0.1 + i * 0.18).toFixed(2)}s` };
  });
  // Right side four, left side three; the third one is the ember pin.
  const angles = [-34, -12, 10, 32, 206, 180, 156];
  const pins = angles.map((deg, i) => {
    const [x, y] = at(210, deg);
    return { x: r1(x), y: r1(y), ember: i === 2, delay: `${(0.75 + i * 0.09).toFixed(2)}s` };
  });
  return { rings, pins };
}

export interface Arrow { x: number; y: number; r0: string; delay: string }

/** Forecast: 48 wind arrows (3 columns each side) and a tide sine behind the phone. */
export function forecastMotif(): { tide: string; arrows: Arrow[] } {
  const rnd = mulberry32(SEED + 2);
  const pts: [number, number][] = [];
  for (let x = 0; x <= 560; x += 14) pts.push([x, 300 + 50 * Math.sin((TAU * x) / 364 + 1)]);
  const arrows: Arrow[] = [];
  for (const x of [26, 72, 118, 442, 488, 534]) {
    for (let row = 0; row < 8; row++) {
      arrows.push({
        x,
        y: 50 + row * 66,
        r0: `${Math.round(rnd() * 360 - 180)}deg`,
        delay: `${(0.2 + rnd() * 0.4).toFixed(2)}s`,
      });
    }
  }
  return { tide: polyline(pts), arrows };
}

/** Widget: a semidiurnal tide (two unequal highs) across the box; it tiles at 0/560. */
export function widgetTide(): string {
  const pts: [number, number][] = [];
  for (let x = 0; x <= 560; x += 10) {
    pts.push([x, 290 - 80 * Math.cos((TAU * (x - 122)) / 280) - 17.5 * Math.cos((TAU * (x - 122)) / 560)]);
  }
  return polyline(pts);
}

/* ---------- 5 · Closing CTA: four swell lines that settle into one ---------- */

export function ctaSwell(): { d: string; ty: string; opacity: number }[] {
  const set: [number, number, number, number][] = [
    [300, 40, -50, 0.3],
    [240, 30, -18, 0.22],
    [400, 46, 22, 0.26],
    [200, 22, 52, 0.18],
  ];
  return set.map(([lambda, amp, ty, opacity]) => {
    const pts: [number, number][] = [];
    for (let x = 0; x <= 1200; x += 12) pts.push([x, 120 + amp * Math.sin((TAU * x) / lambda)]);
    return { d: polyline(pts), ty: `${ty}px`, opacity };
  });
}
