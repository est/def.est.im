# AI 英语词典 SQLite 设计

对应词条 YAML schema（`docs/ai-dictionary-schema.md`）的存储层设计。核心需求：**支持按词汇变形检索**（查 `ran` 命中 `run`）、同义词反查、短语检索（`ran into` → `run into sb.`）。

## 设计原则：查词表，不是搜索引擎

词典的检索形态是"输入完整词形 → 命中词条"，是**精确匹配**问题，不是全文搜索。FTS5 trigram 解决的子串匹配（`runn` 命中 `running`）用户并不需要，却引入内容同步、trigram ≥ 3 字符等一堆约束。因此：

- 所有能解析到词的字符串——**原形、变形、同义词、反义词、搭配**——本质是同一类东西，放进同一张解析表 `terms`，一个索引、一条查询路径。
- 词形还原用 `terms` 的精确匹配（`ran` → `run`），不做任何词干/模糊处理。
- 真需要"搜中文释义全文"时再加 FTS5 且只索引 def_zh，那是独立需求，不急。

## 数据关系

```
words 1 ── N senses    （一个词 → 多个义项，YAML entries 逐条展开）
words 1 ── N terms     （解析表：一切能命中该词的字符串）
senses 1 ── N terms    （义项级词条：同义词/反义词/搭配）
```

- 变形是词级（同一词性的所有义项共用一套变形），`terms.sense_id = NULL`。
- 同义词/反义词/搭配是义项级，`terms.sense_id` 指向义项。
- 同形词（tear 眼泪 / tear 撕）用 `(lemma, variant)` 区分，variant 从文件名数字后缀解析：`tear.yaml` → 0，`tear-2.yaml` → 2。

## 建表 SQL

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE words (
  id          INTEGER PRIMARY KEY,
  lemma       TEXT NOT NULL COLLATE NOCASE,
  variant     INTEGER NOT NULL DEFAULT 0,   -- 同形词序号，见文件组织约定
  cefr        TEXT,           -- A1/A2/B1/B2/C1/C2，权威词表优先，AI 估计回退
  cefr_score  REAL,           -- 权威词表连续分数（1=A1…6=C2），遍历排序用
  freq        INTEGER,        -- 权威词表语料词频（稀有词 10000 兜底），展示/二次排序用
  phonetic_uk TEXT,
  phonetic_us TEXT,
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'reviewed', 'published')),
  model       TEXT,          -- 生成该词条的模型标识
  raw_yaml    TEXT,          -- 原始 YAML 全文，审计/再生成用
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lemma, variant)
);

CREATE TABLE senses (
  id          INTEGER PRIMARY KEY,
  word_id     INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  sense_no    INTEGER NOT NULL,        -- 义项序号，保持 YAML 输出顺序
  pos         TEXT NOT NULL CHECK (pos IN
              ('noun','verb','adjective','adverb','preposition','conjunction',
               'pronoun','interjection','article','phrase','idiom')),
  pattern     TEXT,                    -- 仅 idiom/phrase：run into sb.（base form + sb./sth. 占位）
  def_en      TEXT NOT NULL,
  def_zh      TEXT NOT NULL,
  example_en  TEXT,
  example_zh  TEXT,
  register    TEXT,
  usage_notes TEXT,
  UNIQUE (word_id, sense_no)
);

CREATE TABLE terms (
  id       INTEGER PRIMARY KEY,
  word_id  INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  sense_id INTEGER REFERENCES senses(id) ON DELETE CASCADE,  -- NULL = 词级
  surface  TEXT NOT NULL COLLATE NOCASE,   -- 用户可能输入的字符串
  kind     TEXT NOT NULL CHECK (kind IN
           ('lemma','inflection','synonym','antonym','collocation')),
  label    TEXT,                           -- 仅 inflection：past / plural / ...
  UNIQUE (surface, word_id, sense_id, kind)
);
CREATE INDEX idx_terms_surface ON terms (surface COLLATE NOCASE);
```

说明：

- **lemma 也写入 terms**（kind='lemma'）：所有查词走同一条 SQL，不区分"查原形还是查变形"。双写冗余在词典规模下可忽略，换来统一代码路径。
- `label` 仅用于 UI 展示变形类型（过去式/复数…），不参与检索。
- 同一条 surface 命中多个词（如 `runs` 既是某词原形又是 run 的变形）→ 多行即可，UNIQUE 允许不同 word_id。

## 检索设计

### 三步检索算法（端到端）

1. **精确命中**：`terms.surface` 等值匹配（大小写不敏感），有结果即返回（含同形词多行）。
2. **短语还原**：未命中时，分词取首词查 terms 得候选词，再对候选词的 idiom / phrase 义项做 pattern 匹配（`ran into` → `ran`→`run` → `%run into%`）。
3. **前缀联想**：仍无结果时 `LIKE '前缀%'` 返回建议词。

### 1. 统一查词入口：`ran`、`sprint`、`run a marathon` → `run`

```sql
SELECT DISTINCT t.word_id, w.lemma, w.variant
FROM terms t JOIN words w ON w.id = t.word_id
WHERE t.surface = 'ran'
ORDER BY w.lemma, w.variant;
```

一条 SQL 覆盖原形/变形/同义/反义/搭配全部类型，走 `idx_terms_surface` 索引。

### 2. 前缀补全（输入联想）：`run` → run, running, runs...

```sql
SELECT DISTINCT t.surface
FROM terms t
WHERE t.surface LIKE 'run%'
ORDER BY t.surface
LIMIT 20;
```

`LIKE '前缀%'` 可用索引（SQLite 默认 case_sensitive_like=off 时前缀 LIKE 优化为范围扫描）。同义/反义混入联想结果可能怪异，排序策略见待定问题。

### 3. 短语检索（三步算法第 2 步）：`ran into` → `run into sb.`

短语是 multi-word 且首词可变形，不适合塞进 terms 做精确匹配。应用层两步：

```sql
-- ① 词形还原：ran → run（terms 统一入口）
SELECT DISTINCT word_id FROM terms WHERE surface = 'ran';

