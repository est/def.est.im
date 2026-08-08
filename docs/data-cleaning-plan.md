# 数据清洗方案：dict.db → dict_clean.db

> 状态：建议稿（2026-08-08）。采集器预计 62,000 词收尾（58.5k 已入库）。
> 目标：把源库只读迁移清洗到新库，分类打标不硬删，表结构面向线上服务重新设计。

## 〇、现状盘点（只读分析，58,030 词条）

| 问题类别 | 数量 | 占比 | 样例 | 处置 |
|---|---|---|---|---|
| 屈折形式独立成词条 | **16,968** | 29% | ate→eat, faster→fast, went→go, kilometers→kilometer | 归并到原形 |
| 词表外词条 | 12,399 | 21% | 其中长度≥8 有 9,470 | AI 分类 |
| ├ 词表外普通形态 | 7,051 | 12% | **抽样几乎全是外语词**（abandonar/abbiamo/abierto，西/意/法） | AI 分类→junk |
| ├ 连字符词 | 5,323 | 9% | well-being（真词）vs two-for-one（临时组合） | 词表内留，词表外 AI 复核 |
| ├ 短词≤4 词表外 | 355 | — | dvd/suv/pcr（缩写）、meme/blog（真词）、kx（字母串） | AI 复核 |
| 撇号词 | 25 | — | we've / doesn't / plumber's | junk（成分词独立存在） |
| 单字母（非 a/i） | 4 | — | s / b / p / c | junk |
| 音标双空 | 5,855 | 10% | — | 保留 + 标记，on-demand 补 |
| 变形行缺失 | ~33k 词 | 57% | — | 词表 formsOf 再补一轮 |
| cefr 为空 | 3,650 | 6.3% | — | 词表 backfill 已做，剩余 AI 估计 |

辅助数据：rejects 黑名单 4,761 条（AI 批量过滤积累）；词表 `word_cefr_minified.db` 17.2 万词，lemma 归原链接 5.5 万条（映射质量已验证：ate→eat、went→go 可靠）。

**根因**：collect.ts 的过滤只作用于入队阶段；早期无规则时采入的噪声、AI 批量过滤的 yes-man 效应（混合批拒绝 0，纯垃圾批拒绝 89%）把垃圾放行入库。**自洽系统里垃圾会繁殖**——垃圾词条会引用更多垃圾词，必须在上线前清掉。

## 一、设计原则

1. **新库迁移，源库只读**。dict.db 一字不动（留底），清洗产物写 dict_clean.db。可随时对比、重跑。
2. **清洗 = 分类打标 + 选择性迁移**，不做原地删除。每个词留下 decision 记录（clean_log），可回滚可审计。
3. **本地规则优先**（零成本、确定性、可解释），AI 只兜底规则判不了的（外语/人名/品牌/临时组合）。
4. **每类一步、一步一备份**。破坏性批量操作前先 cp 备份（沿用 state.json.bak 先例）。
5. **管线参数化**：清洗脚本吃源库路径、产物库路径、干跑（--dry-run）模式，可反复重跑。

## 二、分类体系

### 规则层（确定性，零 API 成本）

| 标签 | 判定 | 去向 |
|---|---|---|
| `inflection` | 词表 lemma 归原后 ≠ 自身（lemmaOf） | 归并到原形，写 aliases |
| `apostrophe` | 含 `'` | junk（成分词独立成条） |
| `single_letter` | 长度 1 且非 a/i | junk |
| `hyphen_in_list` | 含 `-` 且词表收录 | 保留 |
| `short_abbr` | 长度≤4 且词表外 | AI 复核 |
| `outside` | 词表外（其余） | AI 分类 |
| `phonetics_missing` | 音标双空 | 保留 + 标记 |
| `inflection_missing` | 无任何 inflection 行 | 保留 + 标记（迁移时用词表 formsOf 补） |

### AI 层（兜底，多分类而非二选一）

输入：`outside` + `short_abbr` + 词表外连字符词。每词给一个标签：

