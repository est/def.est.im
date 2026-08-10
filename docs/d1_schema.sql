-- def.est.im D1 schema（由 src/export_d1.ts 的 SCHEMA 自动生成，勿手改）
-- 重新生成: bun run src/gen_d1_schema.ts

-- def.est.im D1 schema（精简版，learner 视角反推）
PRAGMA foreign_keys = ON;

CREATE TABLE words (
  word_id INTEGER PRIMARY KEY,
  lemma TEXT NOT NULL COLLATE NOCASE,
  entity_type INTEGER NOT NULL DEFAULT 0,  -- 0=普通词（含缩写/外源词）1=命名实体；未来细分 2/3…
  cefr TEXT,
  freq INTEGER,
  phonetic_uk TEXT, phonetic_us TEXT,
  other_notes TEXT,
  etymology TEXT
);
CREATE INDEX idx_words_lemma ON words (lemma COLLATE NOCASE);

CREATE TABLE senses (
  word_id INTEGER NOT NULL REFERENCES words(word_id),
  sense_no INTEGER NOT NULL,
  pos TEXT NOT NULL,
  pattern TEXT,
  lang_id INTEGER NOT NULL DEFAULT 0,      -- 来源语言：0=en；on-demand 外源词生成时标 1=es…
  def_en TEXT NOT NULL, def_zh TEXT NOT NULL,
  example_en TEXT, example_zh TEXT, register TEXT, usage_notes TEXT,
  PRIMARY KEY (word_id, sense_no)
);

CREATE TABLE surfaces (
  surface TEXT NOT NULL COLLATE NOCASE,
  word_id INTEGER NOT NULL REFERENCES words(word_id) ON DELETE CASCADE,
  sense_id INTEGER NOT NULL DEFAULT 0,      -- sense_no；0=词级（lemma/词级变形）。复合主键成员隐式 NOT NULL，NULL 不可用
  kind TEXT NOT NULL,                       -- lemma|inflection|synonym|antonym|collocation
  label TEXT,
  notes TEXT,
  PRIMARY KEY (word_id, surface, kind, sense_id)
) WITHOUT ROWID;
CREATE INDEX idx_surfaces_surface_kind ON surfaces (surface, kind);
CREATE INDEX idx_senses_pattern ON senses (pattern, pos);

CREATE TABLE rejects (
  surface TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT
);
