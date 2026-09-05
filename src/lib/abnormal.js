'use strict';
// 429 tarpit 中间件：限流 + 延迟后返回 429
// 判定逻辑已拆至 crest guard Worker（经 service binding RPC 调用），此处只保留执行侧。
// 免费可用：Rate Limiting binding

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
