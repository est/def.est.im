# 接手文档（HANDOVER）

> 2026-08-16 · 交接给下一位开发者。本文档如实记录当前状态、数据流水线、已知坑。
> 08-16 更新：P0/P1 数据回填（音标/义项/词源/register/usage_notes）完成并已上线，见第七节。

## 一、当前数据资产（本地）

| 库 | 路径 | 词条 | 义项 | surfaces | 说明 |
|---|---|---|---|---|---|
| 采集原库 | `data/dict.db` | 67,543 | — | — | `collect.ts` 直接写入，BFS 全量 |
| 清洗库 | `data/dict_clean.db` | **44,916** | 77,559 | 335,730 | **最新最全**；回填 enrich 后（音标/词源/义项扩充） |
| 备份 | `data/dict_clean.db.pre-enrich.bak` | 44,916 | 72,289 | 308,438 | 回填前（增量对比基线） |
| 备份 | `data/dict_clean.db.pre-m1.bak` | 40,578 | — | — | 更早（未补采 1M+ 词） |
| 备份 | `data/dict_clean.db.bak` | 36,326 | — | — | 更早（改造前） |
| enrich 存档 | `data/enrich.json` | 4,535 词 | — | — | 回填完整词条 JSON，重建迁移后可 `apply_enrich.ts` 恢复 |
| 权威词表 | `data/word_cefr_minified.db` | 172,782 | — | — | 词频/CEFR/lemma 链接来源 |
| 本地 D1 (miniflare) | `.wrangler/state/v3/d1/.../cad69*.sqlite` | 44,916 | 77,559 | 335,730 | 已同步 enrich 增量 |

## 二、当前数据资产（线上 Cloudflare D1）

**✅ 线上已全量恢复并稳定运行（08-16 增量更新后）：words=45,246, senses=77,561, surfaces=335,713。**

- 45,246 = 44,916 清洗库全量 + 328 个 on-demand 占位行（entity_type=-1）+ 2 个已生成入库的词（on-demand 活动持续增长）
- 08-16 回填上线：4,565 词差异增量（音标/义项/词源/register/usage_notes），线上 words 行 UPDATE 不增数，senses/surfaces 增删见上
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

1. **线上 D1 数据被误删**：导入新版本时 DROP 了线上表。教训：增量更新绝不 DROP/DELETE 线上数据（见坑 11 修正：按 lemma 定位 DELETE 自己词的旧行是允许的，但绝不 DROP 整表）。
2. **wrangler d1 execute --file 大文件**：>10MB 文件会异步排队、服务端重试，多命令并发时互相 UNIQUE 冲突。串行执行，一次一个。
3. **export_d1.ts 的 q() 转义**：原只转义单引号，**未处理换行**。other_notes 含换行的词条生成的 SQL 跨行，线上解析报 `near "aa": syntax error`。已修复（换行转 `\n` 字面量），导出前确认。
4. **word_id 不稳定**：clean_migrate 重建时自增 id 顺序变，同一词新旧库 id 不同。**增量对比必须用 lemma 稳定键**（export_d1_incremental.ts 已实现）。
5. **collect.ts 的 --max 语义**：是累计 processed 上限不是本轮增量。断点续跑要传 `当前processed + 目标增量`。`--fresh` 会清空 dict.db 和 state.json（慎用）。
6. **miniflare D1 只读打不开**：WAL 未合并时 `readonly:true` 会报 unable to open，要用读写模式打开。
7. **state.json 不能随便清**：清了 visited 集合，补采会重复采已收录词。备份再动。
8. **LLM vars 随版本丢失**：`wrangler deploy` 后 `LLM_API`/`LLM_MODEL` 可能丢（secret 不丢）。用 `/_ai/probe` 验证，丢了从 Dashboard 重填。
9. **workers.dev 子域可能 429**：`def.yiesty.workers.dev` 会被 Cloudflare 临时限流，正常域名 `def.est.im` 不受影响，测试用自定义域名。
10. **on-demand 生成无限流**：`POST /?gen=1&w=xxx` 任何人可触发，未配限流前注意 API 预算（曾遇 opencode.ai 余额不足 401）。
11. **增量导入不能 INSERT OR REPLACE（旧版 export_d1_incremental 的坑）**：word_id 重建后不稳定 + 线上被 on-demand 占位行污染，REPLACE 会双行/孤儿行；义项结构变化时旧 sense_no 行删不掉。**v3 改为按 lemma 定位的差异 UPDATE/INSERT/DELETE**（words UPDATE；senses/surfaces 逐行差异；新词才 INSERT OR REPLACE）。且线上导入**不能**用本地 word_id 做 DELETE 定位——必须 `WHERE word_id IN (SELECT word_id FROM words WHERE lemma='x')`。
12. **opencode.ai zen 网关不支持 stream**：`stream:true` 会挂起直到超时（curl/非流式正常）。批量脚本（backfill_enrich 等）必须用 `stream:false` 一次性返回。另该网关**间歇性挂起**，脚本要加重试（3 次 + 退避）。
13. **增量工具两个实现坑**：① surfaces 索引反查 lemma 别用线性 find（O(N²) 卡死），建 `word_id → lemma` 反查 Map；② 分片写文件要用**追加**+全局字节计数，按 flush 批次覆盖写会只剩最后一块。

## 七、2026-08-16 数据回填（P0/P1，已完成上线）

