# 接手文档（HANDOVER）

> 2026-08-16 · 交接给下一位开发者。本文档如实记录当前状态、数据流水线、已知坑。

## 一、当前数据资产（本地）

| 库 | 路径 | 词条 | 义项 | surfaces | 说明 |
|---|---|---|---|---|---|
| 采集原库 | `data/dict.db` | 67,543 | — | — | `collect.ts` 直接写入，BFS 全量 |
| 清洗库 | `data/dict_clean.db` | **44,916** | 72,289 | 308,438 | `clean_migrate.ts` 产出，**最新最全** |
| 备份 | `data/dict_clean.db.pre-m1.bak` | 40,578 | — | — | 上一轮（未补采 1M+ 词） |
| 备份 | `data/dict_clean.db.bak` | 36,326 | — | — | 更早（本轮改造前） |
| 权威词表 | `data/word_cefr_minified.db` | 172,782 | — | — | 词频/CEFR/lemma 链接来源 |
| 本地 D1 (miniflare) | `.wrangler/state/v3/d1/.../cad69*.sqlite` | 44,916 | 72,289 | 308,438 | `wrangler dev` 用，已是最新全量 |

## 二、当前数据资产（线上 Cloudflare D1）

**✅ 线上已全量恢复并稳定运行：words=45,200, senses=72,290, surfaces=308,446。**

- 45,200 = 44,916 清洗库全量 + 283 个 on-demand 占位行（entity_type=-1，未收录词被访问时触发生成的锁，5 分钟超时）+ 1 个已生成入库的词
- LLM 通路已配好：`LLM_TOKEN`（secret）+ `LLM_API`/`LLM_MODEL`（vars），`GET /_ai/probe` 返回 `{"ok":true,"reply":"PONG",...}` 即通路正常
- 2026-08-12 曾因误 DROP 线上表导致数据清空，已恢复（见第四节）

## 三、数据流水线（从采集到上线）

```
collect.ts ──> dict.db（采集原库，BFS + 三层防垃圾）
    │
    │ bun run src/clean_classify.ts   ← 规则分类（词表归原/keep/inflection）
    │ bun run src/clean_ai.ts          ← AI 多分类（clean_ai.json，可跳过）
    ▼
clean_migrate.ts ──> dict_clean.db（清洗库，surfaces 一表通吃）
    │
    │ bun run src/export_d1.ts ──> data/d1/d1_data_00..03.sql + schema.sql
    ▼
本地 D1（miniflare）══ 线上 D1（wrangler d1 execute）
```

### 各环节要点

- **collect.ts**：`--env .env.dev2` 切换 API（默认 `.env.dev`）；`--seed "词1 词2"` 补采指定词；`--max` 是**累计 processed 上限**（断点续跑时 = 当前 processed + 新增量）；`--limit 15` 并发。断点在 `data/state.json`。
- **clean_classify.ts**：产出 `data/clean_tags.json`。只采纳真屈折 tag 链接（INFLECT_TAGS），高频多义词性词（≥1e7）保留独立词条。
- **clean_migrate.ts**：重建 dict_clean.db。**幂等**，但会清空目标库重来（不是增量）。依赖 clean_tags.json。
- **export_d1.ts**：导出 D1 全量 SQL。⚠️ 见坑 #3。

### 脚本目录约定

- `src/`：正式管线 + worker（collect/clean_*/export_d1*/validate/audit/schema/closure/cefrList/env + index.js/lib）
- `scripts/`：一次性/临时脚本（backfill、backfill_forms、extract_etymology、fix_inflection_labels、gen_d1_schema），用法见各文件头部注释

## 四、线上 D1 恢复/更新

### 恢复被误删的线上数据（全量）
> ⚠️ 2026-08-12 实测：若表结构还在（`CREATE TABLE` 已存在），**跳过建表步骤**，直接导数据。线上可能残留少量行，先 `DELETE FROM words` 再导。

```bash
# 1. 建表（线上表结构不在了才需要；若表还在则跳过）
npx wrangler d1 execute def-dict --remote --file data/d1/d1_schema.sql

# 2. 导入 4 个数据文件（串行！一次一个，等完成再下一个）
npx wrangler d1 execute def-dict --remote --file data/d1/d1_data_00.sql
npx wrangler d1 execute def-dict --remote --file data/d1/d1_data_01.sql
npx wrangler d1 execute def-dict --remote --file data/d1/d1_data_02.sql
npx wrangler d1 execute def-dict --remote --file data/d1/d1_data_03.sql

# 3. 验证
npx wrangler d1 execute def-dict --remote --command "SELECT 'words',COUNT(*) FROM words UNION ALL SELECT 'senses',COUNT(*) FROM senses UNION ALL SELECT 'surfaces',COUNT(*) FROM surfaces"
```

### 后续增量更新（正确姿势）

**原则：永远不要 DROP 线上表。** 增量 = 只导新增/变更的词条。

1. `collect.ts` 补采 → `clean_classify.ts` → `clean_migrate.ts` 重建 dict_clean.db
2. 用 lemma 稳定键对比生成增量（word_id 在重建后会变，不能按 id 比）：
   ```bash
   bun run src/export_d1_incremental.ts <旧D1路径> > tmp/inc.sql
   ```
