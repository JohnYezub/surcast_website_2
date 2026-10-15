import { defineConfig } from 'astro/config';

// Mirrors the /charts-data rewrite in vercel.json for `astro dev` and `astro preview`
// (the chart backend sends no CORS headers; see src/consts.ts).
const chartsProxy = {
  '/charts-data': {
    target: 'https://charts.surfcastapp.com',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/charts-data/, ''),
  },
};

// `site` is the canonical origin (apex redirects to www); Astro uses it to build
// absolute URLs. Pages are emitted as `index.html`, `blog.html`, `terms.html`, …
// so the site keeps the same URLs it had as hand-written static HTML
// (no link rewriting needed).
export default defineConfig({
  site: 'https://www.surfcastapp.com',
  build: { format: 'file' },
  vite: {
    server: { proxy: chartsProxy },
    preview: { proxy: chartsProxy },
    build: {
      // Explicit CSS targets: without them Lightning CSS folds animation-timeline
      // into the `animation` shorthand, which Chrome rejects, so the
      // scroll-driven motion on the landing page would silently drop.
      cssTarget: ['chrome111', 'edge111', 'firefox114', 'safari16.4'],
    },
  },
});
