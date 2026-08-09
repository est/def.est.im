// ============================================================
// 清洗 Step 3a：确定性迁移（clean_migrate.ts）
//
// 规则层迁移：只依赖 clean_tags.json（不依赖 AI 结果）。
//   keep / hyphen_in_list            → 完整迁移 words+senses+surfaces
//   inflection（target 在库可归）    → 不建词条，表面并入目标词条
//   inflection_orphan                → 保留原词条（等 on-demand 归并）
//   apostrophe / single_letter       → rejects + clean_log，不迁移
//   outside/hyphen_outside/short_abbr→ 跳过，等 clean_ai.json 完成后由
//                                      clean_migrate_ai.ts 处理（幂等重跑）
//
// 新库 dict_clean.db（docs/data-cleaning-plan.md §四 DDL，surfaces 合并版）
// 源库只读。用法：bun run src/clean_migrate.ts
// ============================================================
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const SRC_DB = join(DATA_DIR, "dict.db");
const DST_DB = join(DATA_DIR, "dict_clean.db");
const TAGS_PATH = join(DATA_DIR, "clean_tags.json");
const AI_PATH = join(DATA_DIR, "clean_ai.json");

if (!existsSync(SRC_DB)) throw new Error(`找不到 ${SRC_DB}`);
if (!existsSync(TAGS_PATH)) throw new Error(`找不到 ${TAGS_PATH}（先跑 clean_classify.ts）`);

const src = new Database(SRC_DB, { readonly: true });
const dst = new Database(DST_DB);

// ---------- 新库 DDL ----------
dst.run("PRAGMA foreign_keys = ON");
dst.run(`
CREATE TABLE IF NOT EXISTS words (
  id INTEGER PRIMARY KEY,
  lemma TEXT NOT NULL COLLATE NOCASE,
  variant INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'common',
  lang TEXT NOT NULL DEFAULT 'en',
  cefr TEXT, cefr_score REAL, freq INTEGER,
  phonetic_uk TEXT, phonetic_us TEXT,
  other_notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  model TEXT, raw_yaml TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lemma, variant)
);
CREATE TABLE IF NOT EXISTS surfaces (
  id INTEGER PRIMARY KEY,
  surface TEXT NOT NULL COLLATE NOCASE,
  word_id INTEGER REFERENCES words(id) ON DELETE CASCADE,
  sense_id INTEGER REFERENCES senses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT,
  note TEXT,
  -- 唯一键用生成列：SQLite 的 UNIQUE 对 NULL 不生效，NULL 统一收拢为 0
  word_eff INTEGER GENERATED ALWAYS AS (COALESCE(word_id, 0)) STORED,
  sense_eff INTEGER GENERATED ALWAYS AS (COALESCE(sense_id, 0)) STORED,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (surface, word_eff, sense_eff, kind)
);
CREATE INDEX IF NOT EXISTS idx_surfaces_surface ON surfaces (surface COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_surfaces_word ON surfaces (word_id);
CREATE TABLE IF NOT EXISTS senses (
  id INTEGER PRIMARY KEY,
  word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  sense_no INTEGER NOT NULL,
  pos TEXT NOT NULL CHECK (pos IN ('noun','verb','adjective','adverb','preposition','conjunction','pronoun','interjection','article','phrase','idiom')),
  pattern TEXT,
  def_en TEXT NOT NULL, def_zh TEXT NOT NULL,
  example_en TEXT, example_zh TEXT, register TEXT, usage_notes TEXT,
  lang TEXT,
  cefr_score REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (word_id, sense_no)
);
CREATE TABLE IF NOT EXISTS clean_log (
  word TEXT NOT NULL COLLATE NOCASE,
  decision TEXT NOT NULL,
  category TEXT,
  reason TEXT,
  target TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rejects (
  surface TEXT PRIMARY KEY COLLATE NOCASE,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`);

// ---------- 输入 ----------
const tags: Record<string, { tag: string; target?: string; notes?: string[] }> =
  JSON.parse(readFileSync(TAGS_PATH, "utf8")).tags;
const ai: Record<string, string> = existsSync(AI_PATH) ? JSON.parse(readFileSync(AI_PATH, "utf8")) : {};

