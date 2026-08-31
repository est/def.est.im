// ============================================================
// 应用 enrich 存档（scripts/apply_enrich.ts）
//
// data/enrich.json 由 backfill_enrich.ts 产出(词 → 完整词条 JSON,
// 含音标/词源/扩充义项/register/usage_notes/同反义搭配)。
// 本脚本把存档应用到 dict_clean.db——用于 clean_migrate 重建
// dict_clean.db 之后恢复 backfill 成果(重建会从源库重来,丢失 enrich)。
//
// 幂等:对每词按 lemma 覆盖式写入(与 backfill_enrich 的 ingestLocal 相同)。
// 用法:bun run scripts/apply_enrich.ts [--dry-run]
// ============================================================
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const DIR = import.meta.dir; // scripts/
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const DB_PATH = join(DATA_DIR, "dict_clean.db");
const ENRICH_PATH = join(DATA_DIR, "enrich.json");
const DRY = process.argv.includes("--dry-run");

if (!existsSync(ENRICH_PATH)) throw new Error(`找不到 ${ENRICH_PATH}（先跑 backfill_enrich.ts）`);
const enrich: Record<string, any> = JSON.parse(readFileSync(ENRICH_PATH, "utf8"));
const db = new Database(DB_PATH);
db.run("PRAGMA busy_timeout = 5000");

function ingestLocal(data: any, word: string) {
  const wid = (db.query("SELECT id FROM words WHERE lemma=?").get(word) as any)?.id;
  if (!wid) throw new Error(`word not found: ${word}`);
  const ph = (v: unknown): string | null => (typeof v === "string" && v.trim()) ? v.trim() : null;
  const old = db.query("SELECT phonetic_uk, phonetic_us, other_notes FROM words WHERE id=?").get(wid) as any;
  db.query(`UPDATE words SET phonetic_uk=?, phonetic_us=?, other_notes=?, etymology=?, raw_yaml=?, model=?, updated_at=datetime('now') WHERE id=?`)
    .run(ph(data.phonetic_uk) ?? old.phonetic_uk, ph(data.phonetic_us) ?? old.phonetic_us,
      data.other_notes ?? old.other_notes, data.etymology ?? null,
      JSON.stringify(data), "backfill-enrich", wid);
  db.query("DELETE FROM senses WHERE word_id=?").run(wid);
  db.query("DELETE FROM surfaces WHERE word_id=? AND kind IN ('synonym','antonym','collocation')").run(wid);
  for (let i = 0; i < (data.entries ?? []).length; i++) {
    const e = data.entries[i];
    const res = db.query(`INSERT INTO senses (word_id, sense_no, pos, pattern, def_en, def_zh, example_en, example_zh, register, usage_notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(wid, i + 1, e.pos, e.pattern ?? null, e.def_en, e.def_zh,
        e.example_en ?? null, e.example_zh ?? null, e.register ?? null, e.usage_notes ?? null);
    const sid = Number(res.lastInsertRowid);
    for (const [key, kind] of [["synonyms", "synonym"], ["antonyms", "antonym"], ["collocations", "collocation"]] as const) {
      for (const s of e[key] ?? []) {
        db.query("INSERT OR IGNORE INTO surfaces (surface, word_id, sense_id, kind) VALUES (?,?,?,?)")
          .run(String(s).toLowerCase(), wid, sid, kind);
      }
    }
  }
}

let ok = 0, skipped = 0, failed = 0;
for (const [word, data] of Object.entries(enrich)) {
  if (DRY) { ok++; continue; }
  try {
    ingestLocal(data, word);
    ok++;
  } catch (e) {
    const missing = String(e).includes("word not found");
    if (missing) skipped++; else failed++;
    if (!missing) console.log(`  ⚠ ${word}: ${e}`);
  }
}
console.log(`enrich 存档 ${Object.keys(enrich).length} 词：应用 ${ok}，跳过(库中无此词) ${skipped}，失败 ${failed}`);
db.close();
