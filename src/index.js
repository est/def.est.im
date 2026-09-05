// def.est.im — Workers 单入口
// 静态（/ 首页、/style.css）由 [assets]（public/）提供；
// 其余 GET /<word> → SSR 词条页；POST / → fragment / gen 数据接口。
'use strict';
import { renderEntry, renderPlaceholder, renderIndex, shell, esc } from './lib/render.js';
import { loadEntry } from './lib/lookup.js';
import { generateEntry, validate, ingest } from './lib/gen.js';
import { probeAi } from './lib/probe.js';
import { tarpit } from './lib/abnormal.js';
import { checkAbnormal } from './lib/guard.js';
import { recordD1Failure, recordD1Success, shouldBlockSpaced, isCircuitOpen, isD1Error } from './lib/circuit.js';

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
          headers.set('cache-control', 'public, max-age=86400, s-maxage=86400');
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
        headers.set('cache-control', 'public, max-age=86400, s-maxage=86400');
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
          'cache-control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400',
          'cdn-cache-control': 'public, max-age=86400, stale-while-revalidate=86400',
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
      const chk = await checkAbnormal(request, env, w);
      if (chk.abnormal) return tarpit(request, env, chk.reason);
      if (w.length > 80 || w.split(/\s+/).length > 3 || /[^\w\s'\-.\u4e00-\u9fa5]/.test(w)) {
        return tarpit(request, env, 'illegal-word');
      }
      if (shouldBlockSpaced(w)) {
        await new Promise((r) => setTimeout(r, 4000));
        return new Response('', {
          status: 429,
          headers: { 'retry-after': '86400', 'cache-control': 'public, max-age=86400, s-maxage=86400', 'cdn-cache-control': 'public, max-age=86400', 'x-circuit-reason': 'spaced-query-circuit-open' },
        });
      }
      if (isCircuitOpen()) {
        await new Promise((r) => setTimeout(r, 4000));
        return new Response('', {
          status: 429,
          headers: { 'retry-after': '86400', 'cache-control': 'public, max-age=86400, s-maxage=86400', 'cdn-cache-control': 'public, max-age=86400', 'x-circuit-reason': 'circuit-open-post' },
        });
      }
      try {
        return await handlePost(request, env, w, ctx);
      } catch (e) {
        if (isD1Error(e)) {
          recordD1Failure();
          await new Promise((r) => setTimeout(r, 4000));
          return new Response('', {
            status: 429,
            headers: { 'retry-after': '86400', 'cache-control': 'public, max-age=86400, s-maxage=86400', 'cdn-cache-control': 'public, max-age=86400', 'x-d1-error': '1' },
          });
        }
        throw e;
      }
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
      const chk = await checkAbnormal(request, env, word);
      if (chk.abnormal) {
        const r = await tarpit(request, env, chk.reason);
        // 429 入 Cache API，避免重复 tarpit 5s 墙钟开销
        try {
          const ckAb = cacheKeyForWord(url.origin, '/' + encodeURIComponent(word.toLowerCase()));
          if (ctx?.waitUntil) ctx.waitUntil(cachePut(ckAb, r.clone()));
          else await cachePut(ckAb, r.clone());
        } catch {}
        return r;
      }

      // Cache API 前置（归一化 key：小写 + 剥离 query，防 ?v=1 / 大小写绕过）
      const ck = cacheKeyForWord(url.origin, '/' + encodeURIComponent(word.toLowerCase()));
      const hit = await cacheMatch(ck);
      if (hit) {
        const etag = hit.headers.get('etag');
        if (etag && request.headers.get('if-none-match') === etag) {
          return new Response(null, {
            status: 304,
            headers: {
              etag,
              'cache-control': hit.headers.get('cache-control') || 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400',
              'cdn-cache-control': hit.headers.get('cdn-cache-control') || 'public, max-age=86400, stale-while-revalidate=86400',
            },
          });
        }
        return hit;
      }

      // 熔断：反复 D1 出错后，带空格的查询一律 429（枚举短语攻击）— 置于 cache 之后，命中缓存直接返回
      if (shouldBlockSpaced(word)) {
        await new Promise((r) => setTimeout(r, 4000));
        const resp429 = new Response('', {
          status: 429,
          headers: {
            'retry-after': '86400',
            'cache-control': 'public, max-age=86400, s-maxage=86400',
            'cdn-cache-control': 'public, max-age=86400',
            'x-circuit-reason': 'spaced-query-circuit-open',
          },
        });
        if (ctx?.waitUntil) ctx.waitUntil(cachePut(ck, resp429.clone()));
        else await cachePut(ck, resp429.clone());
        return resp429;
      }

      // 重复查询击穿缓存后，熔断期内一律 429（阻断 D1 穿透）
      if (isCircuitOpen()) {
        await new Promise((r) => setTimeout(r, 4000));
        const resp429 = new Response('', {
          status: 429,
          headers: {
            'retry-after': '86400',
            'cache-control': 'public, max-age=86400, s-maxage=86400',
            'cdn-cache-control': 'public, max-age=86400',
            'x-circuit-reason': 'circuit-open-cache-miss',
          },
        });
        if (ctx?.waitUntil) ctx.waitUntil(cachePut(ck, resp429.clone()));
        else await cachePut(ck, resp429.clone());
        return resp429;
      }

      let resp;
      try {
        resp = await renderPage(env, word, url, request);
        recordD1Success();
      } catch (e) {
        if (isD1Error(e)) {
          recordD1Failure();
          await new Promise((r) => setTimeout(r, 4000));
          const resp429 = new Response('', {
            status: 429,
            headers: {
              'retry-after': '86400',
              'cache-control': 'public, max-age=86400, s-maxage=86400',
              'cdn-cache-control': 'public, max-age=86400',
              'x-d1-error': '1',
            },
          });
          if (ctx?.waitUntil) ctx.waitUntil(cachePut(ck, resp429.clone()));
          else await cachePut(ck, resp429.clone());
          return resp429;
        }
        throw e;
      }
      // 占位页（generating 且 no-store）不缓存，其余均缓存以阻断重复 D1（negative cache）
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
          'cache-control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400',
          'cdn-cache-control': 'public, max-age=86400, stale-while-revalidate=86400',
        },
      });
    }
    return new Response(shell(r.entry.lemma, html, word), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400',
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
  // negative cache：missing 词不再短 TTL 重复烧 D1
  // 带空格的短语枚举直接 404 长缓存，不触发生成；单词仍可生成但缓存 1h
  if (word.includes(' ')) {
    return new Response(shell(word, renderPlaceholder(word, true), word), {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=86400, s-maxage=86400, must-revalidate',
        'cdn-cache-control': 'public, max-age=86400, must-revalidate',
        'x-negative-cache': '1',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  return new Response(shell(word, renderPlaceholder(word, false), word, ` data-gen="${esc(word)}"`), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=86400, s-maxage=86400, must-revalidate',
      'cdn-cache-control': 'public, max-age=86400, must-revalidate',
      'x-negative-cache': '1',
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

  // 纯静态 sitemap（public/sitemap.xml，高频 TOP + 最新，export_d1.ts 生成）
  // 无 D1 回退：静态缺失直接 404，绝不读库（D1 rows_read 曾被 sitemap 回退打爆）
  // 简单限流防刷：sitemap 被高频刷时 429
  try {
    if (env.ABNORMAL_LIMITER?.limit) {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const { success } = await env.ABNORMAL_LIMITER.limit({ key: 'sitemap:' + ip });
      if (!success) {
        return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '86400', 'cache-control': 'public, max-age=86400, s-maxage=86400' } });
      }
    }
  } catch {}

  try {
    const assetReq = new Request(origin + '/sitemap.xml', request);
    const asset = await env.ASSETS.fetch(assetReq);
    if (asset.status === 200) {
      const headers = new Headers(asset.headers);
      headers.set('content-type', 'application/xml; charset=utf-8');
      headers.set('cache-control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400');
      headers.set('cdn-cache-control', 'public, max-age=86400, stale-while-revalidate=86400');
      headers.set('x-content-type-options', 'nosniff');
      const resp = new Response(asset.body, { status: 200, headers });
      if (ctx?.waitUntil) ctx.waitUntil(cachePut(ck, resp.clone()));
      else await cachePut(ck, resp.clone());
      return resp;
    }
  } catch {}
  return new Response('Not Found', { status: 404, headers: { 'cache-control': 'public, max-age=86400, s-maxage=86400' } });
}

// POST 分发：fragment / gen（w 已由调用方校验非空 + 异常校验）
async function handlePost(request, env, w, ctx) {
  const url = new URL(request.url);
  const isFragment = url.searchParams.get('fragment') === '1';
  const isGen = url.searchParams.get('gen') === '1';

  if (isGen) {
    try {
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
        try {
          const origin = new URL(request.url).origin;
          await caches.default.delete(cacheKeyForWord(origin, '/' + encodeURIComponent(low)));
          await caches.default.delete(cacheKeyForWord(origin, '/' + encodeURIComponent(w)));
          await caches.default.delete(cacheKeyForSitemap(origin));
        } catch {}
        return json({ ok: true, word: low });
      } catch (e) {
        if (isD1Error(e)) {
          recordD1Failure();
          await new Promise((r) => setTimeout(r, 4000));
          return new Response('', { status: 429, headers: { 'retry-after': '86400', 'cache-control': 'public, max-age=86400, s-maxage=86400', 'cdn-cache-control': 'public, max-age=86400', 'x-d1-error': '1' } });
        }
        return json({ ok: false, error: String(e).slice(0, 200) });
      }
    } catch (e) {
      if (isD1Error(e)) {
        recordD1Failure();
        await new Promise((r) => setTimeout(r, 4000));
        return new Response('', { status: 429, headers: { 'retry-after': '86400', 'cache-control': 'public, max-age=86400, s-maxage=86400', 'cdn-cache-control': 'public, max-age=86400', 'x-d1-error': '1' } });
      }
      throw e;
    }
  }

  if (isFragment) {
    try {
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
    } catch (e) {
      if (isD1Error(e)) {
        recordD1Failure();
        await new Promise((r) => setTimeout(r, 4000));
        return new Response('', { status: 429, headers: { 'retry-after': '86400', 'cache-control': 'public, max-age=86400, s-maxage=86400', 'cdn-cache-control': 'public, max-age=86400', 'x-d1-error': '1' } });
      }
      throw e;
    }
  }
  return json({ error: 'unknown action' }, 400);
}
