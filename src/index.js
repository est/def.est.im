// def.est.im — Workers 单入口
// 静态（/ 首页、/style.css）由 [assets]（public/）提供；
// 其余 GET /<word> → SSR 词条页；POST / → fragment / gen 数据接口。
'use strict';
import { renderEntry, renderPlaceholder, renderIndex, shell, esc } from './lib/render.js';
import { loadEntry } from './lib/lookup.js';
import { generateEntry, validate, ingest } from './lib/gen.js';
import { probeAi } from './lib/probe.js';
import { isAbnormal, tarpit } from './lib/abnormal.js';

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

function cacheKeyForWord(origin, path) {
  return new Request(origin + path, { method: 'GET' });
}
function cacheKeyForSitemap(origin) {
  return new Request(origin + '/sitemap.xml', { method: 'GET' });
}

async function cacheMatch(request) {
  try { return await caches.default.match(request); } catch { return null; }
}
async function cachePut(request, response) {
  try { await caches.default.put(request, response); } catch {}
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 静态资源（CSS/JS/图片）→ assets；首页由 worker 渲染
    const dest = (request.headers.get('Sec-Fetch-Dest') || '').toLowerCase();
    const isAsset = /^(style|script|image|font|audio|video|xslt|track|manifest)$/.test(dest)
       || /\.(css|js|mjs|json|png|svg|ico|jpg|jpeg|gif|webp|woff2?|txt|xml)$/.test(path);
    // sitemap 走专用处理，不走这里的静态直通（避免 path.endsWith xml 误判）
    if (request.method === 'GET' && isAsset && path !== '/sitemap.xml' && !path.startsWith('/sitemaps/')) {
      const r = await env.ASSETS.fetch(request);
      if (r.status !== 404) {
        const headers = new Headers(r.headers);
        if (/\.(css|js|mjs)$/.test(path)) {
          headers.set('cache-control', 'public, max-age=86400, s-maxage=31536000, immutable');
          headers.set('cdn-cache-control', 'public, max-age=31536000, immutable');
        } else if (/\.(png|svg|ico|jpg|jpeg|gif|webp|woff2?)$/.test(path)) {
          headers.set('cache-control', 'public, max-age=86400, s-maxage=2592000, immutable');
          headers.set('cdn-cache-control', 'public, max-age=2592000, immutable');
        } else {
          headers.set('cache-control', 'public, max-age=3600, s-maxage=86400');
          headers.set('cdn-cache-control', 'public, max-age=86400');
        }
        headers.set('x-content-type-options', 'nosniff');
        return new Response(r.body, { status: r.status, headers });
      }
    }

    // GET /robots.txt：静态（public/）兜底 + 长缓存
    if (request.method === 'GET' && path === '/robots.txt') {
      const r = await env.ASSETS.fetch(request);
      if (r.status !== 404) {
        const headers = new Headers(r.headers);
        headers.set('cache-control', 'public, max-age=3600, s-maxage=86400');
        headers.set('cdn-cache-control', 'public, max-age=86400');
        headers.set('x-content-type-options', 'nosniff');
        return new Response(r.body, { status: r.status, headers });
      }
    }

    // GET /sitemap.xml / /sitemaps/*.xml：词典 sitemap（Cache API + 静态兜底）
    if (request.method === 'GET' && (path === '/sitemap.xml' || path.startsWith('/sitemaps/'))) {
      return handleSitemap(request, env, ctx);
    }

    // GET /：首页（短缓存，可被 Cache API 加速）
    if (request.method === 'GET' && path === '/') {
      const ck = cacheKeyForWord(url.origin, '/');
      const hit = await cacheMatch(ck);
      if (hit) return hit;
      const resp = new Response(shell('', renderIndex(), null), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400',
          'cdn-cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
          'x-content-type-options': 'nosniff',
        },
      });
      if (ctx?.waitUntil) ctx.waitUntil(cachePut(ck, resp.clone()));
      else await cachePut(ck, resp.clone());
      return resp;
    }

    // POST / ：fragment / gen（先过异常/非法校验，不进 D1）
    if (request.method === 'POST' && path === '/') {
      const w = (url.searchParams.get('w') || '').trim();
      if (!w) return json({ error: 'no word' }, 400);
      const chk = isAbnormal(request, w);
      if (chk.abnormal) return tarpit(request, env, chk.reason);
      if (w.length > 80 || w.split(/\s+/).length > 3 || /[^\w\s'\-.\u4e00-\u9fa5]/.test(w)) {
        return tarpit(request, env, 'illegal-word');
      }
      return handlePost(request, env, w, ctx);
    }

    // GET /_ai/probe：AI 存活探测（Q:PING? → A:___）
    if (request.method === 'GET' && path === '/_ai/probe') {
      const r = await probeAi(env);
      const resp = json(r, r.ok ? 200 : 503);
      resp.headers.set('cache-control', 'no-store');
      return resp;
    }

    // GET /<word>：SSR 词条页（Cache API 前置，未命中再 D1）
    if (request.method === 'GET' && path !== '/') {
      let word;
      try { word = decodeURIComponent(path.slice(1)); } catch { return new Response('Bad Request', { status: 400 }); }
      word = word.trim();
      if (!word) return new Response('Not Found', { status: 404 });
      const chk = isAbnormal(request, word);
      if (chk.abnormal) return tarpit(request, env, chk.reason);

      // Cache API 前置（归一化 key：剥离 query，防 ?v=1 绕过）
      const ck = cacheKeyForWord(url.origin, '/' + encodeURIComponent(word));
      const hit = await cacheMatch(ck);
      if (hit) {
        const etag = hit.headers.get('etag');
        if (etag && request.headers.get('if-none-match') === etag) {
          return new Response(null, {
            status: 304,
            headers: {
              etag,
              'cache-control': hit.headers.get('cache-control') || 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
              'cdn-cache-control': hit.headers.get('cdn-cache-control') || 'public, max-age=86400, stale-while-revalidate=86400',
            },
          });
        }
        return hit;
      }

      const resp = await renderPage(env, word, url, request);
      // 占位页（generating 且 no-store）不缓存，其余均缓存以阻断重复 D1
      const cc = resp.headers.get('cache-control') || '';
      if (!cc.includes('no-store')) {
        const toCache = resp.clone();
        if (ctx?.waitUntil) ctx.waitUntil(cachePut(ck, toCache));
        else await cachePut(ck, toCache);
      }
      return resp;
    }

    return new Response('Not Found', { status: 404 });
  },
};

