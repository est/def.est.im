# 缓存改造:进度 & 下一步行动方案

> 背景:免费 CF,Workers 请求与 D1 每天都吃满。硬约束:**任何改动都不能比现状更吃流量**。
> 本文只谈省流量/省钱。

## 0. 免费套餐的真实成本模型(一切取舍的基准)

- **Workers 请求配额(10 万/天)**:用 Cache API 的响应**每次请求都会启动 Worker**,配额一点不省。
  线上实测:`/run` 无 `cf-cache-status`(未进边缘缓存),`/style.css`、`/sitemap.xml`、`/robots.txt` 为 `HIT`。
- **D1 rows_read(500 万/天)**:仅在缓存未命中时发生,一次 miss 约 **100~250 行**(探测是大头,见 B)。
- **D1 rows_written(10 万/天)**:on-demand 生成写入;失败重试会反复写(见 E)。
- **LLM**:仅 JS 客户端触发 `?gen=1` 时消耗(见 E)。

**两条硬事实(官方文档确认):**
1. Worker 自己 `return new Response(...)` 的响应**不走 zone 缓存**(Worker 在 zone 缓存之前运行),所以 zone 的 Cache Rules / Cache Everything 对本项目**无效**。
2. 唯一有效的机制是 **Workers Cache(`[cache]`)**。**但它命中仍算 1 次请求**(省 D1 与 CPU,不省请求配额)。
   → 结论:**能省 D1/CPU,不能省请求数**。要省请求数只能减少请求本身(见下一步 A/WAF)。

---

## 1. 已完成

### P0-1:429 不再污染词条页缓存 ✅
- 429 走独立 key `/__block/<word>`;词条页写缓存前只放行 `200/302/404`;熔断/D1 错误 429 不落任何缓存。
- `abnormal.js` 429 缓存 TTL 86400 → 60s。
- 根因链:bot/被误判请求把某词写成 24h 429 → 正常用户集体吃 429。已复现、已修。

### B:存在性探测瘦身(D1 rows_read 直接降)✅
- `src/lib/lookup.js`:探测由 `SELECT surface,kind ... LIMIT 5`(每命中词最多 **5 行**)改为
  `SELECT 1 ... LIMIT 1`(每命中词 **0/1 行**);`inflectLinked` 用 `... AND kind='lemma' LIMIT 1` 单独判。
- 语义不变(`discoverable/phraseLinked/inflectLinked`),单次 miss 的探测开销最多降到 **1/5**。
- 测试:`tests/lookup.test.js` 锁定「只用 LIMIT 1 / 语义不变」。

### E:失败生成不再反复烧 LLM ✅
- `handlePost(gen)`:占位行 `other_notes` 改为 `<start>|<fails>` 标记。
- 连续 **3 次「内容性」失败**(JSON 解析/字段缺失等)后写 `rejects` + 删占位行 + 清缓存;后续 GET 直接 404。
- **基础设施错误(HTTP 5xx / 超时 / 缺 env)不计入**,避免 LLM 短暂故障误封好词。
- 已在 `rejects` 的词 gen 直接回绝,不调 LLM。

### G:sitemap 缓存键修正 ✅
- `cacheKeyForSitemap(origin, path)` 按实际路径缓存,`/sitemaps/*.xml` 不再串根 sitemap 内容。

### C:词条页接入 Workers Cache ✅
- `wrangler.toml` 新增 `[cache] enabled = true` + `cross_version_cache = true`。
- 429 全部加 `cloudflare-cdn-cache-control: no-store`,**绝不被全局缓存**(避免 429 毒化)。
- 移除词条页的 `Vary: Accept-Encoding`:Workers Cache 对 `Vary` 是**逐字面值**建变体,`gzip,br` 与 `br,gzip` 会分裂成两条 → 命中率暴跌。
- POST 的 JSON 响应加 `no-store`,防被启发式缓存。
- 效果:命中时 **Worker 不执行 → 零 D1、零 CPU、零 guard RPC**(但请求数照记)。

### D:全局失效(不再只删本 POP)✅
- 新增 `purgeWord(ctx, reqUrl, words)`:优先 `ctx.cache.purge({ tags })`(**全局 Instant Purge**),再兜底 `caches.default.delete`(本 POP)。
- 页面/词条响应加 `Cache-Tag: word:<urlencoded>`;sitemap 加 `Cache-Tag: sitemap`。
- 生成成功 / 判 reject 时调用 `purgeWord`,失效该词与 sitemap。

