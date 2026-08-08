# 数据清洗方案：dict.db → dict_clean.db

> 状态：方案稿 v2（2026-08-08）。采集器预计 62,000 词收尾（58.5k 已入库）。
> 目标：把源库只读迁移清洗到新库，分类打标不硬删，表结构面向线上服务重新设计。
> v2 变更：① terms/aliases/names 合并为一张 surfaces 表；② 外语词不再一刀切 junk，外源词成为正式收录（多语言视角）；③ 命名实体走「转正」机制，为名字/乐队/专辑查询留种子。

## 〇、现状盘点（只读分析，58,030 词条）

| 问题类别 | 数量 | 占比 | 样例 | 处置 |
|---|---|---|---|---|
| 屈折形式独立成词条 | **16,968** | 29% | ate→eat, faster→fast, went→go, kilometers→kilometer | 归并到原形 |
| 词表外词条 | 12,399 | 21% | 其中长度≥8 有 9,470 | AI 分类 |
| ├ 词表外普通形态 | 7,051 | 12% | **抽样几乎全是外语词**（abandonar/abbiamo/abierto，西/意/法） | AI 分档：流行外源词收录 / 纯外语归档 |
| ├ 连字符词 | 5,323 | 9% | well-being（真词）vs two-for-one（临时组合） | 词表内留，词表外 AI 复核 |
| ├ 短词≤4 词表外 | 355 | — | dvd/suv/pcr（缩写）、meme/blog（真词）、kx（字母串） | AI 复核 |
| 撇号词 | 25 | — | we've / doesn't / plumber's | 归档（成分词独立存在） |
| 单字母（非 a/i） | 4 | — | s / b / p / c | 归档 |
| 音标双空 | 5,855 | 10% | — | 保留 + 标记，on-demand 补 |
| 变形行缺失 | ~33k 词 | 57% | — | 词表 formsOf 再补一轮 |
| cefr 为空 | 3,650 | 6.3% | — | 词表 backfill 已做，剩余 AI 估计 |

辅助数据：rejects 黑名单 4,761 条（AI 批量过滤积累）；词表 `word_cefr_minified.db` 17.2 万词，lemma 归原链接 5.5 万条（映射质量已验证：ate→eat、went→go 可靠）。

**根因**：collect.ts 的过滤只作用于入队阶段；早期无规则时采入的噪声、AI 批量过滤的 yes-man 效应（混合批拒绝 0，纯垃圾批拒绝 89%）把垃圾放行入库。**自洽系统里垃圾会繁殖**——垃圾词条会引用更多垃圾词，必须在上线前清掉。

## 一、设计原则

1. **新库迁移，源库只读**。dict.db 一字不动（留底），清洗产物写 dict_clean.db。可随时对比、重跑。
2. **清洗 = 分类打标 + 选择性迁移**，不做原地删除。每个词留下 decision 记录（clean_log），可回滚可审计。
3. **本地规则优先**（零成本、确定性、可解释），AI 只兜底规则判不了的（外源词/人名/品牌/临时组合）。
4. **每类一步、一步一备份**。破坏性批量操作前先 cp 备份（沿用 state.json.bak 先例）。
5. **管线参数化**：清洗脚本吃源库路径、产物库路径、干跑（--dry-run）模式，可反复重跑。
6. **「噪音」的重新定义**：只有**对英语学习者无价值**的词才归档（纯外语长尾、临时组合、拼写错误）。流行文化里常见的外语词（gracias/amigo/despacito）、人名地名乐队专辑（metallica/saratoga）、常用缩写（dvd），都是当代英语使用者会**真的去查**的东西——传统词典 404 的地方，正是我们的差异化。

## 二、分类体系

### 规则层（确定性，零 API 成本）