- `keep` 真词（含已被英语吸收的借词 cafe/sushi、常用缩写 ok/tv）
- `foreign` 外语词（→ junk，成分词由词条或 BFS 独立覆盖）
- `name` 人名/地名/品牌/乐队/专辑（→ names 归档，不丢！）
- `abbr` 缩写/首字母词（→ junk 或按需保留，如 dvd 可保留）
- `coined` 临时组合/派生（two-for-one、electron-withdrawing → junk）
- `misspelling` 拼写错误（→ junk）

**对抗 yes-man 效应的三个改进**（文档「混合批 yes-man」的落地）：
1. **按类别分批**：外语候选、短词、连字符分开成批，不与好词混批——纯垃圾批的拒绝率高得多；
2. **多分类替代 keep/skip 二选一**：模型必须给每词选一个标签，不能整批放行；
3. **抽样复核**：每批抽 10% 人工（或二次模型）核对，标签不一致率 >5% 则该批重做。

## 三、清洗管线（4 步）

```
Step 0  前置         等采集器停 → cp data/dict.db data/dict.db.orig
Step 1  规则分类     src/clean_classify.ts（只读 dict.db）→ 分类清单落盘
Step 2  AI 复核      src/clean_ai.ts（只处理 Step 1 的 outside/short_abbr/连字符）
Step 3  迁移建库     src/clean_migrate.ts → dict_clean.db（新 schema + aliases + names）
Step 4  验收         src/clean_audit.ts（新旧对比：词数/残留率/自洽/变形覆盖）
```

- Step 1/2 产出物是**分类清单**（词 → 标签 + 理由），写 `data/clean_tags.json`（或 clean.db 一张表）。
- Step 3 只按清单迁移，可 `--dry-run` 先出迁移预览。
- 每步幂等可重跑；Step 2 失败不影响 Step 1/3 的重放。

## 四、新库表结构（dict_clean.db DDL 草案）

线上服务形态：lookup 精确命中（lemma/aliases/terms 三级）+ 静态分片导出。索引与排序为「查词即所得」服务。

```sql
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- 词条主表：只保留真词（common）。屈折/垃圾/外语不进此表。
CREATE TABLE words (
  id INTEGER PRIMARY KEY,
  lemma TEXT NOT NULL COLLATE NOCASE,
  variant INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'common',     -- common | abbr（dvd/url 这类可保留缩写）
  cefr TEXT, cefr_score REAL, freq INTEGER,   -- 权威词表优先，AI 估计回退
  phonetic_uk TEXT, phonetic_us TEXT,
  other_notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft',    -- draft | reviewed（校对流程起点）
  model TEXT, raw_yaml TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lemma, variant)
);

-- 变体重定向：屈折归并（ate→eat）+ 词族变体（postdoc/post-doc→主词条）
-- 线上查 ate 命中此表 → 重定向到 eat 词条（或直接并入检索链）
CREATE TABLE aliases (
  surface TEXT PRIMARY KEY COLLATE NOCASE,   -- 可查的表面形式
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                        -- inflection | spelling | case | abbrev
  label TEXT,                                -- 变形标签（plural/past…）或说明
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE senses (
  id INTEGER PRIMARY KEY,
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  sense_no INTEGER NOT NULL,
  pos TEXT NOT NULL CHECK (pos IN ('noun','verb','adjective','adverb','preposition','conjunction','pronoun','interjection','article','phrase','idiom')),
  pattern TEXT,
  def_en TEXT NOT NULL, def_zh TEXT NOT NULL,
  example_en TEXT, example_zh TEXT, register TEXT, usage_notes TEXT,
  cefr_score REAL,                           -- 义项级分级（词表每词性 level 预计算，未来富矿）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (word_id, sense_no)
);

-- 词内检索链：同反义/搭配/变形（保留原设计，逐条可查）
CREATE TABLE terms (
  id INTEGER PRIMARY KEY,
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  sense_id INTEGER REFERENCES senses(id) ON DELETE CASCADE,
  surface TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('lemma','inflection','synonym','antonym','collocation')),
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (surface, word_id, sense_id, kind)
);
CREATE INDEX idx_terms_surface ON terms (surface COLLATE NOCASE);
CREATE INDEX idx_terms_word ON terms (word_id);

-- 人名/地名/品牌种子（词表 NNP 的归档地，未来人名词典的数据源）
CREATE TABLE names (
  id INTEGER PRIMARY KEY,
  surface TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL,                        -- given_name | surname | place | brand | band | work
  source_word_id INTEGER,                    -- 原词条（保留 raw_yaml/释义，不丢）
  note TEXT,
  UNIQUE (surface, kind)
);

-- 清洗审计：每个词的处置记录（回滚与复盘的依据）
CREATE TABLE clean_log (
  word TEXT NOT NULL COLLATE NOCASE,
  decision TEXT NOT NULL,                    -- keep | merge | junk | archive_name | archive_abbr
  category TEXT,                             -- inflection/apostrophe/foreign/name/...
  reason TEXT,
  target TEXT,                               -- merge 时的原形 / archive 时的 names 表面
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 黑名单（沿用）
CREATE TABLE rejects (surface TEXT PRIMARY KEY COLLATE NOCASE, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- 库元信息：版本、迁移统计
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
```

