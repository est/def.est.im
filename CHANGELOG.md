# Changelog

> 仅记录已上线/已完成项，待办不记。日期以 `git log` 为准，08-17/18 部分未单独 commit 的以 `HANDOVER` 记录时间为准。

## 2026-08-18

- **fix: 换行还原** `b9fa07f` — D1 `other_notes / etymology / usage_notes` 12,858 + 8,909 条字面 `\n` 还原为真实换行，`style.css` 加 `pre-wrap`，本地/线上同步，已部署

## 2026-08-17 ~ 2026-08-18 — 词源/备注/补漏义项大回填（第三轮）

- `scripts/backfill_missing.ts` — `freq≥1M` 25,816 词补 `etymology + other_notes + 漏义项`，YAML 交互、`unknown` 防幻觉不入库、断点 `missing.live.json`
- 词源 10.2% → 43.8%（高频内 69.4%），备注 41.3% → 61%（高频内 75.7%），新增义项 23,885（senses 77,692 → 101,577，补 `be in for it` 等当代习语）

## 2026-08-16

- **fix: 词形/例句/register 第二轮** — `fix_inflection_labels.ts` 538 NULL → 0；去重仅 2 对（frost/ring）；`backfill_examples.ts` 1,257 词补 1,386 例句；`normalize_register.ts` 367 → 130
- **feat: P0/P1 回填** `90c4f54` `backfill_enrich.ts` — 音标双空 2,142 + `freq≥10M` 单义项 2,473 合并回填，成功 4,545 词，音标双空→0，`register` 22.5%→27.4%，`usage_notes` 28.2%→33.7%，存档 `enrich.json`
- **feat: 拼写跳转** `4287cf0` `suggest.js` — 常见错拼 ~100 + 美英规则（-ise/-our/-re/-yse/-ogue/双写l）+ 邻位换位，`lookup.js` missing 分支 302 跳转（`/teh`→`/the`），不再触发 on-demand
- **feat: 词族归一** `90c4f54` `normalize_word_families.ts` — 连字符变体归并 147 对（Jaccard ≥0.2，排除 6 误配如 `co-op→coop`），词条 44,916 → 44,769
- **feat: 增量导出 v3** `9109069` — 废弃整词 REPLACE，改为按 `lemma` 差异 `UPDATE/INSERT/DELETE` + 删除检测（跳过 `entity_type=-1`），修 O(N²) 反查与分片覆盖写
- **feat: AI 探活** `0d94741` `GET /_ai/probe` — `Q:PING? → PONG`，SSE/非流式双探

## 2026-08-11

- **feat: 高频缺词补采** `28d7389` — 修复 `interest→inter(JJ)` 噪声归并 + 家族词频误杀，`dict.db` 60,292 → 62,026，`dict_clean.db` 重建 40,578 词
- **fix: 家族词频** `45c13cb` — `loadFamilyFreq` 全族 max 词频，采集门槛与 `freq` 入库均改 `famFreqOf`，解决 `encapsulate 527k <1M` 被 `encapsulated 1.9M` 拖累整族未采
- **fix: 清洗分类** — 仅采纳真屈折 tag（`INFLECT_TAGS`），`≥1e7` 多义词性词保留独立词条

## 2026-08-10

- **perf+sec** `0da0d19` — `shell.tpl.html` 模板化 + `new Function` 渲染堵 `</script>` 逃逸；`lookup` 三查询并行 + ETag 304；`gen` 占位锁 `entity_type=-1` + 5min 过期
- **fix: 词形** `2f72c6b` — label 为空启发式推断；`extract_etymology` `27270c4` 557 词抽取
- **style** — `Georgia` 正文、`60:40` 右栏、短语徽章/pattern 同行、虚线交互（`34d1550`/`169312d` 等 10 余次迭代）
- **chore: D1 单一真源** `84e3fbe` — `d1_schema.sql` 集中生成

## 2026-08-09

- **feat: Workers 上线** `80d72a8` — `src/index.js` SSR `GET /<word>` + assets 静态分流 + `POST /?fragment&gen` on-demand，`wrangler.toml` `def_dict` binding
- **feat: D1 精简 schema** `0c14dbf` `e8c6348` — `word_id PK + surfaces(kind,label) 复合 PK`，`surfaces` 一表通吃检索，4 分片 `d1_data_00..03.sql`
- **feat: 清洗管线打通** `128d036` → `47e30c6` — Step1 规则分类 → Step2 AI 多分类 → Step3 迁移建库 36,326 词 → Step4 验收；合并 `surfaces`、外源词/命名实体分流
- **chore** `e22b725` `a2bf986` — 退役 `.dict_json` / 旧 `index.html`，刷新 `readme` Workers/D1 架构

## 2026-08-08 及更早

- **采集管线** `1946255` → `58c87d2` — BFS 遍历 + 三层防垃圾（词频门槛/词表 lemma 归原/AI 批量黑名单 `rejects` 4,700+），`CEFR` 权威词表 `word_cefr_minified.db` 分桶排序、`--seed-cefr`/`--max-cefr` 关卡，62,000 词收尾
- **数据清洗方案** `2be5e6e` `cc1fee9` — `dict.db → dict_clean.db` 分类打标不硬删，`YAML` 铺平 schema（`ai-dictionary-schema.md`）
- **已退役** — 8,243 小中高大学词表 / `alpinejs` 练手 / Google Dictionary 尝试（见 `readme` 已勾选）
