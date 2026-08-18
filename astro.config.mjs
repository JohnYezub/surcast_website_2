import { defineConfig } from 'astro/config';

// Emit pages as `index.html`, `blog.html`, `terms.html`, … so the site keeps
// the same URLs it had as hand-written static HTML (no link rewriting needed).
export default defineConfig({
  build: { format: 'file' },
});
