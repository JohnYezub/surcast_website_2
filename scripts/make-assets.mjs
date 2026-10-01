// One-off generator for the static brand/social assets in public/.
// Run from the repo root:  node scripts/make-assets.mjs
// Outputs: public/favicon-48.png, public/apple-touch-icon.png, public/og-image.png
// (public/favicon.svg is hand-written and not generated here.)
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

const icon = 'public/assets/app-icon.png';
// The raw screenshots live in src/assets/ (processed by astro:assets at build time).
const shot = 'src/assets/forecast.png';

// --- favicons -------------------------------------------------------------
await sharp(icon).resize(48, 48).png().toFile('public/favicon-48.png');
// iOS draws the touch icon on an opaque square, so flatten onto the brand bg.
await sharp(icon)
  .resize(180, 180)
  .flatten({ background: '#0C1322' })
  .png()
  .toFile('public/apple-touch-icon.png');

// --- Open Graph card (1200×630) ------------------------------------------
const W = 1200;
const H = 630;
const BG = '#0C1322';

// Phone-screen crop on the right, rounded top corners, bleeding off the bottom.
const phoneW = 330;
const phoneH = Math.round((phoneW * 2868) / 1320); // keep the screenshot's aspect
const radius = 44;
const mask = Buffer.from(
  `<svg width="${phoneW}" height="${phoneH}"><rect width="${phoneW}" height="${phoneH}" rx="${radius}" fill="#fff"/></svg>`,
);
const phoneTop = 70;
const visibleH = H - phoneTop; // anything below the card edge is cropped away
const phone = await sharp(
  await sharp(shot)
    .resize(phoneW, phoneH)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer(),
)
  .extract({ left: 0, top: 0, width: phoneW, height: visibleH })
  .png()
  .toBuffer();

// Thin ring so the screenshot reads as a device against the dark background.
const ring = await sharp(
  Buffer.from(
    `<svg width="${phoneW + 12}" height="${phoneH + 12}"><rect x="1.5" y="1.5" width="${phoneW + 9}" height="${phoneH + 9}" rx="${radius + 6}" fill="none" stroke="#FF8C00" stroke-opacity=".85" stroke-width="3"/></svg>`,
  ),
)
  .extract({ left: 0, top: 0, width: phoneW + 12, height: visibleH + 6 })
  .png()
  .toBuffer();

const font = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const text = Buffer.from(`
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="g1" cx="85%" cy="-10%" r="70%">
      <stop offset="0" stop-color="#00C4FE" stop-opacity=".22"/>
      <stop offset="1" stop-color="#00C4FE" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g2" cx="5%" cy="15%" r="65%">
      <stop offset="0" stop-color="#0094E0" stop-opacity=".28"/>
      <stop offset="1" stop-color="#0094E0" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect width="${W}" height="${H}" fill="url(#g1)"/>
  <rect width="${W}" height="${H}" fill="url(#g2)"/>
  <text x="72" y="214" font-family="${font}" font-weight="700" font-size="72" fill="#fff" letter-spacing="-2">Read the ocean</text>
  <text x="72" y="294" font-family="${font}" font-weight="700" font-size="72" fill="#fff" letter-spacing="-2">before you</text>
  <text x="72" y="374" font-family="${font}" font-weight="700" font-size="72" fill="#00C4FE" letter-spacing="-2">paddle out.</text>
  <text x="72" y="444" font-family="${font}" font-size="28" fill="#8FA8C4">Surf forecast app: four wave models,</text>
  <text x="72" y="484" font-family="${font}" font-size="28" fill="#8FA8C4">tides and wind on one screen.</text>
  <text x="72" y="566" font-family="${font}" font-size="26" fill="#5C7088" letter-spacing="3">SURFCAST · iPHONE &amp; iPAD</text>
</svg>`);

// Round the app icon ourselves so the corners composite cleanly on the dark card.
const iconMask = Buffer.from(
  '<svg width="72" height="72"><rect width="72" height="72" rx="17" fill="#fff"/></svg>',
);
const brandIcon = await sharp(icon)
  .resize(72, 72)
  .composite([{ input: iconMask, blend: 'dest-in' }])
  .png()
  .toBuffer();
const phoneLeft = W - phoneW - 96;

await sharp(text)
  .composite([
    { input: brandIcon, left: 72, top: 64 },
    { input: ring, left: phoneLeft - 6, top: phoneTop - 6 },
    { input: phone, left: phoneLeft, top: phoneTop },
  ])
  .png({ compressionLevel: 9 })
  .toFile('public/og-image.png');

const meta = await sharp('public/og-image.png').metadata();
console.log('og-image', meta.width + 'x' + meta.height);
console.log('done');