| 标签 | 判定 | 去向 |
|---|---|---|
| `inflection` | 词表 lemma 归原后 ≠ 自身（lemmaOf） | 归并到原形，写 surfaces(kind=inflection) |
| `apostrophe` | 含 `'` | 归档（成分词独立成条） |
| `single_letter` | 长度 1 且非 a/i | 归档 |
| `hyphen_in_list` | 含 `-` 且词表收录 | 保留 |
| `short_abbr` | 长度≤4 且词表外 | AI 复核 |
| `outside` | 词表外（其余） | AI 分类 |
| `phonetics_missing` | 音标双空 | 保留 + 标记 |
| `inflection_missing` | 无任何 inflection 行 | 保留 + 标记（迁移时用词表 formsOf 补） |

### AI 层（兜底，多分类而非二选一）

输入：`outside` + `short_abbr` + 词表外连字符词。每词给一个标签：

- `keep` 真英语词（含已被英语吸收的归化借词 cafe/sushi/taco、常用缩写 ok/tv/dvd）
- `foreign_common` **流行外源词**（gracias/amigo/bratwurst/ramen/bonjour：英语环境真实可见、学习者会查）→ 收录为外源词条（words.lang='es' 等，见 §四）
- `foreign_rare` 纯外语长尾（abandonar/abbiamo/abierto 这类西/意语变位与生僻词）→ 归档（clean_log 记录，不丢）
- `name` 人名/地名/品牌/乐队/专辑/作品（fbi/mozart/metallica/despacito）→ 命名实体种子，走转正机制（§四 surfaces）
- `abbr` 缩写/首字母词 → 常用缩写收录（words.kind='abbr'），字母串归档
- `coined` 临时组合/派生（two-for-one、electron-withdrawing）→ 归档
- `misspelling` 拼写错误 → 归档

**对抗 yes-man 效应的三个改进**（文档「混合批 yes-man」的落地）：
1. **按类别分批**：外源词候选、短词、连字符分开成批，不与好词混批——纯垃圾批的拒绝率高得多；
2. **多分类替代 keep/skip 二选一**：模型必须给每词选一个标签，不能整批放行；
3. **抽样复核**：每批抽 10% 人工（或二次模型）核对，标签不一致率 >5% 则该批重做。

## 三、清洗管线（4 步）

```
Step 0  前置         等采集器停 → cp data/dict.db data/dict.db.orig
Step 1  规则分类     src/clean_classify.ts（只读 dict.db）→ 分类清单落盘
Step 2  AI 复核      src/clean_ai.ts（只处理 Step 1 的 outside/short_abbr/连字符，多分类+分档）
Step 3  迁移建库     src/clean_migrate.ts → dict_clean.db（新 schema：surfaces 合并 + 归并 + 转正）
Step 4  验收         src/clean_audit.ts（新旧对比：词数/残留率/自洽/变形覆盖）
```

- Step 1/2 产出物是**分类清单**（词 → 标签 + 理由），写 `data/clean_tags.json`（或 clean.db 一张表）。
- Step 3 只按清单迁移，可 `--dry-run` 先出迁移预览。
- 每步幂等可重跑；Step 2 失败不影响 Step 1/3 的重放。

## 四、新库表结构（dict_clean.db DDL 草案）

### 核心设计决策

1. **surfaces 一表通吃**：terms/aliases/names 本质同构——都是「表面形式 → 语义目标」的映射（surface → word_id/sense_id）。合并后 lookup 只查一张表、排序一次完成、自洽检查 = surfaces 全表。
2. **命名实体转正机制**：人名/乐队等先以 `word_id IS NULL` 的 surfaces 行存在（种子），on-demand 生成内容后建 words 行并 UPDATE word_id——一行更新完成「名字种子 → 名字词条」的升级，不丢数据。
3. **外源词正式收录**：words.lang 标注来源语言（默认 en），半归化流行外源词收为正常词条，释义照旧 _zh/_en 双语。

