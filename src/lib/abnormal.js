'use strict';
// 统一异常请求判定 + 429 tarpit 中间件
// 免费可用：verifiedBotCategory / Sec-Fetch-* / UA / 词形校验 / Rate Limiting binding

export function isAbnormal(request, word) {
  const secFetchSite = (request.headers.get('sec-fetch-site') || '').toLowerCase();
  const referer = request.headers.get('referer') || request.headers.get('Referer') || '';
  const ua = request.headers.get('user-agent') || '';
  const verified = request.cf?.verifiedBotCategory || '';

  // 1. Sec-Fetch 伪造：none 却带同站 referer（真实同站应为 same-origin）
  if (secFetchSite === 'none' && referer.startsWith('https://def.est.im/')) {
    return { abnormal: true, reason: 'sec-fetch-site-none-with-referer' };
  }
  // 2. 已验证 AI 爬虫（Free 可用）—— 暂时注释，按需求保留放行
  // if (verified && verified.includes('AI')) {
  //   return { abnormal: true, reason: `verified-ai:${verified}` };
  // }
  // 3. 非法/超长词（枚举攻击）
  if (word && (word.length > 80 || word.split(/\s+/).length > 3 || /[^\w\s'\-.\u4e00-\u9fa5]/.test(word))) {
    return { abnormal: true, reason: 'illegal-word' };
  }
  // 4. 未验证但 UA 含已知 AI 爬虫（兜底）—— 暂时注释
  // if (/GPTBot|OAI-SearchBot|ClaudeBot|PerplexityBot|Bytespider|Applebot-Extended|CCBot|cohere-ai|SemrushBot|DotBot/i.test(ua)) {
  //   if (!verified || !verified.includes('Search Engine')) {
  //     return { abnormal: true, reason: `ua-ai:${ua.slice(0,40)}` };
  //   }
  // }
  return { abnormal: false };
}

// 429 tarpit：限流 + 延迟后返回 429
// 注意：Workers 墙钟上限 30s，60s 延迟会超时，这里用 5s 延迟 + Retry-After:60 卡死客户端
export async function tarpit(request, env, reason) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
  // 优先用 Rate Limiting 绑定（需 wrangler.toml 配置），降级到无状态
  try {
    if (env.ABNORMAL_LIMITER?.limit) {
      const { success } = await env.ABNORMAL_LIMITER.limit({ key: ip });
      if (!success) {
        await new Promise((r) => setTimeout(r, 5000));
        return new Response('Too Many Requests - rate limited', {
          status: 429,
          headers: {
            'retry-after': '60',
            'cache-control': 'no-store',
            'x-bot-reason': reason,
          },
        });
      }
    }
  } catch (_) {}
  // 异常请求统一延迟 5s 后 429（卡死爬虫，浏览器用户几乎不触发）
  await new Promise((r) => setTimeout(r, 5000));
  return new Response('Blocked abnormal request', {
    status: 429,
    headers: {
      'retry-after': '60',
      'cache-control': 'no-store',
      'x-bot-reason': reason,
    },
  });
}
