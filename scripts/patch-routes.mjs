import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const routesPath = join(process.cwd(), 'dist', '_routes.json');
let data;
try {
  data = JSON.parse(readFileSync(routesPath, 'utf-8'));
} catch (e) {
  console.log('[patch-routes] skip: dist/_routes.json not found', e.message);
  process.exit(0);
}

// Cloudflare Pages _routes.json 最多 100 条 exclude，默认每个静态文件一条会超限
// 将 95 条独立的 /.dict_json/out/*.json 合并为 1 条通配 `/.dict_json/*`
const before = data.exclude.length;
const filtered = data.exclude.filter((p) => !p.startsWith('/.dict_json/out/'));
if (!filtered.includes('/.dict_json/*')) filtered.push('/.dict_json/*');
// 确保其他静态长缓存资源也被排除（sitemap/robots 必须走静态，不进 Worker）
for (const p of ['/sitemap.xml', '/sitemap-full.xml', '/robots.txt']) {
  if (!filtered.includes(p)) filtered.push(p);
}
data.exclude = filtered;
// 按 Cloudflare 建议排序：更具体的在前，通配在后（不强制）
data.exclude.sort();

writeFileSync(routesPath, JSON.stringify(data, null, 2));
console.log(`[patch-routes] ${before} -> ${data.exclude.length} excludes:`, data.exclude);