-- ② 对候选词做短语模式匹配
SELECT s.pattern, s.def_zh, s.example_en, s.example_zh
FROM senses s
WHERE s.word_id = ? AND s.pos IN ('idiom','phrase')
  AND s.pattern LIKE '%run into%';
```

pattern 必须用 base form（`run into sb.` 而非 `ran into sb.`），这一步才成立。短语必须挂在核心词（通常是首词）的 idiom / phrase 义项下，不单独成词——此约定由 AI 输出规则保证。

### 4. 查看词条（命中的词 → 义项）

```sql
SELECT s.sense_no, s.pos, s.pattern, s.def_en, s.def_zh, s.example_en, s.example_zh
FROM senses s WHERE s.word_id = ? ORDER BY s.sense_no;
```

## YAML → SQLite 字段映射

| YAML | 表 |
|---|---|
| `word` / `phonetic_uk` / `phonetic_us` | words（lemma 同时写入 terms，kind='lemma'） |
| `cefr` | words.cefr |
| 权威词表 `cefr_score` / `freq` | words.cefr_score / words.freq |
| 文件名 `word-N.yaml` 的 `-N` 后缀 | words.variant（无后缀为 0） |
| `inflections[]` | terms（kind='inflection', label=form） |
| `entries[]`（pos/pattern/def_en/def_zh/example_en/example_zh/register/usage_notes） | senses（sense_no = 输出顺序） |
| `entries[].synonyms` | terms（kind='synonym', sense_id 指向义项） |
| `entries[].antonyms` | terms（kind='antonym', sense_id 指向义项） |
| `entries[].collocations` | terms（kind='collocation', sense_id 指向义项） |

## 写入流程

1. 按 schema 文档的校验规则解析、校验 YAML，失败重试。
2. 单事务内**整词替换**（幂等，重生成友好）：
   - UPSERT `words`（(lemma, variant) 冲突则 UPDATE，保留 id）
   - DELETE 该词的 senses / terms
   - INSERT 全部新行（senses + terms 均由 YAML 派生）
3. 校对通过后 `status`：draft → reviewed（published 可选）。

## 已知取舍

- **SQLite UNIQUE 对 NULL 不生效**：`terms.sense_id` 为 NULL 的词级行（lemma / inflection）重复插入时 `INSERT OR IGNORE` 拦不住。ingest 必须保证词级数据只插一次（词级循环不能放在 entry 循环内）——曾因此产生重复数据，验证脚本需用**裸计数**断言（`COUNT(*)`，勿只信 `SELECT DISTINCT`）防回归。
- **放弃 FTS**：无子串匹配（`runn`）、无跨释义全文搜索——查词场景不需要；前缀联想由 `LIKE '前缀%'` 覆盖。未来若做"中文释义搜索"，加 FTS5 只索引 def_zh，成本可控。
- **lemma 双写**（words + terms）：换统一查询路径，词典规模下冗余可忽略。
- **大小写**：lemma / surface 统一 `COLLATE NOCASE`，`UNIQUE` 约束亦不区分大小写。
- **词级 vs 义项级**：变形存词级（避免逐义项重复），同义/反义/搭配存义项级（绑定义项语义），靠 `sense_id` 区分。
- **同形词 variant**：文件后缀 `-N` 即 variant 序号（N 从 1 起），首个文件不加后缀视为 0。多音词（read /tear 等）靠此区分读音与词条。

## 验证

设计已由 `src/validate.ts` 端到端验证（32 断言全部通过），覆盖：词形检索（含大小写）、同义词/反义词/搭配命中、前缀联想、短语两步链（`ran into` → `run into sb.`）、同形词双行共存、四条失败路径（bad pos / 例句不成对 / word 与文件名不一致 / cefr 非法）、围栏剥离、flow 风格检测、词级数据无重复（裸计数）。

采集器 `src/collect.ts` 已用真实模型跑通：BFS 按 **CEFR 分桶遍历**，桶内按权威词表（`data/word_cefr_minified.db`，17.2 万词）的连续分数升序（二分插入，简单词优先）；`--seed-cefr A1` 可按等级全量入队，`--max-cefr` 关卡防生僻词打转；词表另含真实语料词频（`freq`），留作展示/二次排序。并发可调（`--limit` / `COLLECT_CONCURRENCY`）、校验失败回喂重试（≤2 次）、断点续跑（data/state.json）、进度心跳（data/progress.json）。API 契约要点：必须 `stream: true` + `Accept: text/event-stream`，SSE 中只累加非空 `delta.content`（推理文本在 `reasoning_content`，需忽略）。

**采集策略**：线下预采 A1→B2（约 4.3 万词，常用词全覆盖）；C1/C2 长尾与词表未收录词按需在线生成（on-demand，管线核心 callModel/validate/ingest 可复用）。

**自洽（closure）**：词条中出现的每个英文词都应可查。采集不设停用词过滤（功能词本身是条目），`src/audit.ts` 审计未覆盖词并可 `--enqueue` 写回队列，形成"跑一批 → 审计 → 补采"闭环直到缺口为零。

## 待定问题

- 前缀联想的排序策略（按 kind 优先级：lemma > inflection > synonym > …）。
- 是否保留多版本文档（revision）以支持"AI 重生成 vs 人工校对"的差异回滚。
