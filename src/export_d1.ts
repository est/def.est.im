// ============================================================
// D1 导出（export_d1.ts）：dict_clean.db → 精简线上 schema
//
// 产出（docs/data-cleaning-plan.md §四 + .mimocode/plans D1 v2）：
//   data/d1_schema.sql        DDL（words/senses/surfaces/rejects + 索引）
//   data/d1_data_00.sql … 03  数据分批（免费写额度 100k 行/天 → 分 4 批）
//
// 映射：
//   words.kind   → entity_type（abbr→0、common→0、name→1）
//   senses       → 加 lang_id=0（英语）
//   surfaces.sense_id → 映射为 sense_no（新 senses 无 id，按 (word_id,sense_no) 对齐）
//   rejects      → 原样（线上 on-demand 黑名单）
//
// 用法：bun run src/export_d1.ts            # 导出
//       bun run src/export_d1.ts --verify   # 导出 + 本地临时库回放验证
// ============================================================
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const SRC = join(DATA_DIR, "dict_clean.db");
const OUT_DIR = join(DATA_DIR, "d1");
const VERIFY = process.argv.includes("--verify");

if (!existsSync(SRC)) throw new Error(`找不到 ${SRC}`);
mkdirSync(OUT_DIR, { recursive: true });

const src = new Database(SRC, { readonly: true });

// ---------- DDL ----------
const SCHEMA = `-- def.est.im D1 schema（精简版，learner 视角反推）
PRAGMA foreign_keys = ON;

CREATE TABLE words (
  word_id INTEGER PRIMARY KEY,
  lemma TEXT NOT NULL COLLATE NOCASE,
  entity_type INTEGER NOT NULL DEFAULT 0,  -- 0=普通词（含缩写/外源词）1=命名实体；未来细分 2/3…
  cefr TEXT,
  freq INTEGER,
  phonetic_uk TEXT, phonetic_us TEXT,
  other_notes TEXT
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
`;

// ---------- 工具：字符串转义 ----------
const q = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  const s = String(v);
  if (s === "") return "NULL";
  return "'" + s.replace(/'/g, "''") + "'";
};

// ---------- 分批写：4 个文件，每文件 ≤ ~95k 行（免费写额度 100k/天） ----------
const BATCH_LIMIT = 95000;
const files = [0, 1, 2, 3].map((i) => join(OUT_DIR, `d1_data_${String(i).padStart(2, "0")}.sql`));
for (const f of files) writeFileSync(f, "");
let fileIdx = 0;
let fileRows = 0;

function emit(insertSql: string, n: number) {
  if (fileRows + n > BATCH_LIMIT && fileIdx < 3) {
    fileIdx++;
    fileRows = 0;
  }
  appendFileSync(files[fileIdx], insertSql);
  fileRows += n;
}

// ---------- 1. words ----------
let n = 0;
for (const w of src.query(`SELECT id, lemma, kind, cefr, freq, phonetic_uk, phonetic_us, other_notes FROM words`).all() as any[]) {
  const et = w.kind === "name" ? 1 : 0; // abbr/common → 0
  const row = [String(w.id), q(w.lemma), String(et), q(w.cefr), w.freq ?? "NULL", q(w.phonetic_uk), q(w.phonetic_us), q(w.other_notes)];
  emit(`INSERT INTO words (word_id,lemma,entity_type,cefr,freq,phonetic_uk,phonetic_us,other_notes) VALUES (${row.join(",")});\n`, 1);
  n++;
}
console.log(`words: ${n}`);

// ---------- 2. senses ----------
n = 0;
for (const s of src.query(`SELECT word_id, sense_no, pos, pattern, def_en, def_zh, example_en, example_zh, register, usage_notes FROM senses`).all() as any[]) {
  const row = [String(s.word_id), String(s.sense_no), q(s.pos), q(s.pattern), "0", q(s.def_en), q(s.def_zh), q(s.example_en), q(s.example_zh), q(s.register), q(s.usage_notes)];
  emit(`INSERT INTO senses (word_id,sense_no,pos,pattern,lang_id,def_en,def_zh,example_en,example_zh,register,usage_notes) VALUES (${row.join(",")});\n`, 1);
  n++;
}
console.log(`senses: ${n}`);

// ---------- 3. surfaces（sense_id → sense_no） ----------
n = 0;
const rows = src.query(`
  SELECT s.surface, s.word_id, s.kind, s.label,
         COALESCE(se.sense_no, NULL) AS sense_no
  FROM surfaces s LEFT JOIN senses se ON se.id = s.sense_id AND se.word_id = s.word_id
`).all() as any[];
const lines: string[] = [];
for (const s of rows) {
  lines.push(`INSERT INTO surfaces (surface,word_id,sense_id,kind,label,notes) VALUES (${q(s.surface)},${s.word_id},${s.sense_no ?? 0},${q(s.kind)},${q(s.label)},NULL);\n`);
  if (lines.length >= 800) { emit(lines.join(""), lines.length); lines.length = 0; n += 800; }
}
if (lines.length) { emit(lines.join(""), lines.length); n += lines.length; }
console.log(`surfaces: ${rows.length}`);

// ---------- 4. rejects ----------
n = 0;
for (const r of src.query(`SELECT surface, reason FROM rejects`).all() as any[]) {
  emit(`INSERT INTO rejects (surface,reason) VALUES (${q(r.surface)},${q(r.reason)});\n`, 1);
  n++;
}
console.log(`rejects: ${n}`);

// ---------- 5. schema 文件 ----------
writeFileSync(join(OUT_DIR, "d1_schema.sql"), SCHEMA);

// ---------- 5. schema 文件 ----------
writeFileSync(join(OUT_DIR, "d1_schema.sql"), SCHEMA);

src.close();
console.log(`\n导出完成 → ${OUT_DIR}/（d1_schema.sql + d1_data_00..03.sql）`);

// ---------- 6. 本地回放验证 ----------
if (VERIFY) {
  rmSync(join(DATA_DIR, "d1_check.db"), { force: true });
  const check = new Database(join(DATA_DIR, "d1_check.db"));
  check.run(SCHEMA);
  for (const f of files) check.run(readFileSync(f, "utf8"));
  const cnt = (t: string) => (check.query(`SELECT COUNT(*) c FROM ${t}`).get() as any).c;
  console.log(`\n=== 本地回放验证 ===`);
  console.log(`words ${cnt("words")} / senses ${cnt("senses")} / surfaces ${cnt("surfaces")} / rejects ${cnt("rejects")}`);
  const ate = check.query(`SELECT word_id, kind FROM surfaces WHERE surface='ate'`).all();
  console.log(`抽查 ate →`, JSON.stringify(ate));
  const eat = check.query(`SELECT lemma, cefr FROM words WHERE lemma='eat'`).all();
  console.log(`抽查 eat →`, JSON.stringify(eat));
  const wordId = (check.query(`SELECT word_id FROM words WHERE lemma='abandon'`).get() as any)?.word_id;
  const rel = check.query(`SELECT surface, kind FROM surfaces WHERE word_id=? AND kind='collocation'`).all(wordId);
  console.log(`抽查 abandon 搭配（word_id=${wordId} 反查 idx_surfaces_word）→`, JSON.stringify(rel));
  check.close();
}
