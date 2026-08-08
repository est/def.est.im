// ============================================================
// 一次性回填（backfill.ts）：用权威词表修复存量数据
//
// 修三件事（全部零 API 成本，读 word_cefr_minified.db）：
//   1. cefr / cefr_score / freq：权威词表优先覆盖（词表未覆盖的保留 AI 值）
//   2. 缺失的变形行：词表 lemma_word_id 链接补全 inflections 进 terms
//      （NNS→plural、VBD→past、VBG→present_participle、VBZ→third_person_singular、
//       VBN→past_participle、JJR/JJS/RBR/RBS→比较级/最高级）
//   3. （可选 --prune）清理 terms 里与权威词表无关的冗余？—— 不做，保持简单
//
// 用法：bun run src/backfill.ts
// 注意：请在采集器停止时运行（避免并发写 dict.db）
// ============================================================
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createDb } from "./schema.ts";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const dict = createDb(new Database(join(DATA_DIR, "dict.db")));
const list = new Database(join(DATA_DIR, "word_cefr_minified.db"), { readonly: true });

const BUCKETS = ["A1", "A2", "B1", "B2", "C1", "C2"];
const TAG_TO_LABEL: Record<string, string> = {
  NNS: "plural", VBD: "past", VBG: "present_participle", VBZ: "third_person_singular",
  VBN: "past_participle", JJR: "comparative", JJS: "superlative", RBR: "comparative", RBS: "superlative",
};

// 1) 权威词表：word → {level, score, freq}
const meta = new Map<string, { level: string; score: number; freq: number }>();
for (const r of list.query(`
  SELECT w.word AS word, MIN(p.level) AS lvl, MAX(p.frequency_count) AS freq
  FROM words w JOIN word_pos p ON p.word_id = w.word_id GROUP BY w.word_id`).all() as any[]) {
  meta.set(String(r.word).toLowerCase(), {
    level: BUCKETS[Math.min(5, Math.max(0, Math.floor(r.lvl) - 1))],
    score: r.lvl, freq: r.freq,
  });
}

// 2) 词表 lemma 链接：lemma → 屈折形式列表（去重）
const formsOf = new Map<string, { surface: string; label: string }[]>();
for (const r of list.query(`
  SELECT l.word AS lemma, w.word AS surface, t.tag AS tag
  FROM word_pos p
  JOIN words w ON w.word_id = p.word_id
  JOIN words l ON l.word_id = p.lemma_word_id
  JOIN pos_tags t ON t.tag_id = p.pos_tag_id
  WHERE p.lemma_word_id IS NOT NULL`).all() as any[]) {
  const label = TAG_TO_LABEL[r.tag];
  if (!label) continue;
  const lemma = String(r.lemma).toLowerCase();
  const surface = String(r.surface).toLowerCase();
  if (surface === lemma) continue;
  if (!formsOf.has(lemma)) formsOf.set(lemma, []);
  const arr = formsOf.get(lemma)!;
  if (!arr.some((f) => f.surface === surface && f.label === label)) arr.push({ surface, label });
}
console.log(`词表条目 ${meta.size}，变形映射原形数 ${formsOf.size}`);

// 3) 回填
let cefrFix = 0, formFix = 0, formSkip = 0;
const words = dict.query("SELECT id, lemma FROM words WHERE variant=0").all() as { id: number; lemma: string }[];
for (const w of words) {
  const m = meta.get(w.lemma.toLowerCase());
  if (m) {
    dict.query("UPDATE words SET cefr=?, cefr_score=?, freq=? WHERE id=?").run(m.level, m.score, m.freq, w.id);
    cefrFix++;
  }
  const forms = formsOf.get(w.lemma.toLowerCase());
  if (forms) {
    for (const f of forms) {
      // sense_id IS NULL 的行不受 UNIQUE 约束（SQLite NULL 语义），需显式去重
      const dup = dict.query(
        "SELECT 1 FROM terms WHERE word_id=? AND sense_id IS NULL AND surface=? AND kind='inflection'"
      ).get(w.id, f.surface);
      if (dup) { formSkip++; continue; }
      dict.query("INSERT INTO terms (word_id, sense_id, surface, kind, label) VALUES (?,?,?,?,?)")
        .run(w.id, null, f.surface, "inflection", f.label);
      formFix++;
    }
  }
}
console.log(`回填完成：cefr/score/freq 更新 ${cefrFix} 词，新增变形 ${formFix} 行，跳过已存在 ${formSkip} 行`);
dict.close();
list.close();