```sql
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- 词条主表：真英语词 + 常用缩写 + 已转正的命名实体词条
CREATE TABLE words (
  id INTEGER PRIMARY KEY,
  lemma TEXT NOT NULL COLLATE NOCASE,
  variant INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'common',     -- common | abbr（dvd/url） | name（已转正命名实体）
  lang TEXT NOT NULL DEFAULT 'en',         -- 来源语言 ISO 639-1：en/es/fr/it/de/zh/ja…（§五多语言）
  cefr TEXT, cefr_score REAL, freq INTEGER,   -- 权威词表优先，AI 估计回退
  phonetic_uk TEXT, phonetic_us TEXT,
  other_notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft',    -- draft | reviewed（校对流程起点）
  model TEXT, raw_yaml TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lemma, variant)
);

-- 一切「可查表面」：lemma / 屈折归并 / 词族变体 / 同反义搭配 / 命名实体种子
CREATE TABLE surfaces (
  id INTEGER PRIMARY KEY,
  surface TEXT NOT NULL COLLATE NOCASE,
  word_id INTEGER REFERENCES words(id) ON DELETE CASCADE,   -- NULL = 命名实体种子（未转正）
  sense_id INTEGER REFERENCES senses(id) ON DELETE CASCADE, -- NULL = 词级
  kind TEXT NOT NULL,   -- lemma|inflection|synonym|antonym|collocation|variant|spelling
                        -- |given_name|surname|place|brand|band|work|ethnic|title
  label TEXT,           -- 变形标签（plural/past）/ 名字性别 / 变体说明
  note TEXT,            -- 命名实体词源等说明（人名词典前的内容占位）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (surface, COALESCE(word_id,0), COALESCE(sense_id,0), kind)  -- COALESCE 补 NULL 唯一性
);
CREATE INDEX idx_surfaces_surface ON surfaces (surface COLLATE NOCASE);
CREATE INDEX idx_surfaces_word ON surfaces (word_id);

CREATE TABLE senses (
  id INTEGER PRIMARY KEY,
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  sense_no INTEGER NOT NULL,
  pos TEXT NOT NULL CHECK (pos IN ('noun','verb','adjective','adverb','preposition','conjunction','pronoun','interjection','article','phrase','idiom')),
  pattern TEXT,
  def_en TEXT NOT NULL, def_zh TEXT NOT NULL,
  example_en TEXT, example_zh TEXT, register TEXT, usage_notes TEXT,
  lang TEXT,                                -- 义项级来源语言；NULL 继承 words.lang（罕见，见 §五）
  cefr_score REAL,                          -- 义项级分级（词表每词性 level 预计算，未来富矿）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (word_id, sense_no)
);

-- 清洗审计：每个词的处置记录（回滚与复盘的依据）
CREATE TABLE clean_log (
  word TEXT NOT NULL COLLATE NOCASE,
  decision TEXT NOT NULL,   -- keep | merge | archive_foreign | archive_junk | seed_name | seed_abbr
  category TEXT,            -- inflection/apostrophe/foreign_common/foreign_rare/name/...
  reason TEXT,
  target TEXT,              -- merge 时的原形 / seed 时的 surfaces 表面
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 黑名单（沿用；纯外语/拼写错误等不入库但留痕）
CREATE TABLE rejects (surface TEXT PRIMARY KEY COLLATE NOCASE, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- 库元信息：版本、迁移统计
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
```

要点：
- **words 只留真词 + 已转正命名实体**（预计 58,030 → ~4 万级），查询面小、索引热；
- **surfaces 承接全部可查表面**：屈折归并 17k、词族变体（postdoc/post-doc）、同反义搭配、命名实体种子。线上 lookup 单表命中，排序按 kind 权重（lemma > inflection > synonym/antonym/collocation > 实体种子），同层按 freq 降序；
- **命名实体种子不丢**（fbi/mozart/metallica 对齐文档三：未来名字/乐队查询种子），词条内容 on-demand 转正生成；
- **senses 加 updated_at + 义项级 cefr_score + lang（继承）**；
- **clean_log 全记录**，任何词都可查「为什么没进新库/去了哪」。

## 五、多语言：外源词是资产不是噪音

### 为什么值得收录

美国西语人口 4,000 万+，西语内容在流行文化/日常媒体里占比巨大；英语本身是历史上最大的「借词收割机」（cafe/sushi/taco/ramen/bratwurst 早就是英语词典词条）。一个当代英语学习者查 `gracias`、`amigo`、`despacito` 是**真实需求**——传统词典要么 404，要么扔进「外来语」附录。我们提供 _zh/_en 解释，词汇来源不必区分，**收录不设语言门槛，标注来源语言即可**。

