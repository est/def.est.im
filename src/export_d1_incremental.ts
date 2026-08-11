// 增量导出（lemma 稳定键版）：对比旧 D1/旧库与新 dict_clean.db，输出 D1 增量 SQL
// 用法: bun run src/export_d1_incremental.ts <oldDb> > tmp/d1_incremental.sql
//   旧库可为 dict_clean.db.bak 或线上 D1 sqlite（miniflare 那份，WAL 需读写模式打开）
// 输出 INSERT OR REPLACE（幂等），可安全重放本地/线上 D1
// 注意：word_id 在重建后不稳定（自增顺序变化），用 lemma 做稳定键匹配
import { Database } from "bun:sqlite";

const OLD = process.argv[2] ?? "data/dict_clean.db.bak";
const NEW = "data/dict_clean.db";
// 读写模式打开：miniflare D1 有未合并 WAL 时只读会失败；旧库只读无副作用
const oldDb = new Database(OLD);
oldDb.run("PRAGMA busy_timeout=5000");
const newDb = new Database(NEW, { readonly: true });

const q = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  const s = String(v);
  if (s === "") return "NULL";
  return "'" + s.replace(/'/g, "''") + "'";
};

let words = 0, senses = 0, surfaces = 0, rejects = 0;

// ---------- words：以 lemma 为稳定键对比 ----------
const oldWCols = oldDb.query("PRAGMA table_info(words)").all().map((c: any) => c.name);
const oldHasKind = oldWCols.includes("kind");
const oldHasEty = oldWCols.includes("etymology");
const oldW = new Map<string, string>();
for (const r of oldDb.query(`SELECT lemma, cefr, freq, phonetic_uk, phonetic_us, other_notes${oldHasEty ? ", etymology" : ""}${oldHasKind ? ", kind" : ""} FROM words`).all() as any[]) {
  oldW.set(String(r.lemma).toLowerCase(), JSON.stringify([r.cefr, r.freq, r.phonetic_uk, r.phonetic_us, r.other_notes, r.etymology ?? null, oldHasKind ? r.kind : null]));
}
const newWRows = newDb.query("SELECT id, lemma, kind, cefr, freq, phonetic_uk, phonetic_us, other_notes, etymology FROM words").all() as any[];
const newIdByLemma = new Map<string, number>();
for (const w of newWRows) newIdByLemma.set(String(w.lemma).toLowerCase(), w.id);
for (const w of newWRows) {
  const sig = JSON.stringify([w.cefr, w.freq, w.phonetic_uk, w.phonetic_us, w.other_notes, w.etymology, w.kind]);
  if (oldW.get(String(w.lemma).toLowerCase()) !== sig) {
    const et = w.kind === "name" ? 1 : 0;
    console.log(`INSERT OR REPLACE INTO words (word_id,lemma,entity_type,cefr,freq,phonetic_uk,phonetic_us,other_notes,etymology) VALUES (${w.id},${q(w.lemma)},${et},${q(w.cefr)},${w.freq ?? "NULL"},${q(w.phonetic_uk)},${q(w.phonetic_us)},${q(w.other_notes)},${q(w.etymology)});`);
    words++;
  }
}

// ---------- senses：以 (lemma, sense_no) 为稳定键 ----------
const oldWidByLemma = new Map<string, number>();
for (const r of oldDb.query("SELECT lemma, word_id FROM words").all() as any[]) oldWidByLemma.set(String(r.lemma).toLowerCase(), r.word_id);
const oldS = new Map<string, string>();
for (const r of oldDb.query("SELECT word_id, sense_no, pos, pattern, def_en, def_zh, example_en, example_zh, register, usage_notes FROM senses").all() as any[]) {
  oldS.set(`${r.word_id}:${r.sense_no}`, JSON.stringify([r.pos, r.pattern, r.def_en, r.def_zh, r.example_en, r.example_zh, r.register, r.usage_notes]));
}
const newSRes = newDb.query("SELECT word_id, sense_no, pos, pattern, def_en, def_zh, example_en, example_zh, register, usage_notes FROM senses").all() as any[];
for (const s of newSRes) {
  const sig = JSON.stringify([s.pos, s.pattern, s.def_en, s.def_zh, s.example_en, s.example_zh, s.register, s.usage_notes]);
  // 新库 word_id → lemma → 旧库 word_id（稳定键映射）
  const lemma = [...newIdByLemma.entries()].find(([, id]) => id === s.word_id)?.[0];
  const oldWid = lemma ? oldWidByLemma.get(lemma) : undefined;
  if (oldWid === undefined || oldS.get(`${oldWid}:${s.sense_no}`) !== sig) {
    console.log(`INSERT OR REPLACE INTO senses (word_id,sense_no,pos,pattern,lang_id,def_en,def_zh,example_en,example_zh,register,usage_notes) VALUES (${s.word_id},${s.sense_no},${q(s.pos)},${q(s.pattern)},0,${q(s.def_en)},${q(s.def_zh)},${q(s.example_en)},${q(s.example_zh)},${q(s.register)},${q(s.usage_notes)});`);
    senses++;
  }
}

// ---------- surfaces：以 (lemma, surface, kind, sense_no) 为稳定键 ----------
const oldU = new Set<string>();
for (const r of oldDb.query("SELECT word_id, surface, kind, COALESCE(sense_id,0) sid, label FROM surfaces").all() as any[]) {
  const lemma = [...oldWidByLemma.entries()].find(([, id]) => id === r.word_id)?.[0] ?? "";
  oldU.add(`${lemma}|${String(r.surface).toLowerCase()}|${r.kind}|${r.sid}|${r.label ?? ""}`);
}
const surfRows = newDb.query(`
  SELECT s.word_id, s.surface, s.kind, s.label, COALESCE(se.sense_no, 0) AS sense_no
  FROM surfaces s LEFT JOIN senses se ON se.id = s.sense_id AND se.word_id = s.word_id
`).all() as any[];
for (const s of surfRows) {
  const lemma = [...newIdByLemma.entries()].find(([, id]) => id === s.word_id)?.[0] ?? "";
  const key = `${lemma}|${String(s.surface).toLowerCase()}|${s.kind}|${s.sense_no}|${s.label ?? ""}`;
  if (!oldU.has(key)) {
    console.log(`INSERT OR REPLACE INTO surfaces (surface,word_id,sense_id,kind,label,notes) VALUES (${q(s.surface)},${s.word_id},${s.sense_no},${q(s.kind)},${q(s.label)},NULL);`);
    surfaces++;
  }
}

// ---------- rejects ----------
const oldR = new Set<string>();
for (const r of oldDb.query("SELECT surface, reason FROM rejects").all() as any[]) oldR.add(`${r.surface}|${r.reason}`);
for (const r of newDb.query("SELECT surface, reason FROM rejects").all() as any[]) {
  if (!oldR.has(`${r.surface}|${r.reason}`)) {
    console.log(`INSERT OR REPLACE INTO rejects (surface,reason) VALUES (${q(r.surface)},${q(r.reason)});`);
    rejects++;
  }
}

oldDb.close(); newDb.close();
console.error(`增量统计: words=${words} senses=${senses} surfaces=${surfaces} rejects=${rejects}`, { words, senses, surfaces, rejects });
