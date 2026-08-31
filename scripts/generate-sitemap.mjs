import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const wordsPath = join(process.cwd(), 'src', 'data', 'words.json');
const outPaths = [join(process.cwd(), 'public', 'sitemap.xml'), join(process.cwd(), 'public', 'sitemap-full.xml')];

try {
  const words = JSON.parse(readFileSync(wordsPath, 'utf-8'));
  const urls = ['https://def.est.im/', ...words.map((w) => `https://def.est.im/${encodeURIComponent(w)}`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`).join('')}</urlset>`;
  for (const p of outPaths) writeFileSync(p, xml);
  console.log(`[sitemap] ${words.length} urls -> sitemap.xml + sitemap-full.xml`);
} catch (e) {
  console.warn('[sitemap] failed', e.message);
}
