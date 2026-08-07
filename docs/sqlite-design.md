# AI 英语词典 SQLite 设计

对应词条 YAML schema（`docs/ai-dictionary-schema.md`）的存储层设计。核心需求：**支持按词汇变形检索**（查 `ran` 能命中 `run`），以及同义词反查、短语检索。

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

## 建表 SQL

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE words (
  id          INTEGER PRIMARY KEY,
  lemma       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  phonetic_uk TEXT,
  phonetic_us TEXT,
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft', 'reviewed', 'published')),
  model       TEXT,          -- 生成该词条的模型标识
  raw_yaml    TEXT,          -- 原始 YAML 全文，审计/再生成用
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE senses (
  id          INTEGER PRIMARY KEY,
  word_id     INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  sense_no    INTEGER NOT NULL,        -- 义项序号，保持 YAML 输出顺序
  pos         TEXT NOT NULL CHECK (pos IN
              ('n','v','adj','adv','prep','conj','pron','interj','article','phrase','idiom')),
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

### 1. 统一查词入口：`ran`、`sprint`、`run a marathon` → `run`

```sql
SELECT DISTINCT t.word_id, w.lemma
FROM terms t JOIN words w ON w.id = t.word_id
WHERE t.surface = 'ran';
```

一条 SQL 覆盖原形/变形/同义/反义/搭配全部类型，走 `idx_terms_surface` 索引。

### 2. 前缀补全（输入联想）：`run` → run, running, runs...

```sql
SELECT DISTINCT t.surface
FROM terms t
WHERE t.surface LIKE 'run%'
LIMIT 20;
```

`LIKE '前缀%'` 可用索引（SQLite 默认 case_sensitive_like=off 时前缀 LIKE 优化为范围扫描）。同义/反义混入联想结果可能怪异，排序策略见待定问题。

### 3. 短语检索：`ran into` → `run into sb.`

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

pattern 必须用 base form（`run into sb.` 而非 `ran into sb.`），这一步才成立。

### 4. 查看词条（命中的词 → 义项）

```sql
SELECT s.sense_no, s.pos, s.pattern, s.def_en, s.def_zh, s.example_en, s.example_zh
FROM senses s WHERE s.word_id = ? ORDER BY s.sense_no;
```

## YAML → SQLite 字段映射

| YAML | 表 |
|---|---|
| `word` / `phonetic_uk` / `phonetic_us` | words（lemma 同时写入 terms，kind='lemma'） |
| `inflections[]` | terms（kind='inflection', label=form） |
| `entries[]`（pos/pattern/def_en/def_zh/example_en/example_zh/register/usage_notes） | senses（sense_no = 输出顺序） |
| `entries[].synonyms` | terms（kind='synonym', sense_id 指向义项） |
| `entries[].antonyms` | terms（kind='antonym', sense_id 指向义项） |
| `entries[].collocations` | terms（kind='collocation', sense_id 指向义项） |

## 写入流程

1. 按 schema 文档的校验规则解析、校验 YAML，失败重试。
2. 单事务内**整词替换**（幂等，重生成友好）：
   - UPSERT `words`（lemma 冲突则 UPDATE，保留 id）
   - DELETE 该词的 senses / terms
   - INSERT 全部新行（senses + terms 均由 YAML 派生）
3. 校对通过后 `status`：draft → reviewed（published 可选）。

## 已知取舍

- **放弃 FTS**：无子串匹配（`runn`）、无跨释义全文搜索——查词场景不需要；前缀联想由 `LIKE '前缀%'` 覆盖。未来若做"中文释义搜索"，加 FTS5 只索引 def_zh，成本可控。
- **lemma 双写**（words + terms）：换统一查询路径，词典规模下冗余可忽略。
- **大小写**：lemma / surface 统一 `COLLATE NOCASE`，`UNIQUE` 约束亦不区分大小写。
- **词级 vs 义项级**：变形存词级（避免逐义项重复），同义/反义/搭配存义项级（绑定义项语义），靠 `sense_id` 区分。

## 待定问题

- 前缀联想的排序策略（按 kind 优先级：lemma > inflection > synonym > …）。
- 是否保留多版本文档（revision）以支持"AI 重生成 vs 人工校对"的差异回滚。