- **目标**：音标双空 2,142 词 + freq≥10M 单义项 2,473 词，一次 LLM 生成取回 音标/完整义项/词源/register/usage_notes/同反义
- **脚本**：`scripts/backfill_enrich.ts`（`--env .env.dev2`，断点 `data/enrich.live.json`，存档 `data/enrich.json`）；`scripts/apply_enrich.ts`（重建迁移后恢复）
- **结果**：成功 4,545 词；音标双空 2,142→**0**；词源 0→4,558（10%）；register 22.5%→**27.4%**；usage_notes 28.2%→**33.7%**；高频词平均义项 2.66→3.23
- **上线**：增量 4,565 词 / 57,064 条差异语句，分片 3 个 <10MB，串行导入线上 + 本地 D1
- **残余（下次补）**：10 个音标双空顽固词（record/condon/cheeseburgers 等，多为 inflection label 不合法）+ 584 个 freq≥10M 单义项词

### 追加：错误拼写跳转 + 词族归一（同日晚些上线）

- **错误拼写跳转**（`src/lib/suggest.js` + lookup.js missing 分支）：常见错误表 ~100 条 + 美英变体规则（-ise→-ize/-our→-or/-re→-er/-yse→-yze/-ogue→-og/双写 l）+ 相邻换位；未命中时按优先级批量查 surfaces，命中 302 跳转（`/teh`→`/the`），**错误拼写不再触发 on-demand 烧 LLM**。已部署。
- **词族归一**（`scripts/normalize_word_families.ts`）：连字符变体 → 主词归并（senses 合并 + 变体 lemma → surfaces(kind=spelling) + 删变体词条）；token Jaccard ≥0.2 才归并，排除 co-op→coop（合作社/鸡笼）等 6 个语义误配。归并 **147 对**，词条 44,916→**44,769**（线上同步）。⚠️ 曾因 mergePair 参数传 p 对象（无 id 字段）导致 vid=undefined 静默 0 删除 + 误删 37 变体——已修（显式 {id} 对象）+ 从 pre-enrich.bak 重建恢复（dict_clean.db.fam-polluted.bak 留档）。
- **增量工具 v3 补充**：`export_d1_incremental.ts` 原只遍历新库 lemma，**本地删除的词不生成 DELETE**（词族归并 147 词条残留线上）——已加 wDelete 分支（旧有新无 → DELETE surfaces/senses/words 按 lemma 定位；entity_type=-1 占位行保守跳过）。

## 八、待办（按优先级）

- [ ] **gen 限流**：防止 `POST /?gen=1` 被刷爆 LLM 预算（readme ToDo 也挂着）
- [ ] 残余音标双空 5 词（mit/publ/suppl/ty/ringe，缩写/噪声词，可不管）
- [ ] 错误拼写跳转；大小写/缩写/美英差异归一化（跳转表）——拼写跳转已做（08-16），剩余"跳转表"类归一
- [ ] 词族归一：postdoc/post-doc/postdoctoral → surfaces(kind=spelling)——**连字符变体首批已做（147 对），edit-distance 词族（postdoc/postdoctoral）留后续**
- [ ] 名字/地名/乐队查询：on-demand 名字专属 prompt（谐音坑/词源/性别倾向）
- [ ] register 规范化（受控词表）与覆盖提升（现 27.4%）
- [ ] usage_notes 覆盖提升（现 33.7%）
- [x] ~~**采集 bug：词频门槛误杀整族**~~（08-16 已补采 94 词：truncate/institutionalize/aborigine 等 15 真词 + 79 常用缩写/人名；根因实为 rejects 黑名单误拒 + visited 残留，非门槛本身——45c13cb 门槛修复后仍被这两层拦截；排查见下）
- [ ] OpenSearch / tab-to-search
- [ ] 义项级 CEFR（词表每词性 level 预计算）
- [ ] 复数独立义项（data/media 等）人工复核清单

（已划掉：恢复线上 D1、部署 worker、LLM 配置、AI 探测、P0/P1 数据回填、词频门槛补采。词源 etymology 原已移除，本次回填顺带补了 10% 高频词词源。）

### 08-16 补采排查出的 4 个坑（collect.ts）

1. **rejects 黑名单误拒**：早期 AI 批量过滤把 truncate 等 15 个真词误拒入 dict.db.rejects，enqueue 直接跳过（`if (visited.has(w) || rejects.has(w)) return`）。补采前先查 rejects。
2. **visited 残留**：被拒/跳过的词仍在 state.json visited，后续 seed 补采被拦截。补采前从 visited 移除目标词。
3. **nohup 引号 bug**：`nohup bash -c "... --seed $SEEDS ..."` 外层展开后内层 bash 把 97 词按空格拆成独立参数，`--seed` 只取到第一个词。必须 `--seed \"$SEEDS\"`（内层引号保整串）。
4. **autoAudit 关时队列空即退出**：主循环 `if (totalQueued()===0 && inFlight===0) { if (argMaxCefr!==undefined || !autoAudit) break; }`——队列空立即 break，不等挂起词过滤入桶。补采 seed 时若大部分词挂起等 AI 过滤，本轮会提前结束，需再跑一轮处理 unknown 桶。

## 九、历史改动（2026-08 关键 commit）

- `24dfb8b` 脚本归位 + HANDOVER 更新（其后：回填/增量 v3 尚未 commit）
- `28d7389` 补采高频缺失词 + 清洗分类修复 + 增量导出工具
- `45c13cb` 词频门槛/入库 freq 改用家族词频
- `0da0d19` 模板化 shell、查询并行化、gen 锁、ETag
- 更早的展示层/性能优化见 git log
