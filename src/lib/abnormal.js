'use strict';
// 统一异常请求判定 + 429 tarpit 中间件
// 免费可用：verifiedBotCategory / botManagement / Sec-Fetch-* / UA / 词形校验 / Rate Limiting binding

const AI_UA_RE = /GPTBot|OAI-SearchBot|ClaudeBot|PerplexityBot|Bytespider|Applebot-Extended|CCBot|cohere-ai|SemrushBot|DotBot|Amazonbot|Applebot/i;

export function isAbnormal(request, word) {
  const secFetchSite = (request.headers.get('sec-fetch-site') || '').toLowerCase();
  const referer = request.headers.get('referer') || request.headers.get('Referer') || '';
  const ua = request.headers.get('user-agent') || '';
  const verified = request.cf?.verifiedBotCategory || '';
  const bm = request.cf?.botManagement;

  // 1. Sec-Fetch 伪造：none 却带同站 referer（真实同站应为 same-origin）
  if (secFetchSite === 'none' && referer.startsWith('https://def.est.im/')) {
    return { abnormal: true, reason: 'sec-fetch-site-none-with-referer' };
  }
  // 2. Cloudflare 托管验证机器人（verifiedBot）—— AI/未分类爬虫直接拦截
  if (bm?.verifiedBot) {
    // 放行可信搜索引擎，其余验证机器人视为异常
    if (!verified.includes('Search Engine')) {
      return { abnormal: true, reason: `verified-bot:${verified || 'unknown'}` };
    }
  }
  if (verified && verified.includes('AI Crawler')) {
    return { abnormal: true, reason: `verified-ai:${verified}` };
  }
  // 3. botManagement 分数低（0-99，<30 高确信为 bot）
  if (bm && typeof bm.score === 'number' && bm.score < 30) {
    return { abnormal: true, reason: `bot-score:${bm.score}` };
  }
  // 4. 非法/超长词（枚举攻击）
  if (word && (word.length > 80 || word.split(/\s+/).length > 3 || /[^\w\s'\-.\u4e00-\u9fa5]/.test(word))) {
    return { abnormal: true, reason: 'illegal-word' };
  }
  // 5. 未验证但 UA 含已知 AI 爬虫（兜底）
  if (AI_UA_RE.test(ua)) {
    if (!verified || !verified.includes('Search Engine')) {
      return { abnormal: true, reason: `ua-ai:${ua.slice(0,40)}` };
    }
  }
  // 6. UA 矛盾：声称 Macintosh 但 Client Hints 平台不是 macOS（伪造 UA）
  if (ua.includes('Macintosh')) {
    const raw = request.headers.get('sec-ch-ua-platform');
    const platform = (raw || '').replace(/"/g, '').trim().toLowerCase();
    if (platform !== 'macos') {
      return { abnormal: true, reason: `ua-platform-mismatch:${platform || 'empty'}` };
    }
  }
  // 7. 无 referer 却只有 cache-control: no-cache：真实浏览器刷新必然同时带 pragma: no-cache，缺 pragma 为伪造
  if (!referer) {
    const cc = (request.headers.get('cache-control') || '').toLowerCase();
    const pragma = (request.headers.get('pragma') || '').toLowerCase();
    if (cc.includes('no-cache') && !pragma.includes('no-cache')) {
      return { abnormal: true, reason: 'cc-without-pragma' };
    }
  }
  return { abnormal: false };
}

// 429 tarpit：限流 + 延迟后返回 429
// 注意：Workers 墙钟上限 30s，60s 延迟会超时，这里用 5s 延迟 + Retry-After:60 卡死客户端
// 429 响应改为可缓存 60s（防重试风暴反复烧 D1）
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
            'retry-after': '86400',
            'cache-control': 'public, max-age=86400, s-maxage=86400',
            'cdn-cache-control': 'public, max-age=86400',
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
      'retry-after': '86400',
      'cache-control': 'public, max-age=86400, s-maxage=86400',
      'cdn-cache-control': 'public, max-age=86400',
      'x-bot-reason': reason,
    },
  });
}
