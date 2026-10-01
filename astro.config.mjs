import { defineConfig } from 'astro/config';

// `site` is the canonical origin (apex redirects to www); Astro uses it to build
// absolute URLs. Pages are emitted as `index.html`, `blog.html`, `terms.html`, …
// so the site keeps the same URLs it had as hand-written static HTML
// (no link rewriting needed).
export default defineConfig({
  site: 'https://www.surfcastapp.com',
  build: { format: 'file' },
});
