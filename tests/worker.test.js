import { describe, test, expect, beforeEach, mock } from "bun:test";
import worker from "../src/index.js";
import { resetCircuitForTest, getCircuitState, recordD1Failure } from "../src/lib/circuit.js";

function mockD1Fail() {
  return {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => { throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan"); },
        all: async () => { throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit."); },
        run: async () => { throw new Error("D1_ERROR"); }
      }),
      first: async () => { throw new Error("D1_ERROR"); },
      all: async () => { throw new Error("D1_ERROR"); },
    })
  };
}

function mockD1Missing() {
  return {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({}),
      }),
      first: async () => null,
      all: async () => ({ results: [] }),
    })
  };
}

const baseEnv = (d1) => ({
  def_dict: d1,
  ASSETS: { fetch: async () => new Response('not found', {status:404}) },
  ABNORMAL_LIMITER: { limit: async () => ({ success: true }) }
});

const ctx = { waitUntil: (p) => p };

beforeEach(() => {
  resetCircuitForTest();
  globalThis.caches = {
    default: {
      match: async () => null,
      put: async () => {},
      delete: async () => {}
    }
  };
});

describe("需求2: DB错误捕获后 sleep 4s 返回 429 空白", () => {
  test("D1 异常转为 429 空白且 4s 延迟", async () => {
    const req = new Request('https://def.est.im/hello', { headers: { 'cf-connecting-ip': '1.1.1.1' } });
    req.cf = {};
    const t0 = Date.now();
    const res = await worker.fetch(req, baseEnv(mockD1Fail()), ctx);
    const dt = Date.now() - t0;
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get('x-d1-error')).toBe('1');
    expect(await res.text()).toBe('');
    expect(dt).toBeGreaterThanOrEqual(3900);
    expect(dt).toBeLessThan(6000);
    // 统一 429 逻辑：可缓存 60s
    expect(res.headers.get('cache-control')).toContain('max-age=60');
  }, 10000);

  test("sitemap D1 异常同样转 429", async () => {
    const req = new Request('https://def.est.im/sitemap.xml', { headers: { 'cf-connecting-ip': '1.1.1.2' } });
    req.cf = {};
    // mock ASSETS 返回 404 让其走 D1 回退
    const env = baseEnv(mockD1Fail());
    env.ASSETS.fetch = async () => new Response('not found', {status:404});
    const t0 = Date.now();
    const res = await worker.fetch(req, env, ctx);
    const dt = Date.now() - t0;
    expect(res.status).toBe(429);
    expect(dt).toBeGreaterThanOrEqual(3900);
  }, 10000);
});

describe("需求3: 反复出错后带空格查询一刀切 429", () => {
  test("3次 D1 失败后熔断，带空格查询直接 429", async () => {
    const envFail = baseEnv(mockD1Fail());
    for (let i=0;i<3;i++) {
      const r = new Request(`https://def.est.im/fail${i}`, { headers: { 'cf-connecting-ip': `2.2.2.${i}` } });
      r.cf = {};
      await worker.fetch(r, envFail, ctx);
    }
    expect(getCircuitState().open).toBe(true);
    const req = new Request('https://def.est.im/another%20phrase', { headers: { 'cf-connecting-ip': '3.3.3.3' } });
    req.cf = {};
    const t0 = Date.now();
    const res = await worker.fetch(req, envFail, ctx);
    const dt = Date.now() - t0;
    expect(res.status).toBe(429);
    expect((res.headers.get('x-circuit-reason')||'')).toContain('spaced');
    expect(dt).toBeGreaterThanOrEqual(3900);
    expect(await res.text()).toBe('');
  }, 20000);

  test("单字查询不受 spaced 熔断影响，但受通用熔断限制", async () => {
    const envFail = baseEnv(mockD1Fail());
    for (let i=0;i<3;i++) {
      const r = new Request(`https://def.est.im/fail${i}`, { headers: { 'cf-connecting-ip': `2.2.2.${i}` } });
      r.cf = {};
      await worker.fetch(r, envFail, ctx);
    }
    // 非空格词应走 cache-miss 熔断
    const req = new Request('https://def.est.im/singleword', { headers: { 'cf-connecting-ip': '4.4.4.4' } });
    req.cf = {};
    const res = await worker.fetch(req, envFail, ctx);
    expect(res.status).toBe(429);
    expect((res.headers.get('x-circuit-reason')||'')).toContain('cache-miss');
  }, 20000);
});

describe("需求4: 重复查询走 cache，击穿后走 limit 统一 429", () => {
  test("缓存命中绕过熔断", async () => {
    const envFail = baseEnv(mockD1Fail());
    for (let i=0;i<3;i++) {
      const r = new Request(`https://def.est.im/fail${i}`, { headers: { 'cf-connecting-ip': `2.2.2.${i}` } });
      r.cf = {};
      await worker.fetch(r, envFail, ctx);
    }
    // mock cache hit
    globalThis.caches.default.match = async () => new Response('cached content', { headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=3600' } });
    const req = new Request('https://def.est.im/cachedword', { headers: { 'cf-connecting-ip': '5.5.5.5' } });
    req.cf = {};
    const res = await worker.fetch(req, envFail, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('cached content');
  }, 20000);

  test("POST 带空格在熔断期直接 429", async () => {
    const envFail = baseEnv(mockD1Fail());
    for (let i=0;i<3;i++) {
      const r = new Request(`https://def.est.im/fail${i}`, { headers: { 'cf-connecting-ip': `2.2.2.${i}` } });
      r.cf = {};
      await worker.fetch(r, envFail, ctx);
    }
    const req = new Request('https://def.est.im/?w=hello%20world&fragment=1', { method: 'POST', headers: { 'cf-connecting-ip': '6.6.6.6' } });
    req.cf = {};
    const res = await worker.fetch(req, envFail, ctx);
    expect(res.status).toBe(429);
    expect((res.headers.get('x-circuit-reason')||'')).toContain('spaced');
  }, 20000);
});

describe("需求1: negative cache", () => {
  test("missing 单词触发 negative cache 长缓存 86400", async () => {
    const req = new Request('https://def.est.im/thisworddoesnotexist123', { headers: { 'cf-connecting-ip': '6.6.6.6' } });
    req.cf = {};
    const res = await worker.fetch(req, baseEnv(mockD1Missing()), ctx);
    expect(res.headers.get('cache-control')).toContain('86400');
    expect(res.headers.get('x-negative-cache')).toBe('1');
    // 单词 missing 应 200 占位但可缓存
    expect(res.status).toBe(200);
  });

  test("missing 短语直接 404 长缓存 negative cache", async () => {
    const req = new Request('https://def.est.im/missing%20phrase%20test', { headers: { 'cf-connecting-ip': '6.6.6.7' } });
    req.cf = {};
    const res = await worker.fetch(req, baseEnv(mockD1Missing()), ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toContain('86400');
    expect(res.headers.get('x-negative-cache')).toBe('1');
  });
});

describe("需求5: 省日志", () => {
  test("wrangler.toml 关闭 invocation_logs", async () => {
    const toml = await Bun.file("wrangler.toml").text();
    expect(toml).toContain("invocation_logs = false");
    expect(toml).toContain("[observability.logs]");
    const logsSection = toml.split("[observability.logs]")[1].split("[")[0];
    expect(logsSection).toContain("persist = false");
    expect(logsSection).not.toContain("persist = true");
  });
});