### 收录三档（判定见 §二 AI 层）

| 档位 | 例 | 处理 |
|---|---|---|
| 归化借词 | taco/fiesta/sushi（词表收录） | 普通词条，lang 默认 en（已在英语词典里就是英语词） |
| 流行外源词 | gracias/amigo/bratwurst/ramen（词表外但英语环境可见） | 收为外源词条 words.lang='es'/'de' 等 |
| 纯外语长尾 | abandonar/abbiamo/abierto（西/意语变位与生僻词） | 归档 rejects，clean_log 留痕 |

### lang 字段设计（senses.lang 合适，但主字段放词级）

- **words.lang**：`TEXT NOT NULL DEFAULT 'en'`，词条来源语言。99% 情况下一个词条的语言是确定的（fiesta 是西语词，尽管被英语使用）。
- **senses.lang**：`NULL` 继承 words.lang，仅当**同一词条内不同义项来源语言不同**时显式覆盖——真实案例如 tete-a-tete（法语短语）：英语义项「私下地」+ 法语原义项「头对头」，可各标 lang。罕见但留门。
- 排序影响：lookup 命中排序时 en 优先，外源词靠后（kind 权重后按 lang 排）。
- **BFS 防扩散**：外源词条的内容生成必须约束 def_en/example_en 为英语句（可提及原词但不引入新外语词），否则西语词会链式繁殖（abandonar→aburrir→…）。系统 prompt 加规则 + 清洗迁移时校验。

### 产品视角

外源词 + 命名实体（§四转正机制）构成同一个差异化叙事：**传统老学究词典 404 的地方，我们给解释**——查 `despacito` 得到「西语歌曲名，'slowly' 的意思，2017 年 Luis Fonsi 的热门单曲…」；查 `gracias` 得到「西语'谢谢'，美国日常对话常见…」。这不是百科全书，是 language learner 视角的「当代英语环境词典」。

## 六、线上服务视角（为下一个阶段铺路）

1. **lookup 排序键**：kind 权重（lemma > inflection > synonym/antonym/collocation > 实体种子）→ lang（en 优先）→ freq 降序，单表一次排序完成。
2. **静态分片导出**：按首字母切 JSON（沿用 .dict_json/ 路径），每片含 words+senses+surfaces 紧凑结构；线上 lookup 先查本地分片，未命中走 LLM on-demand 并回写 KV。表结构即导出格式的源。
3. **自洽检查升级**：可查集合 = surfaces.surface（含命名实体种子），audit.ts 沿用。

## 七、验收指标（Step 4 对比）

| 指标 | 清洗前 | 清洗后目标 |
|---|---|---|
| 词条总数 | 58,030 | ~40k（去屈折 17k + 纯外语/临时组合） |
| 外源词条 | 0 | ≥300（foreign_common 收录） |
| 命名实体种子 | 混在词条里 | surfaces ≥2,000（given_name/surname/place/brand/band/work） |
| 垃圾残留率 | 词表外 21% | <1% |
| 变形覆盖 | 43% | ≥60%（formsOf 补齐） |
| 音标缺失 | 10% | 保留标记，on-demand 补 |
| 自洽（可查率） | 100% | 100%（audit 通过） |

## 八、遗留与后续

- **词族归一**（phd/postdoc/post-doc/postdoctoral）：本轮只做屈折归并，词族变体归一到 surfaces(kind=spelling) 是第二批（规则：同词干 edit-distance ≤2 / 连字符剥离，AI 复核）。
- **复数专用义项**：data→datum、media→medium 这类词表归原但现代英语已是独立单数词的，特例清单人工复核，默认归并但保留 clean_log 记录。
- **命名实体转正内容**（名字好不好听/谐音坑/文化禁忌、乐队名内涵）：on-demand 专属 prompt，独立于普通词条生成流程。
- **音标/变形缺口**：on-demand 架构上线后自然补齐（ensureWord 生成时带上）。
- 清洗完成后把 collect.ts 的过滤层同步升级（AI 分类沿用新标签体系），避免再采入同类垃圾。
