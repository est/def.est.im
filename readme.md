# def.est.im

## About

一开始想搞 Google Dictionary 离线版；

后来觉得 Webster's 1913 好厉害，做在线版。

ChatGPT 出来之后，干脆外包给 AI 做——用 LLM 批量生成一本英汉学习者词典

[写了个 blog](https://blog.est.im/2025/stdout-12)



## 架构

2026-08 基于Cloudflare Workers重写

- **URL 即词条**：`def.est.im/<word>` 直接 SSR 词条页（`/run`、`/went`、`/run%20into`）；`/` 和 `/style.css` 走 assets 静态（`Sec-Fetch-Dest` + 后缀双分流）
- **数据在 D1**（SQLite）：精简三表 `words / senses / surfaces` + `rejects` 黑名单；surfaces 组合主键一次表读命中（D1 按 rows_read 计费，单次查词 ~30 行）
- **自洽随点击闭合**：未收录词 → 占位页 → `POST` on-demand 生成 → 入库回填（rejects 命中直接 404，不烧 API）
- **客户端渐进增强**：词条内可点词 → `POST` 返回服务端 HTML 片段局部替换（无 Shadow DOM，模板只在服务端一份）
- 命名实体词条（人名/地名/品牌）走 entity 模板，词源/趣闻在 `words.etymology` 展示

## 数据

目前约：

- 36,326 词条
- 60,280 义项
- 267,834 surfaces

## ToDo

- [X] 批量采集：BFS 遍历 + 三层防垃圾（词频门槛 / 词表归原 / AI 批量过滤），62,000 词收尾
- [X] 数据清洗迁移：分类打标不硬删 → dict_clean.db（surfaces 一表通吃检索）
- [X] 数据上线：D1 精简 schema 导入（word_id 主键 + 组合主键 surfaces）
- [X] 词源抽取：other_notes 中模型写的词源/趣闻拆出 etymology（557 词）
- [X] Workers SSR 词条页：URL 即词条 + 静态 assets 分流
- [X] on-demand 生成：占位页 + 异步回填 + rejects 黑名单 404
- [X] 客户端渐进增强：fragment 局部替换 + pushState/后退恢复
- [x] 8243 个小中高大学用词（旧 .dict_json，已退役）
- [x] alpinejs 练手（旧版页面，已退役）
- [x] 调通 openrouter/CORS/SSE 流式契约
- [ ] 部署上线：`wrangler deploy` + LLM_* secrets（未执行）
- [ ] 错误拼写跳转；大小写/缩写/美英差异归一化（跳转表）
- [ ] 词族归一：postdoc/post-doc/postdoctoral → surfaces(kind=spelling)
- [ ] 名字/地名/乐队查询：on-demand 名字专属 prompt（谐音坑/词源/性别倾向）
- [ ] register 规范化（受控词表）与覆盖提升
- [ ] 限流，防止 API 爆掉
- [ ] **采集 bug：词频门槛误杀整族**。`enqueue()` 用原形自身 freq 判定 `SEED_FREQ_MIN=1e6`，但屈折形式词频可能更高（encapsulated 1.9M / encapsulate 527k → 整族不采）。已确认 919 个 lemma 因此缺失。修复：门槛改用家族 max freq（`formsOf` 全族扫描），或改排序不跳过。补采需评估 API 成本
- [ ] 词形 label 数据缺口：1542 条 null 已修复 1021，剩 521 为词表噪声（人名/派生词误标 inflection），渲染兜底「词形」；情态动词过去式（would/could/should/might）词表无标注，渲染靠规则推断
- [ ] OpenSearch / tab-to-search
- [ ] 义项级 CEFR（词表每词性 level 预计算）
- [ ] 复数独立义项（data/media 等）人工复核清单

## 开发命令

```bash
bun run src/collect.ts --max N --limit 15      # 采集（续跑断点）
bun run src/validate.ts                        # 回归（34 断言）
bun run src/audit.ts                           # 自洽缺口
bun run src/clean_classify.ts                  # 清洗 Step1 规则分类
bun run src/clean_ai.ts                        # 清洗 Step2 AI 多分类
bun run src/clean_migrate.ts                   # 迁移建库 dict_clean.db
bun run src/export_d1.ts                       # 导出 D1 SQL（重建线上库）
wrangler dev                                   # 本地开发（连本地 D1 引擎）
wrangler deploy                                # 部署
```

## Credits

- ❌ Google Dictionary API
- DeepSeek R1 / DeepSeek V4 Flash (free) via OpenRouter / opencode
- 权威词表单 `word_cefr_minified.db`

## License

BSD