---

## 2. 必须知道的取舍 / 风险(部署前读)

| 项 | 说明 |
|---|---|
| **命中仍计请求** | Workers Cache 命中消耗 1 次请求配额,省的是 D1/CPU。要省请求数得靠减少请求(A/WAF)。 |
| **guard 命中时被跳过** | 默认 entrypoint 开了缓存 → 已被缓存的 URL 不再跑 guard。被拦爬虫会拿到缓存页(**便宜,但会继续爬**)。若要每请求都跑 guard,需「gateway + 内层 cached entrypoint」双 entrypoint,但 loopback 调用是否额外计费官方未明确 → 有**翻倍请求**风险,暂不采用。 |
| **缓存键大小写/query 敏感** | Workers Cache 键 = path+query(不含 host)。`/Run`≠`/run`、`?v=1` 各自独立。因此**保留 Cache API(归一化键)做兜底**,异常变体命中不了 Workers Cache 也能命中 Cache API,仍不读 D1。 |
| **`cross_version_cache = true`** | 部署不再清空缓存(避免部署日 D1 雪崩),代价:改模板/渲染后最长 24h 内仍服务旧内容。**改模板期间**可临时置 `false`,或缩短 TTL。 |
| **`s-maxage`/`must-revalidate` 会关掉 SWR/stale-if-error** | 现有响应同时带 `s-maxage` 和 `stale-while-revalidate`,`stale-while-revalidate` 实际**不生效**。想要后台刷新可去掉 `s-maxage`、改用 `cdn-cache-control` 控制边缘 TTL。 |
| **purge 限速** | `ctx.cache.purge()` 恒为 **Free 档(5 次/分/账号,bucket 25)**;批量生成场景注意节流。 |
| **无法本地验证计费** | 一切以部署后 Metrics 为准(见验证清单)。 |

---

## 3. 剩余下一步

### A. crest 放宽 Safari/Firefox 误判 —— 建议优先(近中性)⭐
`crest/src/guard.ts:70` 现为「UA 含 `Macintosh` 但没发 `sec-ch-ua-platform` → abnormal」;**Safari/Firefox 本就不发该头**,等于误伤所有 macOS Safari/Firefox。
- 只能做**窄化版**:仅当 UA 含 Chromium 特征(`Chrome/` 或带 `Sec-CH-UA`)时才判 platform 矛盾。
- ❌ 不要做「放行所有 Safari/Firefox」:伪装 Safari 的爬虫会落到 D1,那才真费流量。
- 💸 近中性;🔧 小。

### F. HEAD 复用 GET(顺手)
`curl -I /run` 现返回 `404 text/plain` 且绕过全部缓存。爬虫用 HEAD 探测会误判站点坏掉。
- 💸 近中性偏好(把 404 变成可缓存命中);🔧 小。

### 可选:WAF 层拦爬虫(唯一能省**请求数**的方向)
guard 在 Worker 内,爬虫请求照样计入配额。把「AI 爬虫 / 已知恶意 UA」放到 **zone WAF / Bot 规则**在 Worker 之前拦掉,才真正省请求数。需在 Dashboard 配置,免费套餐能力有限,需实测。

### 可选:gateway + 内层 cached entrypoint
能「每请求跑 guard + 命中页面不渲染」,但 loopback 计费口径不确定(**可能翻倍请求**),与硬约束冲突,**暂不做**。

---

## 4. 部署后验证清单

1. `wrangler deploy`(需先 `wrangler login`)。
2. 连续 `curl -I https://def.est.im/run` 两次:第二次应出现 **`cf-cache-status: HIT`**,且 Worker Metrics 的 **invocations 不再等于请求数**。
3. 复现 P0-1:`同词先 bot UA 再正常 UA`,正常请求应始终 **200**。
4. 看 Metrics:**D1 rows_read 是否下降**、**Workers 请求数是否持平(不应上升)**。
5. 生成新词后:该词应立即从占位页变词条(说明 `ctx.cache.purge` 生效)。
6. 观察 `x-block-reason` / `x-circuit-reason` 频率是否异常(误判信号)。

## 5. 测试

`bun test` → 全绿。覆盖:P0-1(block 键隔离/中毒回归)、B(探测 LIMIT 1/语义)、E(失败上限/reject/基础设施不计入)、C/D(Cache-Tag/429 no-store/purge 调用)。
