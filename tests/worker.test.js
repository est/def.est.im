import { describe, test, expect, beforeEach, mock } from "bun:test";
import worker from "../src/index.js";
import { checkVerdict } from "../crest/src/guard.ts";
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
  ABNORMAL_LIMITER: { limit: async () => ({ success: true }) },
  // 默认走真实 guard 规则（经纯数据 signal），与生产 RPC 行為一致
  GUARD: { check: async (s) => checkVerdict(s) }
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
    expect(res.headers.get('retry-after')).toBe('86400');
    expect(res.headers.get('x-d1-error')).toBe('1');
    expect(await res.text()).toBe('');
    expect(dt).toBeGreaterThanOrEqual(3900);
    expect(dt).toBeLessThan(6000);
    // 429 任何一层都不缓存（浏览器/边缘/Cache API 全 no-store）
    expect(res.headers.get('cache-control')).toBe('no-store');
  }, 10000);

  test("sitemap 静态缺失直接 404，无 D1 回退", async () => {
    const req = new Request('https://def.est.im/sitemap.xml', { headers: { 'cf-connecting-ip': '1.1.1.2' } });
    req.cf = {};
    // mock ASSETS 返回 404：纯静态 sitemap 设计下应直接 404，绝不读库
    const env = baseEnv(mockD1Fail());
    env.ASSETS.fetch = async () => new Response('not found', {status:404});
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
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

describe("P0-1: 429 不污染词条页缓存", () => {
  const cacheStub = () => {
    const store = new Map();
    return {
      store,
      api: {
        match: async (req) => { const r = store.get(req.url); return r ? r.clone() : null; },
        put: async (req, res) => { store.set(req.url, res); },
        delete: async (req) => { store.delete(req.url); },
      },
    };
  };

  test("abnormal 429 不写任何缓存键，且响应 no-store", async () => {
    const putPaths = [];
    globalThis.caches.default = {
      match: async () => null,
      put: async (req) => { putPaths.push(new URL(req.url).pathname); },
      delete: async () => {},
    };
    const env = baseEnv(mockD1Missing());
    const req = new Request('https://def.est.im/hello', { headers: { 'user-agent': 'GPTBot/1.0', 'cf-connecting-ip': '7.7.7.7' } });
    req.cf = {};
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(putPaths).toEqual([]);
  }, 15000);

  test("bot 被判 abnormal 后，正常请求同一词仍返回 200（不中毒）", async () => {
    const stub = cacheStub();
    globalThis.caches.default = stub.api;
    const env = baseEnv(mockD1Missing());
    const bot = new Request('https://def.est.im/hello', { headers: { 'user-agent': 'GPTBot/1.0', 'cf-connecting-ip': '7.7.7.8' } });
    bot.cf = {};
    const r1 = await worker.fetch(bot, env, ctx);
    expect(r1.status).toBe(429);
    const human = new Request('https://def.est.im/hello', { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36', 'cf-connecting-ip': '7.7.7.9' } });
    human.cf = {};
    const r2 = await worker.fetch(human, env, ctx);
    expect(r2.status).toBe(200);
    expect(r2.headers.get('x-negative-cache')).toBe('1');
  }, 20000);

  test("熔断 429 不写任何缓存键（含 block 键）", async () => {
    const putPaths = [];
    globalThis.caches.default = {
      match: async () => null,
      put: async (req) => { putPaths.push(new URL(req.url).pathname); },
      delete: async () => {},
    };
    const envFail = baseEnv(mockD1Fail());
    for (let i = 0; i < 3; i++) {
      const r = new Request(`https://def.est.im/fail${i}`, { headers: { 'cf-connecting-ip': `8.8.8.${i}` } });
      r.cf = {};
      await worker.fetch(r, envFail, ctx);
    }
    putPaths.length = 0;
    const req = new Request('https://def.est.im/singleword', { headers: { 'cf-connecting-ip': '8.8.8.9' } });
    req.cf = {};
    const res = await worker.fetch(req, envFail, ctx);
    expect(res.status).toBe(429);
    expect(putPaths).toEqual([]);
  }, 20000);
});

describe("需求5: observability 配置", () => {
  // 注意：日志已在 d4c6042 重新开启（排障需要），此测试改为锁定当前线上配置
  test("wrangler.toml observability.logs 配置与线上一致", async () => {
    const toml = await Bun.file("wrangler.toml").text();
    expect(toml).toContain("[observability.logs]");
    const logsSection = toml.split("[observability.logs]")[1].split("[")[0];
    expect(logsSection).toContain("enabled = true");
    expect(logsSection).toContain("invocation_logs = true");
    expect(logsSection).toContain("persist = true");
  });
});

describe("拦截中间件: Macintosh UA 与 sec-ch-ua-platform 矛盾", () => {
  const macUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
  const winUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  test("Macintosh + 无平台头 => 429", async () => {
    const req = new Request('https://def.est.im/hello', { headers: { 'user-agent': macUA, 'cf-connecting-ip': '9.9.9.1' } });
    req.cf = {};
    const res = await worker.fetch(req, baseEnv(mockD1Missing()), ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get('x-bot-reason')).toContain('ua-platform-mismatch');
  }, 10000);
  test("Macintosh + platform Windows => 429", async () => {
    const req = new Request('https://def.est.im/hello', { headers: { 'user-agent': macUA, 'sec-ch-ua-platform': '"Windows"', 'cf-connecting-ip': '9.9.9.2' } });
    req.cf = {};
    const res = await worker.fetch(req, baseEnv(mockD1Missing()), ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get('x-bot-reason')).toContain('ua-platform-mismatch');
  }, 10000);
  test("Macintosh + platform macOS => 放行", async () => {
    const req = new Request('https://def.est.im/hello', { headers: { 'user-agent': macUA, 'sec-ch-ua-platform': '"macOS"', 'cf-connecting-ip': '9.9.9.3' } });
    req.cf = {};
    const res = await worker.fetch(req, baseEnv(mockD1Missing()), ctx);
    // missing 单词应 200 占位，不应被拦截
    expect(res.status).toBe(200);
  }, 10000);
  test("非 Macintosh + Windows 平台 => 放行", async () => {
    const req = new Request('https://def.est.im/hello', { headers: { 'user-agent': winUA, 'sec-ch-ua-platform': '"Windows"', 'cf-connecting-ip': '9.9.9.4' } });
    req.cf = {};
    const res = await worker.fetch(req, baseEnv(mockD1Missing()), ctx);
    expect(res.status).toBe(200);
  }, 10000);
  test("Macintosh + platform 大小写容错 => 放行", async () => {
    const req = new Request('https://def.est.im/hello', { headers: { 'user-agent': macUA, 'sec-ch-ua-platform': 'macOS', 'cf-connecting-ip': '9.9.9.5' } });
    req.cf = {};
    const res = await worker.fetch(req, baseEnv(mockD1Missing()), ctx);
    expect(res.status).toBe(200);
  }, 10000);
  // Safari/Firefox/iPadOS Safari 不发 sec-ch-ua-platform，不能误伤
  const safariMacUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const firefoxMacUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0";
  const iPadSafariUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  for (const [name, ua] of [["Safari", safariMacUA], ["Firefox", firefoxMacUA], ["iPadOS Safari", iPadSafariUA]]) {
    test(`macOS ${name}（不发 platform 头）=> 放行`, async () => {
      const req = new Request('https://def.est.im/hello', { headers: { 'user-agent': ua, 'cf-connecting-ip': '9.9.9.6' } });
      req.cf = {};
      const res = await worker.fetch(req, baseEnv(mockD1Missing()), ctx);
      expect(res.status).toBe(200);
    }, 10000);
  }
});

describe("guard RPC 接入: verdict 拦截 + fail-open", () => {
  test("guard 判 abnormal => 429 + x-bot-reason", async () => {
    const env = baseEnv(mockD1Missing());
    env.GUARD = { check: async () => ({ abnormal: true, reason: 'ua-ai:GPTBot' }) };
    const req = new Request('https://def.est.im/hello', { headers: { 'user-agent': 'GPTBot/1.0', 'cf-connecting-ip': '9.9.9.9' } });
    req.cf = {};
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get('x-bot-reason')).toContain('ua-ai');
  }, 10000);
  test("guard 收到的 signal 是纯数据（无函数、无 Request）", async () => {
    let got = null;
    const env = baseEnv(mockD1Missing());
    env.GUARD = { check: async (s) => { got = s; return { abnormal: false }; } };
    const req = new Request('https://def.est.im/hello', { headers: { 'user-agent': 'x', 'cache-control': 'no-cache', 'cf-connecting-ip': '1.2.3.4' } });
    req.cf = { verifiedBotCategory: 'Search Engine', botManagement: { verifiedBot: true, score: 99 } };
    await worker.fetch(req, env, ctx);
    expect(got.cacheControl).toBe('no-cache');
    expect(got.verifiedBotCategory).toBe('Search Engine');
    expect(got.botManagement).toEqual({ verifiedBot: true, score: 99 });
    expect(got.sameSiteOrigin).toBe('https://def.est.im/');
    expect(JSON.parse(JSON.stringify(got))).toEqual(got);
  });
  test("guard 抛错 => fail-open 放行", async () => {
    const env = baseEnv(mockD1Missing());
    env.GUARD = { check: async () => { throw new Error('boom'); } };
    const req = new Request('https://def.est.im/hello', { headers: { 'cf-connecting-ip': '9.9.9.10' } });
    req.cf = {};
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
  });
  test("无 GUARD binding => fail-open 放行", async () => {
    const env = baseEnv(mockD1Missing());
    delete env.GUARD;
    const req = new Request('https://def.est.im/hello', { headers: { 'cf-connecting-ip': '9.9.9.11' } });
    req.cf = {};
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
  });
});

describe("E: 生成失败达上限写入 rejects，停止反复烧 LLM", () => {
  // 状态化 D1 桩：覆盖 handlePost(gen) 用到的全部语句
  function genEnv() {
    const state = { words: new Map(), rejects: new Set(), lastId: 0 };
    const d1 = {
      state,
      prepare(sql) {
        const norm = sql.replace(/\s+/g, " ").trim();
        return {
          _a: [],
          bind(...a) { this._a = a; return this; },
          async first() {
            if (norm.startsWith("SELECT word_id, entity_type, other_notes FROM words")) {
              const w = state.words.get(String(this._a[0]).toLowerCase());
              return w ? { ...w } : null;
            }
            if (norm.startsWith("SELECT 1 FROM rejects")) {
              return state.rejects.has(String(this._a[0]).toLowerCase()) ? { 1: 1 } : null;
            }
            return null;
          },
          async run() {
            if (norm.startsWith("INSERT INTO words (lemma, entity_type, other_notes)")) {
              const [lemma, notes] = this._a;
              const id = ++state.lastId;
              state.words.set(lemma, { word_id: id, entity_type: -1, other_notes: notes });
              return { meta: { last_row_id: id } };
            }
            if (norm.startsWith("UPDATE words SET other_notes")) {
              const [notes, id] = this._a;
              for (const w of state.words.values()) if (w.word_id === id) w.other_notes = notes;
              return {};
            }
            if (norm.startsWith("INSERT OR IGNORE INTO rejects")) { state.rejects.add(String(this._a[0]).toLowerCase()); return {}; }
            if (norm.startsWith("DELETE FROM words WHERE word_id")) {
              const [id] = this._a;
              for (const [k, w] of state.words) if (w.word_id === id) state.words.delete(k);
              return {};
            }
            return {};
          },
          async all() { return { results: [] }; },
        };
      },
      async batch(stmts) { return Promise.all(stmts.map((s) => s.all())); },
    };
    // 正常请求：guard 放行，回到真正的业务逻辑
    return { env: { def_dict: d1, LLM_API: "https://llm.test/v1", LLM_MODEL: "x", LLM_TOKEN: "t", GUARD: { check: async () => ({ abnormal: false }) } }, state };
  }

  const genReq = () => {
    const r = new Request("https://def.est.im/?w=zzztest&gen=1", { method: "POST", headers: { "cf-connecting-ip": "5.5.5.5" } });
    r.cf = {};
    return r;
  };
  // 把 throttle 窗口拨到过期，保留失败计数（模拟 5 分钟后重试）
  const expireWindow = (state) => { for (const w of state.words.values()) w.other_notes = "0|" + String(w.other_notes).split("|")[1]; };

  test("连续 3 次内容性失败 → 写 rejects + 删占位行", async () => {
    const orig = globalThis.fetch;
    // 合法 JSON 但缺 entries → validate 抛 'entries empty'（内容性失败）
    globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"{\\"word\\":\\"zzz\\"}"}}]}\n\ndata: [DONE]\n\n', { status: 200 });
    try {
      const { env, state } = genEnv();
      for (let i = 0; i < 3; i++) {
        const res = await worker.fetch(genReq(), env, ctx);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(state.rejects.has("zzztest")).toBe(i === 2);
        expireWindow(state);
      }
      expect(state.rejects.has("zzztest")).toBe(true);
      expect(state.words.size).toBe(0);
    } finally { globalThis.fetch = orig; }
  }, 20000);

  test("HTTP 5xx 等基础设施错误不计入失败数，不误封", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => new Response("boom", { status: 500 });
    try {
      const { env, state } = genEnv();
      for (let i = 0; i < 5; i++) {
        const res = await worker.fetch(genReq(), env, ctx);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expireWindow(state);
      }
      expect(state.rejects.size).toBe(0);
      const w = [...state.words.values()][0];
      expect(String(w.other_notes).split("|")[1]).toBe("0");
    } finally { globalThis.fetch = orig; }
  }, 20000);

  test("已在 rejects 的词：gen 直接回绝，不调用 LLM", async () => {
    const orig = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => { called++; return new Response("", { status: 200 }); };
    try {
      const { env, state } = genEnv();
      state.rejects.add("zzztest");
      const res = await worker.fetch(genReq(), env, ctx);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.rejected).toBe(true);
      expect(called).toBe(0);
    } finally { globalThis.fetch = orig; }
  }, 10000);
});