要点：
- **words 只留真词**（预计 58,030 → ~4 万级），查询面小、索引热；
- **aliases 承接全部「可查表面」**（屈折归并 17k + 词族变体 + 错拼），线上 lookup 三级命中：`words.lemma` → `aliases.surface`（重定向）→ `terms.surface`（词内检索），比现在的「terms 一锅端」快且可解释；
- **names 归档而非删除**（对齐文档三：人名地名是未来名字查询种子，fbi/mozart 不白采）；
- **senses 加 updated_at + 义项级 cefr_score**（词表每词性独立 level+freq，迁移时预计算，run 动词/名词分标级）；
- **clean_log 全记录**，任何词都可查「为什么没进新库/去了哪」。

## 五、线上服务视角（为下一个阶段铺路）

1. **lookup 排序键**：lemma > inflection > synonym/antonym/collocation，同层按 freq 降序（P2 待办的 ORDER BY 问题在新库顺手解决）。
2. **静态分片导出**：按首字母切 JSON（沿用 .dict_json/ 路径），每片含 words+senses+terms+aliases 紧凑结构；线上 lookup 先查本地分片，未命中走 LLM on-demand 并回写 KV。表结构即导出格式的源。
3. **自洽检查升级**：可查集合 = terms.surface ∪ aliases.surface ∪ words.lemma，audit.ts 沿用。

## 六、验收指标（Step 4 对比）

| 指标 | 清洗前 | 清洗后目标 |
|---|---|---|
| 词条总数 | 58,030 | ~40k（去屈折 17k + 外语/垃圾） |
| 垃圾残留率 | 词表外 21% | <1% |
| 变形覆盖 | 43% | ≥60%（formsOf 补齐） |
| 音标缺失 | 10% | 保留标记，on-demand 补 |
| 自洽（可查率） | 100% | 100%（audit 通过） |
| 人名地名归档 | 混在词条里 | names 表 ≥2,000 条种子 |

## 七、遗留与后续

- **词族归一**（phd/postdoc/post-doc/postdoctoral）：本轮只做屈折归并，词族变体归一到 aliases 是第二批（规则：同词干 edit-distance ≤2 / 连字符剥离，AI 复核）。
- **复数专用义项**：data→datum、media→medium 这类词表归原但现代英语已是独立单数词的，特例清单人工复核，默认归并但保留 clean_log 记录。
- **音标/变形缺口**：on-demand 架构上线后自然补齐（ensureWord 生成时带上）。
- 清洗完成后把 collect.ts 的过滤层同步升级（AI 分类沿用新标签体系），避免再采入同类垃圾。