3. 只导入增量（INSERT OR REPLACE，幂等）：
   ```bash
   npx wrangler d1 execute def-dict --remote --file tmp/inc.sql
   ```

⚠️ 注意：`export_d1_incremental.ts` 的 oldDb 参数支持 miniflare D1（WAL 需读写模式打开）或 dict_clean 备份。

## 五、线上 Worker 与 LLM 配置

- **部署**：`wrangler deploy`（wrangler.toml：D1 binding `def_dict` + assets + shell.tpl Text rule）
- **自定义域名**：`def.est.im` 已绑定 worker（Cloudflare 侧 worker domain，非 wrangler.toml route）
- **LLM 变量**（on-demand 生成 + probe 用）：
  - `LLM_TOKEN` = secret（`wrangler secret put LLM_TOKEN`）
  - `LLM_API` / `LLM_MODEL` = vars（Dashboard 配置）
  - ⚠️ **vars 随版本走**：`wrangler deploy` 新版本不会自动继承旧版本 vars，部署后务必确认（`curl https://def.est.im/_ai/probe` 报 `LLM env missing` 就是丢了）
- **AI 存活探测**：`GET /_ai/probe` → 200 `{"ok":true,"reply":"PONG","ms":...}` / 503 带错误原因。prompt 极短：`Q:PING?\nA:`（模型补全 `___`）
- **on-demand 生成**：未收录词 → 占位页 → `POST /?gen=1&w=<word>` → 走 SSE 流式生成 → 入库回填；rejects 黑名单直接 404 不烧 API

## 六、已知坑（血泪教训）

1. **线上 D1 数据被误删**：导入新版本时 DROP 了线上表。教训：增量更新绝不 DROP/DELETE 线上数据，只做 INSERT OR REPLACE。
2. **wrangler d1 execute --file 大文件**：>10MB 文件会异步排队、服务端重试，多命令并发时互相 UNIQUE 冲突。串行执行，一次一个。
3. **export_d1.ts 的 q() 转义**：原只转义单引号，**未处理换行**。other_notes 含换行的词条生成的 SQL 跨行，线上解析报 `near "aa": syntax error`。已修复（换行转 `\n` 字面量），导出前确认。
4. **word_id 不稳定**：clean_migrate 重建时自增 id 顺序变，同一词新旧库 id 不同。**增量对比必须用 lemma 稳定键**（export_d1_incremental.ts 已实现）。
5. **collect.ts 的 --max 语义**：是累计 processed 上限不是本轮增量。断点续跑要传 `当前processed + 目标增量`。`--fresh` 会清空 dict.db 和 state.json（慎用）。
6. **miniflare D1 只读打不开**：WAL 未合并时 `readonly:true` 会报 unable to open，要用读写模式打开。
7. **state.json 不能随便清**：清了 visited 集合，补采会重复采已收录词。备份再动。
8. **LLM vars 随版本丢失**：`wrangler deploy` 后 `LLM_API`/`LLM_MODEL` 可能丢（secret 不丢）。用 `/_ai/probe` 验证，丢了从 Dashboard 重填。
9. **workers.dev 子域可能 429**：`def.yiesty.workers.dev` 会被 Cloudflare 临时限流，正常域名 `def.est.im` 不受影响，测试用自定义域名。
10. **on-demand 生成无限流**：`POST /?gen=1&w=xxx` 任何人可触发，未配限流前注意 API 预算（曾遇 opencode.ai 余额不足 401）。

## 七、待办（按优先级）

- [ ] **gen 限流**：防止 `POST /?gen=1` 被刷爆 LLM 预算（readme ToDo 也挂着）
- [ ] 错误拼写跳转；大小写/缩写/美英差异归一化（跳转表）
- [ ] 词族归一：postdoc/post-doc/postdoctoral → surfaces(kind=spelling)
- [ ] 名字/地名/乐队查询：on-demand 名字专属 prompt（谐音坑/词源/性别倾向）
- [ ] register 规范化（受控词表）与覆盖提升（现 22.5%）
- [ ] usage_notes 覆盖提升（现 28.2%）
- [ ] **采集 bug：词频门槛误杀整族**（`enqueue()` 用原形 freq 判定，屈折形式更高则整族漏采，~919 lemma；修法见 readme）
- [ ] OpenSearch / tab-to-search
- [ ] 义项级 CEFR（词表每词性 level 预计算）
- [ ] 复数独立义项（data/media 等）人工复核清单

（已划掉：恢复线上 D1、部署 worker、LLM 配置、AI 探测。词源 etymology 任务已移除——覆盖意义不大。）

## 八、历史改动（2026-08 关键 commit）

- `28d7389` 补采高频缺失词 + 清洗分类修复 + 增量导出工具
- `45c13cb` 词频门槛/入库 freq 改用家族词频
- `0da0d19` 模板化 shell、查询并行化、gen 锁、ETag
- 更早的展示层/性能优化见 git log
