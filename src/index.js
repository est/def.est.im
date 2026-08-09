// def.est.im — Workers 单入口
// 静态（/ 首页、/style.css）由 [assets]（public/）提供；
// 其余 GET /<word> → SSR 词条页；POST / → fragment / gen 数据接口。
'use strict';
import { renderEntry, renderPlaceholder, shell } from './lib/render.js';
import { loadEntry } from './lib/lookup.js';
import { generateEntry, validate, ingest } from './lib/gen.js';

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 静态资源全权分发（run_worker_first=true）：
    // 首页/资源文件（浏览器带 Sec-Fetch-Dest，curl 靠后缀兜底）→ assets
    const dest = (request.headers.get('Sec-Fetch-Dest') || '').toLowerCase();
    const isAsset = /^(style|script|image|font|audio|video|xslt|track|manifest)$/.test(dest)
      || /\.(css|js|mjs|json|png|svg|ico|jpg|jpeg|gif|webp|woff2?|txt|xml)$/.test(path);
    if (request.method === 'GET' && (path === '/' || path === '/index.html' || isAsset)) {
      const r = await env.ASSETS.fetch(request);
      if (r.status !== 404) return r;
    }

    // POST / ：fragment / gen
    if (request.method === 'POST' && path === '/') {
      const w = (url.searchParams.get('w') || '').trim();
      if (!w) return json({ error: 'no word' }, 400);
      return handlePost(request, env, w);
    }

    // GET /<word>：SSR 词条页
    if (request.method === 'GET' && path !== '/') {
      let word;
      try { word = decodeURIComponent(path.slice(1)); } catch { return new Response('Bad Request', { status: 400 }); }
      word = word.trim();
      if (!word) return new Response('Not Found', { status: 404 });
      return renderPage(env, word);
    }

    return new Response('Not Found', { status: 404 });
  },
};

// ---- 词条页渲染（命中 / 占位 / 404） ----
async function renderPage(env, word) {
  const r = await loadEntry(env, word);
  if (r.type === 'entry') {
    const html = renderEntry({ ...r.entry, senses: r.senses, groups: r.groups, discoverable: r.discoverable }, word);
    return new Response(shell(r.entry.lemma, html, word), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    });
  }
  if (r.type === 'rejected') {
    return new Response(shell(word, renderPlaceholder(word, true), word), {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  // missing → 占位页，自动触发生成（body data-gen）
  return new Response(
    shell(word, renderPlaceholder(word, false), word, `data-gen="${word.replace(/"/g, '&quot;')}"`),
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

// POST 分发：fragment / gen（w 已由调用方校验非空）
async function handlePost(request, env, w) {
  const url = new URL(request.url);
  const isFragment = url.searchParams.get('fragment') === '1';
  const isGen = url.searchParams.get('gen') === '1';

  if (isGen) {
    const low = w.toLowerCase();
    const exist = await env.def_dict.prepare('SELECT 1 FROM words WHERE lemma = ?').bind(low).first();
    if (exist) return json({ ok: true, word: low });
    try {
      const data = await generateEntry(env, w);
      validate(data, w);
      await ingest(env, data);
      return json({ ok: true, word: low });
    } catch (e) {
      console.error('[gen]', w, String(e));
      return json({ ok: false, error: String(e).slice(0, 200) });
    }
  }

  if (isFragment) {
    const r = await loadEntry(env, w);
    let html, status = 200;
    if (r.type === 'entry') {
      html = renderEntry({ ...r.entry, senses: r.senses, groups: r.groups, discoverable: r.discoverable }, w);
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