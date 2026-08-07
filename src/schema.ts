import { parseDocument } from "yaml";
import { Database } from "bun:sqlite";

export const POS_WHITELIST = ["noun", "verb", "adjective", "adverb", "preposition", "conjunction", "pronoun", "interjection", "article", "phrase", "idiom"];
export const INFLECT_LABELS = ["plural", "third_person_singular", "present_participle", "past", "past_participle", "comparative", "superlative"];
export const ENTRIES_MAX = 16;
export const CEFR_WHITELIST = ["A1", "A2", "B1", "B2", "C1", "C2"];

// ---------- 围栏剥离：模型偶尔还是会给 ```yaml 围栏，防御性剥掉 ----------
export function stripFence(raw: string): string {
  const m = raw.match(/^\s*```(?:yaml)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  return m ? m[1] : raw;
}

// ---------- 解析 + 围栏剥离，返回结构化结果 ----------
export function parseYaml(raw: string):
  | { ok: true; doc: any; data: any; text: string }
  | { ok: false; error: string; text: string } {
  const text = stripFence(raw);
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { ok: false, error: doc.errors[0].message, text };
  return { ok: true, doc, data: doc.toJS(), text };
}

// ---------- flow 风格检测（yaml 包 AST：flow=true 的集合即 flow 风格，range 为字符偏移） ----------
export function findFlow(node: any, text: string, hits: number[] = []): number[] {
  if (!node || typeof node !== "object") return hits;
  if (node.flow === true && Array.isArray(node.items)) {
    const off = node.range?.[0] ?? -1;
    hits.push(off >= 0 ? text.slice(0, off).split("\n").length : -1);
  }
  if (Array.isArray(node.items)) node.items.forEach((c: any) => findFlow(c, text, hits));
  if (node.key) findFlow(node.key, text, hits);
  if (node.value) findFlow(node.value, text, hits);
  return hits;
}

// ---------- schema 校验规则 ----------
export function validate(file: string, doc: any) {
  const errors: string[] = [];
  const warns: string[] = [];
  const data = doc.toJS();
  const word = data?.word;
  const base = file.replace(/\.yaml$/, "").replace(/-\d+$/, "");
  if (typeof word !== "string" || word.trim() === "") errors.push("word 缺失或为空");
  else if (word !== base) errors.push(`word(${word}) ≠ 文件名推导(${base})`);
  if (data.cefr !== undefined && data.cefr !== null && !CEFR_WHITELIST.includes(data.cefr))
    errors.push(`cefr(${data.cefr}) 不在白名单`);
  const entries = data?.entries;
  if (!Array.isArray(entries) || entries.length === 0) errors.push("entries 为空");
  else if (entries.length > ENTRIES_MAX) errors.push(`entries(${entries.length}) 超过上限 ${ENTRIES_MAX}`);
  (entries ?? []).forEach((e: any, i: number) => {
    const tag = `entries[${i}]`;
    if (!POS_WHITELIST.includes(e.pos)) errors.push(`${tag}: pos(${e.pos}) 不在白名单`);
    if (typeof e.def_en !== "string" || e.def_en.trim() === "") errors.push(`${tag}: def_en 缺失`);
    if (typeof e.def_zh !== "string" || e.def_zh.trim() === "") errors.push(`${tag}: def_zh 缺失`);
    const hasEn = typeof e.example_en === "string" && e.example_en.trim() !== "";
    const hasZh = typeof e.example_zh === "string" && e.example_zh.trim() !== "";
    if (hasEn !== hasZh) errors.push(`${tag}: example_en/example_zh 不成对`);
    for (const k of ["synonyms", "antonyms", "collocations"]) {
      const v = e[k];
      if (v === undefined || v === null) continue;
      if (!Array.isArray(v) || v.length === 0) errors.push(`${tag}: ${k} 若存在须为非空列表`);
      else if (v.some((s: any) => typeof s !== "string" || s.trim() === "")) errors.push(`${tag}: ${k} 项必须是非空字符串`);
    }
    if (e.pattern && !["idiom", "phrase"].includes(e.pos)) errors.push(`${tag}: pattern 仅允许 idiom/phrase 词性`);
    if (["idiom", "phrase"].includes(e.pos) && !e.pattern) errors.push(`${tag}: idiom/phrase 必须带 pattern（短语检索依赖）`);
  });
  (data?.inflections ?? []).forEach((f: any, i: number) => {
    const tag = `inflections[${i}]`;
    if (!INFLECT_LABELS.includes(f.form)) errors.push(`${tag}: form(${f.form}) 不在白名单`);
    if (typeof f.value !== "string" || f.value.trim() === "") errors.push(`${tag}: value 缺失`);
  });
  const variant = parseInt(file.match(/-(\d+)\.yaml$/)?.[1] ?? "0", 10);
  return { errors, warns, data, word, variant };
}

// ---------- 建库（sqlite-design.md 的 schema） ----------
export function createDb(db: Database): Database {
  db.run("PRAGMA foreign_keys = ON");
  db.run(`
CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY,
  lemma TEXT NOT NULL COLLATE NOCASE,
  variant INTEGER NOT NULL DEFAULT 0,
  cefr TEXT,                       -- A1/A2/B1/B2/C1/C2，大概估计，作遍历优先级
  phonetic_uk TEXT, phonetic_us TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  model TEXT, raw_yaml TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lemma, variant)
);
CREATE TABLE IF NOT EXISTS senses (
  id INTEGER PRIMARY KEY,
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  sense_no INTEGER NOT NULL,
  pos TEXT NOT NULL CHECK (pos IN ('noun','verb','adjective','adverb','preposition','conjunction','pronoun','interjection','article','phrase','idiom')),
  pattern TEXT,
  def_en TEXT NOT NULL, def_zh TEXT NOT NULL,
  example_en TEXT, example_zh TEXT, register TEXT, usage_notes TEXT,
  UNIQUE (word_id, sense_no)
);
CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY,
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  sense_id INTEGER REFERENCES senses(id) ON DELETE CASCADE,
  surface TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL CHECK (kind IN ('lemma','inflection','synonym','antonym','collocation')),
  label TEXT,
  UNIQUE (surface, word_id, sense_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_terms_surface ON terms (surface COLLATE NOCASE);
`);
  return db;
}

// ---------- 入库：单词整词替换，幂等 ----------
export function ingest(db: Database, data: any, word: string, variant: number, model = "unknown") {
  db.query(`INSERT INTO words (lemma, variant, cefr, phonetic_uk, phonetic_us, model) VALUES (?,?,?,?,?,?)
    ON CONFLICT(lemma, variant) DO UPDATE SET cefr=excluded.cefr, phonetic_uk=excluded.phonetic_uk, phonetic_us=excluded.phonetic_us, model=excluded.model, updated_at=datetime('now')`)
    .run(word, variant, data.cefr ?? null, data.phonetic_uk ?? null, data.phonetic_us ?? null, model);
  const wordId = (db.query("SELECT id FROM words WHERE lemma=? AND variant=?").get(word, variant) as any).id;
  db.query("DELETE FROM senses WHERE word_id=?").run(wordId);
  db.query("DELETE FROM terms WHERE word_id=?").run(wordId);
  db.query("INSERT OR IGNORE INTO terms (word_id, sense_id, surface, kind, label) VALUES (?,?,?,?,?)").run(wordId, null, word, "lemma", null);
  // 词级变形只插一次（不能放在 entry 循环内，否则每个 entry 重插一遍；
  // 且 SQLite UNIQUE 对 NULL 不生效，sense_id 为 NULL 时 INSERT OR IGNORE 拦不住重复）
  for (const f of data.inflections ?? []) {
    db.query("INSERT OR IGNORE INTO terms (word_id, sense_id, surface, kind, label) VALUES (?,?,?,?,?)")
      .run(wordId, null, f.value, "inflection", f.form);
  }
  data.entries.forEach((e: any, i: number) => {
    const res = db.query(`INSERT INTO senses (word_id, sense_no, pos, pattern, def_en, def_zh, example_en, example_zh, register, usage_notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(wordId, i + 1, e.pos, e.pattern ?? null, e.def_en, e.def_zh,
      e.example_en ?? null, e.example_zh ?? null, e.register ?? null, e.usage_notes ?? null);
    const senseId = Number(res.lastInsertRowid);
    for (const [k, kind] of [["synonyms", "synonym"], ["antonyms", "antonym"], ["collocations", "collocation"]] as const) {
      for (const s of e[k] ?? []) {
        db.query("INSERT OR IGNORE INTO terms (word_id, sense_id, surface, kind, label) VALUES (?,?,?,?,?)")
          .run(wordId, senseId, s, kind, null);
      }
    }
  });
}
