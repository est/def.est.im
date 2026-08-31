import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const src = join(process.cwd(), '.dict_json', 'out');
const dest = join(process.cwd(), 'public', '.dict_json', 'out');

if (!existsSync(src)) {
  console.log('[copy-dict] skip: .dict_json/out not found');
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-dict] copied ${src} -> ${dest}`);

// 同时生成完整 sitemap（8220 词）为静态文件，走边缘长缓存，不经过 Worker
// 生成两份：/sitemap.xml（主，robots.txt 指向）与 /sitemap-full.xml（别名）
try {
  const words = readdirSync(src).map((f) => f.replace(/\.json$/, ''));
  const urls = ['https://def.est.im/', ...words.map((w) => `https://def.est.im/${encodeURIComponent(w)}`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`).join('')}</urlset>`;
  for (const name of ['sitemap.xml', 'sitemap-full.xml']) {
    writeFileSync(join(process.cwd(), 'public', name), xml);
  }
  console.log(`[copy-dict] sitemap.xml + sitemap-full.xml with ${words.length} urls`);
} catch (e) {
  console.warn('[copy-dict] sitemap generation failed', e);
}
