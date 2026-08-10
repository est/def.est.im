-- def.est.im D1 本地真实 schema
-- 来源: wrangler miniflare 本地 D1 数据库

PRAGMA foreign_keys = ON;

CREATE TABLE words (
  word_id INTEGER PRIMARY KEY,
  lemma TEXT NOT NULL COLLATE NOCASE,
  entity_type INTEGER NOT NULL DEFAULT 0,  -- 0=普通词（含缩写/外源词） 1=命名实体
  cefr TEXT,
  freq INTEGER,
  phonetic_uk TEXT, phonetic_us TEXT,
  other_notes TEXT,
  etymology TEXT
);

CREATE TABLE senses (
  word_id INTEGER NOT NULL REFERENCES words(word_id),
  sense_no INTEGER NOT NULL,
  pos TEXT NOT NULL,                       -- noun|verb|adjective|adverb|phrase|idiom|…
  pattern TEXT,
  lang_id INTEGER NOT NULL DEFAULT 0,      -- 0=en；外源词生成时标 1=es…
  def_en TEXT NOT NULL, def_zh TEXT NOT NULL,
  example_en TEXT, example_zh TEXT,
  register TEXT,                           -- formal|informal|slang|technical|…
  usage_notes TEXT,
  PRIMARY KEY (word_id, sense_no)
);

CREATE TABLE surfaces (
  word_id INTEGER NOT NULL REFERENCES words(word_id) ON DELETE CASCADE,
  surface TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL,                      -- lemma|inflection|synonym|antonym|collocation
  sense_id INTEGER NOT NULL DEFAULT 0,     -- sense_no；0=词级
  label TEXT,
  notes TEXT,
  PRIMARY KEY (word_id, surface, kind, sense_id)
) WITHOUT ROWID;

CREATE TABLE rejects (
  surface TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT                              -- ai:foreign_rare|ai:coined|ai:misspelling|…
);

-- 索引
CREATE INDEX idx_words_lemma           ON words (lemma COLLATE NOCASE);
CREATE INDEX idx_surfaces_surface_kind ON surfaces (surface, kind);
CREATE INDEX idx_senses_pattern        ON senses (pattern, pos);
