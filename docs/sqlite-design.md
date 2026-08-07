# AI 英语词典 SQLite 设计

对应词条 YAML schema（`docs/ai-dictionary-schema.md`）的存储层设计。核心需求：**支持按词汇变形检索**（查 `ran` 能命中 `run`），以及短语、同义词反查。

## 数据关系

```
words 1 ── N senses          （一个词 → 多个义项，YAML entries 逐条展开）
words 1 ── N inflections     （词级变形表：ran → run）
senses 1 ── N associations   （同义词/反义词/搭配，绑定义项）
```

变形是词级数据（同一词性的所有义项共用一套变形），存 `inflections`；同义词/反义词/搭配是义项级数据，存 `associations`。

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

CREATE TABLE inflections (
  id      INTEGER PRIMARY KEY,
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  form    TEXT NOT NULL COLLATE NOCASE,
  label   TEXT NOT NULL CHECK (label IN
          ('plural','third_person_singular','present_participle',
           'past','past_participle','comparative','superlative')),
  UNIQUE (word_id, form, label)
);
CREATE INDEX idx_inflections_form ON inflections (form COLLATE NOCASE);

CREATE TABLE associations (
  id       INTEGER PRIMARY KEY,
  sense_id INTEGER NOT NULL REFERENCES senses(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('synonym','antonym','collocation')),
  text     TEXT NOT NULL,
  UNIQUE (sense_id, kind, text)
);
CREATE INDEX idx_associations_sense ON associations (sense_id);

-- 全文检索（模糊/子串），trigram 支持部分输入与短语
CREATE VIRTUAL TABLE search_fts USING fts5(
  surface,
  word_id  UNINDEXED,
  sense_id UNINDEXED,
  kind     UNINDEXED,   -- lemma | inflection | pattern | synonym | antonym | definition | example
  tokenize = 'trigram'
);
```

## 检索设计

### 1. 词形精确检索（核心需求）：`ran` → `run`

```sql
SELECT DISTINCT w.id, w.lemma, w.phonetic_uk
FROM inflections i
JOIN words w ON w.id = i.word_id
WHERE i.form = 'ran';
```

走 `idx_inflections_form` 索引，大小写不敏感。这是词形检索的主路径。

### 2. 原形检索：`run` → 词条 + 全部义项

```sql
SELECT s.sense_no, s.pos, s.pattern, s.def_en, s.def_zh
FROM words w JOIN senses s ON s.word_id = w.id
WHERE w.lemma = 'run'
ORDER BY s.sense_no;
```

### 3. 短语检索：`run into`（含变形 `ran into`）

应用层两步：先用 inflections 把查询词还原成候选 lemma 集，再按模式匹配：

```sql
-- ① 词形还原：ran into → 候选 lemma: run
SELECT DISTINCT w.id, w.lemma FROM inflections i JOIN words w ON w.id = i.word_id WHERE i.form = 'ran';

-- ② 对每个候选 lemma，短语模式匹配
SELECT s.pattern, s.def_zh, s.example_en, s.example_zh
FROM senses s WHERE s.word_id = ? AND s.pos IN ('idiom','phrase')
AND s.pattern LIKE '%run into%';
```

pattern 必须用 base form（`run into sb.` 而非 `ran into sb.`），这一步才能成立。

### 4. 模糊/子串检索：`runn`、`run in`（FTS5 trigram）

```sql
SELECT w.id, w.lemma
FROM search_fts f JOIN words w ON w.id = f.word_id
WHERE search_fts MATCH '"runn"'
GROUP BY w.id;
```

FTS 索引内容（写入时同步）：lemma、每个变形、pattern、def_en、同义词/反义词、搭配、例句。`kind` 用于区分命中来源。

### 5. 同义词反查：`sprint` → `run`

```sql
SELECT DISTINCT w.id, w.lemma
FROM associations a
JOIN senses s ON s.id = a.sense_id
JOIN words w ON w.id = s.word_id
WHERE a.kind = 'synonym' AND a.text = 'sprint';
```

## YAML → SQLite 字段映射

| YAML | 表 |
|---|---|
| `word` / `phonetic_uk` / `phonetic_us` | words |
| `inflections[]` | inflections（form, label） |
| `entries[]`（pos/pattern/def_en/def_zh/example_en/example_zh/register/usage_notes） | senses（sense_no = 输出顺序） |
| `entries[].synonyms` | associations(kind='synonym') |
| `entries[].antonyms` | associations(kind='antonym') |
| `entries[].collocations` | associations(kind='collocation') |

## 写入流程

1. 按 schema 文档的校验规则解析、校验 YAML，失败重试。
2. 单事务内**整词替换**（幂等，重生成友好）：
   - UPSERT `words`（lemma 冲突则 UPDATE，保留 id）
   - DELETE 该词的 senses / inflections / associations / FTS 行
   - INSERT 全部新行 + 同步 FTS
3. 校对通过后 `status`：draft → reviewed（published 可选）。

## 已知取舍

- **trigram 需 ≥ 3 字符**：`go` 这类 2 字符词的子串搜索不命中 FTS，由 inflections 精确匹配兜底；如后续需要可再加一个 unicode61 分词列。
- **FTS 一致性**：由写入流程在应用层同步（同一事务），不建触发器，词典规模下足够。
- **大小写**：lemma / form 统一 `COLLATE NOCASE`，`UNIQUE` 约束亦不区分大小写。
- **词级与义项级字段分离**：变形存词级（避免逐义项重复），同义/反义/搭配存义项级（绑定义项语义）。

## 待定问题

- 是否保留多版本文档（revision）以支持"AI 重生成 vs 人工校对"的差异回滚。
- 检索结果是否需要按词频排序（模型词频不可信，暂不引入）。