// 词条页 ETag：基于 entry 关键字段内容哈希（lemma/cefr/freq/音标/notes/词源 + senses 摘要）
function entryEtag(entry, senses) {
  const core = [
    entry.lemma, entry.entity_type, entry.cefr, entry.freq,
    entry.phonetic_uk, entry.phonetic_us, entry.other_notes, entry.etymology,
    senses.map((s) => [s.sense_no, s.pos, s.pattern, s.def_en, s.register, s.usage_notes, s.example_en]).join('|'),
  ].join('§');
  let h = 0x811c9dc5;
  for (let i = 0; i < core.length; i++) { h ^= core.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return '"' + (h >>> 0).toString(16) + '"';
}

// ---- 词条页渲染（命中 / 占位 / 404） ----
async function renderPage(env, word, reqUrl, request) {
  // Sec-Fetch-Site 校验：真实同站点击应为 same-origin/same-site，none 却带 referer 为伪造
  const secFetchSite = request.headers.get('sec-fetch-site') || '';
  const referer = request.headers.get('referer') || request.headers.get('Referer') || '';
  if (secFetchSite.toLowerCase() === 'none' && referer && referer.startsWith('https://def.est.im/')) {
    return new Response(shell(word, renderPlaceholder(word, true), word), {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=86400, s-maxage=86400, must-revalidate',
        'cdn-cache-control': 'public, max-age=86400, must-revalidate',
        'x-bot-reason': 'sec-fetch-site-none-with-referer',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  // 非法/超长词直接 404 长缓存（拦截枚举攻击，命中 Cache API 不再进 D1）
  if (word.length > 80 || word.split(/\s+/).length > 3 || /[^\w\s'\-.\u4e00-\u9fa5]/.test(word)) {
    return new Response(shell(word, renderPlaceholder(word, true), word), {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=86400, s-maxage=86400, must-revalidate',
        'cdn-cache-control': 'public, max-age=86400, must-revalidate',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  const r = await loadEntry(env, word);
  if (r.type === 'entry') {
    if (r.entry.entity_type === -1) {
      return new Response(shell(word, renderPlaceholder(word, false), word, null), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      });
    }
    const html = renderEntry({ ...r.entry, senses: r.senses, groups: r.groups, discoverable: r.discoverable, phraseLinked: r.phraseLinked, inflectLinked: r.inflectLinked }, word);
    const etag = entryEtag(r.entry, r.senses);
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          etag,
          'cache-control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
          'cdn-cache-control': 'public, max-age=86400, stale-while-revalidate=86400',
        },
      });
    }
    return new Response(shell(r.entry.lemma, html, word), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
        'cdn-cache-control': 'public, max-age=86400, stale-while-revalidate=86400',
        etag,
        'x-content-type-options': 'nosniff',
        vary: 'Accept-Encoding',
      },
    });
  }
  if (r.type === 'redirect') {
    const frag = '#:~:text=' + encodeURIComponent(r.highlight);
    const url = new URL('/' + encodeURIComponent(r.lemma), reqUrl);
    url.hash = frag.slice(1);
    return new Response(null, {
      status: 302,
      headers: {
        location: url.toString(),
        'cache-control': 'public, max-age=86400, s-maxage=86400, must-revalidate',
        'cdn-cache-control': 'public, max-age=86400, must-revalidate',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  if (r.type === 'rejected') {
    return new Response(shell(word, renderPlaceholder(word, true), word), {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=86400, s-maxage=86400, must-revalidate',
        'cdn-cache-control': 'public, max-age=86400, must-revalidate',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  return new Response(shell(word, renderPlaceholder(word, false), word, ` data-gen="${esc(word)}"`), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60, s-maxage=300, must-revalidate',
      'cdn-cache-control': 'public, max-age=300, must-revalidate',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function handleSitemap(request, env, ctx) {
  const url = new URL(request.url);
  const origin = url.origin;
  const ck = cacheKeyForSitemap(origin);
  const hit = await cacheMatch(ck);
  if (hit) return hit;

  // 词典型 sitemap：优先静态资产（public/sitemap*.xml），零 D1
  // 静态文件由 export_d1.ts 生成并随 wrangler deploy 发布；Worker 仅作回退
  try {
    const assetReq = new Request(origin + '/sitemap.xml', request);
    const asset = await env.ASSETS.fetch(assetReq);
    if (asset.status === 200) {
      const headers = new Headers(asset.headers);
      headers.set('content-type', 'application/xml; charset=utf-8');
      headers.set('cache-control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400');
      headers.set('cdn-cache-control', 'public, max-age=86400, stale-while-revalidate=86400');
      headers.set('x-content-type-options', 'nosniff');
      const resp = new Response(asset.body, { status: 200, headers });
      if (ctx?.waitUntil) ctx.waitUntil(cachePut(ck, resp.clone()));
      else await cachePut(ck, resp.clone());
      return resp;
    }
  } catch {}

  // 回退：D1 动态生成（仅首 miss 触发，配合索引与限流）
  // 简单限流防刷：sitemap 被高频刷时 429
  try {
    if (env.ABNORMAL_LIMITER?.limit) {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const { success } = await env.ABNORMAL_LIMITER.limit({ key: 'sitemap:' + ip });
      if (!success) {
        return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '60', 'cache-control': 'public, max-age=60, s-maxage=60' } });
      }
    }
  } catch {}

  try {
    // 分层优先级：CEFR 越基础、freq 越高越靠前；高频词优先被爬虫发现
    const q = await env.def_dict.prepare(
      `SELECT lemma, cefr, freq FROM words WHERE entity_type = 0 ORDER BY
        CASE cefr WHEN 'A1' THEN 0 WHEN 'A2' THEN 1 WHEN 'B1' THEN 2 WHEN 'B2' THEN 3 WHEN 'C1' THEN 4 WHEN 'C2' THEN 5 ELSE 6 END,
        freq DESC, lemma ASC LIMIT 50000`
    ).all();
    const rows = q.results || [];
    const urls = ['https://def.est.im/'];
    let xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
    xml += `<url><loc>https://def.est.im/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`;
    for (const r of rows) {
      const pri = r.cefr === 'A1' || r.cefr === 'A2' ? '0.9' : r.cefr === 'B1' || r.cefr === 'B2' ? '0.7' : '0.5';
      xml += `<url><loc>https://def.est.im/${encodeURIComponent(r.lemma)}</loc><changefreq>monthly</changefreq><priority>${pri}</priority></url>`;
    }
    xml += `</urlset>`;
    const resp = new Response(xml, {
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'cache-control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
        'cdn-cache-control': 'public, max-age=86400, stale-while-revalidate=86400',
        'x-content-type-options': 'nosniff',
      },
    });
    if (ctx?.waitUntil) ctx.waitUntil(cachePut(ck, resp.clone()));
    else await cachePut(ck, resp.clone());
    return resp;
  } catch (e) {
    return new Response('Sitemap error', { status: 500, headers: { 'cache-control': 'no-store' } });
  }
}

// POST 分发：fragment / gen（w 已由调用方校验非空 + 异常校验）
async function handlePost(request, env, w, ctx) {
  const url = new URL(request.url);
  const isFragment = url.searchParams.get('fragment') === '1';
  const isGen = url.searchParams.get('gen') === '1';

  if (isGen) {
    const low = w.toLowerCase();
    const now = Date.now();
    const row = await env.def_dict.prepare(
      'SELECT word_id, entity_type, other_notes FROM words WHERE lemma = ? LIMIT 1'
    ).bind(low).first();
    if (row && (row.entity_type ?? 0) >= 0) return json({ ok: true, word: low });
    if (row && row.entity_type === -1) {
      const start = parseInt(row.other_notes || '', 10) || 0;
      if (now - start < 5 * 60 * 1000) return json({ ok: false, generating: true, word: low });
      await env.def_dict.prepare('UPDATE words SET other_notes = ? WHERE word_id = ?').bind(String(now), row.word_id).run();
    } else {
      await env.def_dict.prepare(
        'INSERT INTO words (lemma, entity_type, other_notes) VALUES (?, -1, ?)'
      ).bind(low, String(now)).run();
    }
    try {
      const data = await generateEntry(env, w);
      validate(data, w);
      await ingest(env, data);
      // 成功后清对应词条与 sitemap 的 Cache API（下次 GET 走新数据）
      try {
        const origin = new URL(request.url).origin;
        await caches.default.delete(cacheKeyForWord(origin, '/' + encodeURIComponent(low)));
        await caches.default.delete(cacheKeyForWord(origin, '/' + encodeURIComponent(w)));
        await caches.default.delete(cacheKeyForSitemap(origin));
      } catch {}
      return json({ ok: true, word: low });
    } catch (e) {
      console.error('[gen]', w, String(e));
      return json({ ok: false, error: String(e).slice(0, 200) });
    }
  }

  if (isFragment) {
    const r = await loadEntry(env, w);
    if (r.type === 'redirect') {
      const frag = '#:~:text=' + encodeURIComponent(r.highlight);
      return json({ redirect: '/' + encodeURIComponent(r.lemma) + frag });
    }
    let html, status = 200;
    if (r.type === 'entry') {
      html = renderEntry({ ...r.entry, senses: r.senses, groups: r.groups, discoverable: r.discoverable, phraseLinked: r.phraseLinked, inflectLinked: r.inflectLinked }, w);
    } else if (r.type === 'rejected') {
      html = renderPlaceholder(w, true);
      status = 404;
    } else {
      html = renderPlaceholder(w, false);
    }
    return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
  return json({ error: 'unknown action' }, 400);
}
