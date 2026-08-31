export const prerender = false;

export async function GET() {
  // 轻量 sitemap：仅首页，避免将 8220 个词打进 Worker 包（>10MB 会超限）
  // 完整词表由构建期脚本生成静态 public/sitemap.xml（走边缘缓存，不经过 Worker）
  const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://def.est.im/</loc><changefreq>daily</changefreq><priority>1.0</priority></url></urlset>`;
  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
      'CDN-Cache-Control': 'public, max-age=86400, stale-while-revalidate=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