// 源库词行：lemma(lower) → rows（含 variant）
const srcRows = new Map<string, { id: number; variant: number }[]>();
for (const r of src.query("SELECT id, lemma, variant FROM words").all() as { id: number; lemma: string; variant: number }[]) {
  const k = r.lemma.toLowerCase();
  if (!srcRows.has(k)) srcRows.set(k, []);
  srcRows.get(k)!.push({ id: r.id, variant: r.variant });
}

let nWords = 0, nMerge = 0, nJunk = 0, nSkip = 0, nSenses = 0, nSurf = 0;

// ---------- 迁移一个词条（含全部 senses / surfaces） ----------
function copyWord(lemma: string, kind = "common") {
  // 幂等：已迁移（含被 inflection 分支提前迁移的 target）则跳过
  if (dst.query("SELECT 1 FROM words WHERE lemma=? LIMIT 1").get(lemma)) return;
  const rows = srcRows.get(lemma.toLowerCase());
  if (!rows) return;
  const v0 = rows.find((r) => r.variant === 0) ?? rows[0];
  const w = src.query("SELECT * FROM words WHERE id=?").get(v0.id) as any;
  const res = dst.query(`INSERT INTO words (lemma, variant, kind, lang, cefr, cefr_score, freq, phonetic_uk, phonetic_us, other_notes, status, model, raw_yaml, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(w.lemma, 0, kind, "en", w.cefr, w.cefr_score, w.freq, w.phonetic_uk, w.phonetic_us,
      w.other_notes, w.status, w.model, w.raw_yaml, w.created_at, w.updated_at);
  const wid = Number(res.lastInsertRowid);
  // senses（记录旧 id → 新 id，供 surfaces 引用）
  const senseMap = new Map<number, number>();
  for (const s of src.query("SELECT * FROM senses WHERE word_id=?").all(v0.id) as any[]) {
    const r2 = dst.query(`INSERT INTO senses (word_id, sense_no, pos, pattern, def_en, def_zh, example_en, example_zh, register, usage_notes, lang, cefr_score)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(wid, s.sense_no, s.pos, s.pattern, s.def_en, s.def_zh, s.example_en, s.example_zh,
        s.register, s.usage_notes, null, s.cefr_score ?? null);
    senseMap.set(s.id, Number(r2.lastInsertRowid));
    nSenses++;
  }
  // surfaces：terms → surfaces（kind 原样映射）
  for (const t of src.query("SELECT surface, sense_id, kind, label FROM terms WHERE word_id=?").all(v0.id) as any[]) {
    const sid = t.sense_id ? senseMap.get(t.sense_id) : null;
    dst.query("INSERT OR IGNORE INTO surfaces (surface, word_id, sense_id, kind, label) VALUES (?,?,?,?,?)")
      .run(t.surface, wid, sid, t.kind, t.label);
    nSurf++;
  }
  dst.query("INSERT OR IGNORE INTO surfaces (surface, word_id, sense_id, kind, label) VALUES (?,?,?,?,?)")
    .run(lemma, wid, null, "lemma", null);
  nWords++;
}

// ---------- 屈折归并：变形词表面并入目标词条 ----------
function mergeInflection(lemma: string, target: string) {
  const tRows = srcRows.get(target.toLowerCase());
  if (!tRows) return false;
  const tId = (dst.query("SELECT id FROM words WHERE lemma=? LIMIT 1").get(target) as any)?.id;
  if (!tId) return false; // 目标词条尚未迁移（可能被 AI 跳过）→ 本轮不归并
  for (const r of srcRows.get(lemma.toLowerCase()) ?? []) {
    const w = src.query("SELECT lemma FROM words WHERE id=?").get(r.id) as any;
    dst.query("INSERT OR IGNORE INTO surfaces (surface, word_id, sense_id, kind, label) VALUES (?,?,?,?,?)")
      .run(String(w.lemma).toLowerCase(), tId, null, "inflection", null);
    nSurf++;
  }
  return true;
}

