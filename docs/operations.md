# 运维手册

> 只记不 obvious 且不易变的规则。命令怎么敲、目录长什么样不记。

## D1 增量更新

**原则：永不 `DROP` 线上表。** `word_id` 重建后不稳定，必须按 `lemma` 定位差异（`export_d1_incremental.ts` 已实现 `UPDATE/INSERT/DELETE` 按 `lemma` 定位）。

`clean_migrate.ts` 会清空重建本地库，但线上只能走增量导入。

## 部署与 LLM 配置

- `LLM_TOKEN` 是 `secret`（`wrangler secret put`），随版本保留
- `LLM_API` / `LLM_MODEL` 是 `vars`，**不在 `wrangler.toml` 时 `wrangler deploy` 会清空 vars**，需从 Dashboard 重填
- 验证：`curl https://def.est.im/_ai/probe` — `{"ok":true,"reply":"PONG"}` 正常，报 `LLM env missing` 即 vars 已丢
- `/_ai/probe` prompt 极短 `Q:PING?\nA:`，`on-demand` 为 `POST /?gen=1&w=<word>` SSE 流式入库，`rejects` 黑名单直接 404
