# 下一阶段：数据清洗与遗留问题

> 批量采集阶段已完成（55k+ 词条，A1-C1 ≥100万 词表词收齐，C2 走 on-demand）。
> 本文档汇总所有遗留问题，作为下一阶段（数据清洗 + 人名地名专题）的交接清单。

## 〇、背景与现状（给接手者 30 秒版）

**在做什么**：用 LLM 批量生成一本英汉学习者词典，核心追求是**自洽（closure）**——词条里出现的每个英文词都能点击查到，词典是闭合的迷宫而不是通向虚空的路。

**为什么是 YAML 而不是 JSON**：LLM 是语言模型不是序列化器，JSON 引号转义反复翻车；YAML 的 block scalar（`|`）让释义/例句里的引号冒号免转义。核心经验："schema 越平，模型越听话"——一条 entry = 词性+义项+例句平铺，整个 schema 零方括号，词性用全称不用缩写。

**存储**：SQLite 三表——`words`（词头，含权威 cefr/cefr_score/freq）、`senses`（义项）、`terms`（一切能解析到词的字符串：原形/变形/同反义/搭配，一条 `WHERE surface=?` 命中所有类型）。**拒绝 FTS**：查词表不是搜索引擎，精确匹配 + 索引就够了。

**遍历与防垃圾**：BFS 从词条释义/例句/同反义提取新词，按权威 CEFR 词表（`data/word_cefr_minified.db`，17.2 万词，level 连续分 1=A1…6=C2 + 真实语料词频）分桶排序。三层防线：**频率门槛**（词频 <100万 一律跳过）、**词表 lemma 归原**（meaner→mean，屈折形式由原形词条覆盖）、**AI 批量过滤**（人名/缩写/外语词进 `rejects` 黑名单，已 4,700+ 条）。

**当前状态**：55k+ 词条已入库；A1-C1 的 ≥100万 词表词收齐（反向检查补入 1,991 个漏网词）；C2 长尾（12 万词）明确走 on-demand——在线查词时实时生成，不预存。收尾采集以预算 62,000 自动停止。

**API 契约**：网关必须 `stream:true` + `Accept:text/event-stream`（非流式返回空 body）；SSE 只累加非空 `delta.content`，推理文本在 `reasoning_content` 需忽略。

**工程约定**：
- **破坏性操作必须先行备份**（本会话先例：`state.json.bak` / `.bak2`）
- git 有**自动提交机制**（代码改完几分钟内自动 commit，无需手动）
- 回归测试：`bun run src/validate.ts`（34 断言全过）
- 采集器：`bun run src/collect.ts --max N --limit 15 [--seed-cefr 等级]`；审计：`bun run src/audit.ts`

**下一步**：见下文数据清洗清单——先**分类盘点**（垃圾词打标、人名地名归档为"名字查询种子"），不硬删。

## 一、数据清洗清单

### 1. 已入库的垃圾词（最高优先级）

早期无过滤规则时采入的噪声，全部已入库，需按类别清洗（**必须先备份 dict.db 再删**）：

| 类别 | 示例 | 判定方式 |
|---|---|---|
| 收缩形式 | we've / she's / won't / doesn't | 含撇号 |
| 派生/动词化 | fruited / yellowed / homed / lunched / papered | 词表 lemma 链接可判（归原后≠自身） |
| 单字母 | s / p / b / m / t... | 长度=1 且不在 {a, i} |
| 人名/地名 | fbi / mozart / saratoga / brittany / robert / richard / wilson / davis | 人工列表 + 常见姓氏表 |
| 缩写 | adhd / adj / adv / ac / ibid / cf / ave / soc / ny | 长度≤4 且不在常用词白名单 |
| 外语词 | bonjour / der / la / justificante / piombare | AI 判定 / 语言检测库 |
| 连字符复合词 | a-levels / about-faced / two-for-one / electron-withdrawing | 词表收录则留，否则标记 |
| 词缀 | pre / anti / inter | 词表 lemma 无独立条目 |

参考数据：`rejects` 表已有 4,700+ 条黑名单，清洗脚本可复用其判定逻辑。

### 2. 存量音标缺失