describe("C/D: Workers Cache 接入", () => {
  test("页面响应带 Cache-Tag（供全局 purge）", async () => {
    const req = new Request("https://def.est.im/Hello", { headers: { "cf-connecting-ip": "6.6.6.9" } });
    req.cf = {};
    const res = await worker.fetch(req, baseEnv(mockD1Missing()), ctx);
    expect(res.headers.get("cache-tag")).toBe("word:hello");
  }, 10000);

  test("429 一律 no-store，浏览器/边缘/Cache API 都不缓存", async () => {
    const env = baseEnv(mockD1Missing());
    const req = new Request("https://def.est.im/hello", { headers: { "user-agent": "GPTBot/1.0", "cf-connecting-ip": "6.6.6.10" } });
    req.cf = {};
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get("cache-control")).toBe("no-store");
  }, 15000);

  test("生成成功后调用 ctx.cache.purge 失效该词与 sitemap", async () => {
    const orig = globalThis.fetch;
    const okJson = JSON.stringify({ word: "zzztest", entries: [{ pos: "noun", def_en: "nonsense", def_zh: "胡说" }] });
    globalThis.fetch = async () => new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: okJson } }] }) + '\n\ndata: [DONE]\n\n', { status: 200 });
    try {
      const state = { words: new Map(), rejects: new Set(), lastId: 0 };
      const d1 = {
        prepare(sql) {
          const norm = sql.replace(/\s+/g, " ").trim();
          return {
            _a: [],
            bind(...a) { this._a = a; return this; },
            async first() {
              if (norm.startsWith("SELECT word_id, entity_type, other_notes FROM words")) {
                const w = state.words.get(String(this._a[0]).toLowerCase());
                return w ? { ...w } : null;
              }
              if (norm.startsWith("SELECT 1 FROM rejects")) return null;
              return null;
            },
            async run() {
              const a = this._a;
              if (norm.startsWith("INSERT OR IGNORE INTO rejects")) { state.rejects.add(String(a[0]).toLowerCase()); return {}; }
              if (norm.startsWith("INSERT INTO words")) { const id = ++state.lastId; state.words.set(a[0], { word_id: id, entity_type: -1, other_notes: a[1] }); return { meta: { last_row_id: id } }; }
              if (norm.startsWith("INSERT")) return { meta: { last_row_id: ++state.lastId } };
              if (norm.startsWith("UPDATE words SET other_notes")) { const [notes, id] = a; for (const w of state.words.values()) if (w.word_id === id) w.other_notes = notes; return {}; }
              if (norm.startsWith("DELETE")) return {};
              return {};
            },
            async all() { return { results: [] }; },
          };
        },
        async batch(s) { return Promise.all(s.map((x) => x.all())); },
      };
      const purges = [];
      const c = { waitUntil: (p) => p, cache: { purge: async (arg) => { purges.push(arg); return { success: true }; } } };
      const env = { def_dict: d1, LLM_API: "https://llm.test/v1", LLM_MODEL: "x", LLM_TOKEN: "t", GUARD: { check: async () => ({ abnormal: false }) } };
      const req = new Request("https://def.est.im/?w=zzztest&gen=1", { method: "POST", headers: { "cf-connecting-ip": "6.6.6.11" } });
      req.cf = {};
      const res = await worker.fetch(req, env, c);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(purges.length).toBeGreaterThan(0);
      expect(purges[0].tags).toContain("word:zzztest");
      expect(purges[0].tags).toContain("sitemap");
    } finally { globalThis.fetch = orig; }
  }, 20000);
});

describe("规则1: 用户导航豁免（WebView 错报 sec-fetch-site:none）", () => {
  const mkVia = (ip) => {
    const req = new Request('https://def.est.im/rich', { headers: {
      'user-agent': 'Mozilla/5.0 (Linux; Android 13; 22041216C; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/104.0.5112.97 Mobile Safari/537.36',
      'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1',
      'referer': 'https://def.est.im/heavy', 'cf-connecting-ip': ip,
    } });
    req.cf = {};
    return req;
  };
  test("同站导航(mode=navigate & dest=document) => 放行", async () => {
    const res = await worker.fetch(mkVia('9.9.9.21'), baseEnv(mockD1Missing()), ctx);
    expect(res.status).toBe(200);
  }, 10000);
  test("无导航特征的 none + 同站 referer => 仍 429", async () => {
    const req = new Request('https://def.est.im/rich', { headers: {
      'user-agent': 'curl/8', 'sec-fetch-site': 'none', 'referer': 'https://def.est.im/heavy', 'cf-connecting-ip': '9.9.9.22',
    } });
    req.cf = {};
    const res = await worker.fetch(req, baseEnv(mockD1Missing()), ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get('x-bot-reason')).toContain('sec-fetch-site-none-with-referer');
  }, 15000);
});
