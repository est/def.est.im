# 坑位 / 运维

> 只留踩过且非 obvious 的。会随代码修掉的坑不长期保留。

## 运维原则

- **D1 永不 `DROP` 线上表**：`clean_migrate.ts` 会清空重建本地库，线上只能走增量（`export_d1_incremental.ts` 按 `lemma` 定位 `UPDATE/INSERT/DELETE`）
- **LLM vars 随版本丢失**：`LLM_TOKEN` 是 `secret` 随版本保留，`LLM_API`/`LLM_MODEL` 是 `vars`，不在 `wrangler.toml` 时 `wrangler deploy` 会清空，需 Dashboard 重填；验证 `curl https://def.est.im/_ai/probe` 报 `LLM env missing` 即丢

## 已踩坑

- **D1 大文件串行导入**：`wrangler d1 execute --file` 超 10MB 会排队重试，并发写互相 `UNIQUE` 冲突，必须一次一个
- **`q()` 换行转义**：`export_d1.ts` 需把真实换行转 `\n` 字面量防 SQL 跨行，否则线上报 `near "aa": syntax error`；渲染层已用 `pre-wrap` 还原
- **`word_id` 不稳定**：重建后自增 id 变序，增量对比必须用 `lemma` 键；`DELETE` 不能用本地 `word_id`，需 `WHERE word_id IN (SELECT word_id FROM words WHERE lemma='x')`
- **增量 `REPLACE` 陷阱**：旧版 `INSERT OR REPLACE` 会因占位行/ `sense_no` 变化产生双行/孤儿行，现为按 `lemma` 的差异 `UPDATE/INSERT/DELETE`
- **opencode zen 网关**：`stream:true` 会挂起，批量脚本须 `stream:false` + 重试；另有 `workers.dev` 子域 429 限流，测试用自定义域名
- **`collect` visited/rejects 残留**：补采前需从 `visited` 与 `rejects` 移除目标词，否则 `enqueue` 直接跳过