// 合并迁移 pass 1+2（target 先行保证归并完整）
function migrateTag(t: { tag: string; target?: string; notes?: string[] }): string {
  switch (t.tag) {
    case "keep":
    case "hyphen_in_list":
      return "keep";
    case "apostrophe":
    case "single_letter":
      return "junk";
    case "inflection":
      return t.notes?.includes("inflection_orphan") ? "orphan" : "merge";
    default:
      return "ai";
  }
}

// AI 标签 → words.kind（收录类词条用）
const AI_KIND: Record<string, string> = { keep: "common", foreign_common: "common", name: "name", abbr: "abbr" };

// ---------- 主流程：规则层 + AI 层统一决策 ----------
// 单事务包裹全部插入（数十万行，无事务逐条 fsync 会超时）
dst.run("BEGIN");
// Pass 1：先迁移 keep 类（规则层 keep + AI keep/name/abbr/foreign_common），
//         保证 inflection 归并时 target 已在库
const aiDecision = new Map<string, string>(); // lemma → ai 标签
for (const [lemma, label] of Object.entries(ai)) aiDecision.set(lemma, label);

for (const lemma of Object.keys(tags)) {
  const t = tags[lemma];
  const aiLabel = aiDecision.get(lemma);
  const rule = migrateTag(t);
  // AI 已判定（且规则层未归并）→ 直接执行 AI 分流
  if (aiLabel && rule === "ai") {
    const kind = AI_KIND[aiLabel];
    if (kind) copyWord(lemma, kind);      // keep/foreign_common/name/abbr → 词条
    continue;                              // 其余（foreign_rare/coined/misspelling）→ Pass 2 归档
  }
  if (rule === "keep") copyWord(lemma);
}
// Pass 2：屈折归并 + AI 归档 + 规则归档
for (const [lemma, t] of Object.entries(tags)) {
  const aiLabel = aiDecision.get(lemma);
  const rule = migrateTag(t);
  if (aiLabel && rule === "ai" && !AI_KIND[aiLabel]) {
    // AI 归档类
    dst.query("INSERT OR IGNORE INTO rejects (surface, reason) VALUES (?,?)").run(lemma, `ai:${aiLabel}`);
    nJunk++;
    continue;
  }
  if (rule === "junk") {
    dst.query("INSERT OR IGNORE INTO rejects (surface, reason) VALUES (?,?)").run(lemma, `rules:${t.tag}`);
    nJunk++;
  } else if (rule === "merge" && t.target) {
    if (mergeInflection(lemma, t.target)) nMerge++;
    else copyWord(lemma); // 目标仍缺 → 保留词条
  } else if (rule === "orphan") {
    copyWord(lemma);
  } else if (rule === "ai") {
    nSkip++; // 仍无 AI 结果（unclassified / 未跑）→ 留待下一轮
  }
}

// ---------- clean_log 全记录（重建，幂等） ----------
dst.query("DELETE FROM clean_log");
const logWord = dst.prepare("INSERT INTO clean_log (word, decision, category, target) VALUES (?,?,?,?)");
for (const [lemma, t] of Object.entries(tags)) {
  const aiLabel = aiDecision.get(lemma);
  const rule = migrateTag(t);
  let decision = "", target = null;
  if (aiLabel && rule === "ai") {
    decision = AI_KIND[aiLabel] ? aiLabel : "junk";   // keep/foreign_common/name/abbr 或 归档
  } else {
    switch (rule) {
      case "keep": decision = "keep"; break;
      case "merge": decision = "merge"; target = t.target ?? null; break;
      case "orphan": decision = "keep_orphan"; break;
      case "junk": decision = "junk"; break;
      default: decision = "pending_ai"; break; // unclassified / 未跑
    }
  }
  logWord.run(lemma, decision, t.tag, target);
}

dst.query("INSERT OR REPLACE INTO meta VALUES ('schema_version','2')");
dst.query("INSERT OR REPLACE INTO meta VALUES ('cleaned_at', datetime('now'))");
dst.run("COMMIT");

console.log(`迁移完成：words=${nWords}  senses=${nSenses}  surfaces=${nSurf}  merge=${nMerge}  junk=${nJunk}  ai_skip=${nSkip}`);
dst.close();
src.close();