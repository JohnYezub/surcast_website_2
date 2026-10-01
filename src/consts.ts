// Shared constants for the Surfcast site.
export const SITE_NAME = 'Surfcast';
export const SITE_URL = 'https://www.surfcastapp.com';

// Title as listed in the App Store (used as the MobileApplication name).
export const APP_STORE_TITLE = 'Surfcast – Waves, Wind & Tides';

// App Store rating shown on the homepage and in its JSON-LD. Update both numbers
// together from App Store Connect (last checked Oct 2026: 5.0 from 7 ratings).
export const APP_RATING = { value: 5, count: 7 };

export const APPSTORE_ID = '6760907145';
export const APPSTORE_URL =
  `https://apps.apple.com/id/app/surfcast-waves-wind-tides/id${APPSTORE_ID}`;

// Default social-share image (see scripts/make-assets.mjs), 1200×630.
export const OG_IMAGE = '/og-image.png';
export const OG_IMAGE_ALT =
  'Surfcast — surf forecast app comparing four wave models, tides and wind';
export const LOGO = '/assets/app-icon.png';

// Google Fonts stylesheet (loaded from <head>, not @import, so it doesn't block CSS).
export const FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap';