- **3,620 个词双空音标**（12%）——新 prompt 已防，存量需 on-demand 重新生成或人工补
- 同形词双读音（tear 眼泪/撕）词级单音标装不下——等 on-demand 拆词

### 3. 存量变形缺失

- ~60% 词无变形行——词表 lemma 链接已补（backfill + completeInflections），剩余缺口靠新 prompt
- 清洗时可用词表 formsOf 再补一轮

### 4. 分级数据

- cefr_score/freq 覆盖 93%（backfill 后），词表外词无权威分级（AI 估计兜底）
- **义项级 CEFR 是未来富矿**：词表每词性独立 level+freq，可做义项级标注（run 动词/名词分别标级）

### 5. 其它数据问题

- `status` 全为 draft：无校对/发布流程（on-demand 上线前需设计）
- register（13%）/ usage_notes（23%）覆盖率低——可针对性补采
- 缺 `updated_at` on senses/terms（再生成审计不便）

## 二、架构遗留

### 1. on-demand 架构（下一阶段主线）

- **C2 长尾 + 词表外词**：查词时实时生成，`callModel/validate/ingest` 是可复用的核心
- 需要 `ensureWord(word)` 服务端函数：命中缓存返回，未命中生成+校验+入库+返回
- **自洽随点击闭合**：点生僻词 → 现场生成 → 词典越用越完整
- 同形词拆词（tear/read/lead/wind）在 on-demand 下免费：一次生成两个 variant，复用 sense 绑定

### 2. 过滤器缺陷（已观察到）

- **混合批 yes-man 效应**：纯垃圾批拒绝率 89%，好词+垃圾混合批全放行（wilson/ibid/pre/anti 被采）
- 改进方向：可疑词（短词/疑似缩写/词表外）单独分批，提高拒绝率

### 3. 检索排序（P2 待办）

- `lookup()` 多命中按 lemma 字母序，应按相关度：lemma > inflection > synonym/antonym/collocation
- 前缀联想排序策略未定（词频可作排序键）

### 4. 已搁置的设计

- **variant 批量管线（B 方向）**：同形词拆词暂不做批量，等 on-demand
- 词形归一（feelings→feeling）已做，但"复数专用义项"（feelings=感情）是否保留独立词条待定

## 三、人名地名专题（下一阶段思考）

**需求是真实的**：有人想知道一个名字起得好不好、寓意如何、有没有坑（谐音/歧义/文化禁忌），这本质也是"查词典"——查的是人名词典。

方向探讨：
1. **人名词典**：名字含义（Hebrew/Greek 词源）、流行度趋势、性别倾向、著名人物联想、谐音风险（中文语境：中英谐音）、文化禁忌
2. **地名词典**：地名含义、发音（尤其是非英语地名）、国家/民族名词（the English 等）
3. **数据来源**：词表里的 NNP 词条（fbi/mozart/saratoga 等"垃圾"其实是人名地名的种子！）——**清洗阶段不该删，应该分桶归档**
4. **实现**：on-demand 专属 prompt（名字/地名的生成规则不同于普通词条），独立表或 `words.pos = 'name'` 分类

**关键洞察**：清洗阶段对"人名地名"不是简单删除，而是**分类归档**——它们从"普通词条噪声"转为"名字/地名查询的种子数据"。

## 四、数据安全原则（清洗必须遵守）

1. **先备份再删**：`dict.db` / `state.json` 操作前 cp 备份（本次会话已有 state.json.bak / .bak2 先例）
2. **清洗走标记而非硬删**：优先 `status='junk'` 或移入 `rejects`，保留可恢复性
3. **按类分批清洗**：每类一个脚本、一次备份、可回滚
4. 删除词条的关联数据（senses/terms）需 CASCADE 或显式清理，防孤儿行

---

## 参考命令与文件

- 采集器：`bun run src/collect.ts --max N --limit 15`
- 审计：`bun run src/audit.ts`（自洽缺口）
- 权威词表：`data/word_cefr_minified.db`（17.2 万词，level 连续分 + 真实词频）
- 黑名单：`data/dict.db` 的 `rejects` 表（4,700+ 条）
- 主设计文档：`docs/ai-dictionary-schema.md`、`docs/sqlite-design.md`
- 经验博客：`docs/blog-ai-dictionary.md`
