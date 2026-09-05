'use strict';
// Guard client：把请求提炼为纯数据 signal，经 service binding 调 crest 判 abnormal。
// fail-open：binding 缺失或 RPC 抛错时放行（console.warn 留痕），保证业务可用性。

export function extractSignal(request, word) {
  const cf = request.cf || {};
  const bm = cf.botManagement || null;
  return {
    secFetchSite: request.headers.get('sec-fetch-site') || '',
    referer: request.headers.get('referer') || '',
    ua: request.headers.get('user-agent') || '',
    secChUaPlatform: request.headers.get('sec-ch-ua-platform') || '',
    cacheControl: request.headers.get('cache-control') || '',
    pragma: request.headers.get('pragma') || '',
    verifiedBotCategory: cf.verifiedBotCategory || '',
    botManagement: bm
      ? { verifiedBot: !!bm.verifiedBot, score: typeof bm.score === 'number' ? bm.score : undefined }
      : null,
    sameSiteOrigin: new URL(request.url).origin + '/',
    word: word || '',
  };
}

export async function checkAbnormal(request, env, word) {
  try {
    if (!env.GUARD || typeof env.GUARD.check !== 'function') {
      console.warn('[guard] binding missing, fail-open');
      return { abnormal: false };
    }
    const verdict = await env.GUARD.check(extractSignal(request, word));
    if (verdict && verdict.abnormal) return { abnormal: true, reason: verdict.reason || 'guard' };
    return { abnormal: false };
  } catch (e) {
    console.warn('[guard] rpc failed, fail-open', e?.message || e);
    return { abnormal: false };
  }
}
