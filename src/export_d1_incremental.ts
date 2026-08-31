// ============================================================
// 增量导出 v3（lemma 稳定键版，逐差异 UPDATE/INSERT/DELETE）
//
// 对比旧库（dict_clean 备份 / miniflare D1）与新 dict_clean.db，
// 对「有变化的词」只输出变化部分的 SQL：
//   words    → UPDATE（lemma 定位；新词则 INSERT OR REPLACE）
//   senses   → 内容变 UPDATE / 新增 INSERT / 超范围 DELETE（连同该 sense_no 的 surfaces）
//   surfaces → 新增 INSERT / 被删 DELETE / label 变 UPDATE
// 未变化的词不产生任何语句。
//
// 为什么不用整词 DELETE+INSERT：增量应该只带差异；DELETE+INSERT 对
// 变更词是全量重导，语句多、且 --file 非单事务时有半删风险。
//
// 输出：分片文件 tmp/d1_inc_00.sql …（每片 <6MB，防线上 >10MB 异步排队）
// 用法：bun run src/export_d1_incremental.ts <oldDb>
//   旧库可为 dict_clean 备份（words.id）或 D1 sqlite（words.word_id，WAL 需读写模式打开）
//   线上导入：串行执行 npx wrangler d1 execute def-dict --remote --file tmp/d1_inc_0X.sql
// ============================================================
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const OLD = process.argv[2] ?? join(DATA_DIR, "dict_clean.db.pre-enrich.bak");
const NEW = join(DATA_DIR, "dict_clean.db");
const OUT_DIR = join(DIR, "..", "tmp");
mkdirSync(OUT_DIR, { recursive: true });
for (const f of new Bun.Glob("d1_inc_*.sql").scanSync({ cwd: OUT_DIR, onlyFiles: true })) rmSync(join(OUT_DIR, f)); // 清旧分片，防残留

const oldDb = new Database(OLD); // 读写模式：miniflare D1 有未合并 WAL 时只读会失败
oldDb.run("PRAGMA busy_timeout=5000");
const newDb = new Database(NEW, { readonly: true });

// ---------- 转义：单引号翻倍 + 换行转 \n 字面量（线上 D1 解析器对跨行字符串严格） ----------
const q = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  const s = String(v);
  if (s === "") return "NULL";
  return "'" + s.replace(/'/g, "''").replace(/\r\n/g, "\\n").replace(/\n/g, "\\n").replace(/\r/g, "\\n") + "'";
};

// 对比归一：线上存的是 \n 两字符字面量，本地是真实换行——统一转真实换行再比
const norm = (v: unknown): unknown => (typeof v === "string" ? v.replace(/\\n/g, "\n") : v);
const sigOf = (arr: unknown[]): string => JSON.stringify(arr.map(norm));

// ---------- schema 探测：旧库是 dict_clean（words.id）还是 D1（words.word_id） ----------
const oldWCols = oldDb.query("PRAGMA table_info(words)").all().map((c: any) => c.name);
const oldIsD1 = oldWCols.includes("word_id");
const oldWidExpr = oldIsD1 ? "word_id" : "id AS word_id";
const oldHasKind = oldWCols.includes("kind");
const oldHasEty = oldWCols.includes("etymology");
const oldSCols = oldDb.query("PRAGMA table_info(senses)").all().map((c: any) => c.name);
const oldSenseHasId = oldSCols.includes("id");

// ---------- 旧库索引：lemma → 签名 ----------
const oldWidByLemma = new Map<string, number>();
const oldLemmaByWid = new Map<number, string>(); // word_id → lemma（surfaces 索引反查用，避免 O(N²)）
const oldWSig = new Map<string, string>();
for (const r of oldDb.query(`SELECT lemma, ${oldWidExpr}, cefr, freq, phonetic_uk, phonetic_us, other_notes${oldHasEty ? ", etymology" : ""}${oldHasKind ? ", kind" : ""} FROM words`).all() as any[]) {
  const lem = String(r.lemma).toLowerCase();
  oldWidByLemma.set(lem, r.word_id);
  oldLemmaByWid.set(r.word_id, lem);
  oldWSig.set(lem, sigOf([r.cefr, r.freq, r.phonetic_uk, r.phonetic_us, r.other_notes, r.etymology ?? null, oldHasKind ? r.kind : null]));
}
// senses：old_wid → Map<sense_no, 义项签名>
const oldSByWid = new Map<number, Map<number, string>>();
for (const r of oldDb.query("SELECT word_id, sense_no, pos, pattern, def_en, def_zh, example_en, example_zh, register, usage_notes FROM senses").all() as any[]) {
  if (!oldSByWid.has(r.word_id)) oldSByWid.set(r.word_id, new Map());
  oldSByWid.get(r.word_id)!.set(r.sense_no, sigOf([r.pos, r.pattern, r.def_en, r.def_zh, r.example_en, r.example_zh, r.register, r.usage_notes]));
}
// surfaces：lemma → Map<`surface|kind|sense_no`, label>
const oldUByLemma = new Map<string, Map<string, string>>();
const oldSurfQuery = oldSenseHasId
  ? `SELECT s.word_id, s.surface, s.kind, s.label, COALESCE(se.sense_no, 0) AS sense_no
     FROM surfaces s LEFT JOIN senses se ON se.id = s.sense_id AND se.word_id = s.word_id`
  : `SELECT word_id, surface, kind, label, COALESCE(sense_id, 0) AS sense_no FROM surfaces`;
for (const r of oldDb.query(oldSurfQuery).all() as any[]) {
  const lem = oldLemmaByWid.get(r.word_id);
  if (!lem) continue;
  if (!oldUByLemma.has(lem)) oldUByLemma.set(lem, new Map());
  oldUByLemma.get(lem)!.set(`${String(r.surface).toLowerCase()}|${r.kind}|${r.sense_no}`, r.label ?? "");
}

// ---------- 新库（dict_clean，schema 固定） ----------
const newWByLemma = new Map<string, any>();
for (const r of newDb.query("SELECT id, lemma, kind, cefr, freq, phonetic_uk, phonetic_us, other_notes, etymology FROM words").all() as any[]) {
  newWByLemma.set(String(r.lemma).toLowerCase(), r);
}
const newSByWid = new Map<number, any[]>();
for (const r of newDb.query("SELECT word_id, sense_no, pos, pattern, def_en, def_zh, example_en, example_zh, register, usage_notes FROM senses ORDER BY word_id, sense_no").all() as any[]) {
  if (!newSByWid.has(r.word_id)) newSByWid.set(r.word_id, []);
  newSByWid.get(r.word_id)!.push(r);
}
const newUByWid = new Map<number, any[]>();
for (const r of newDb.query(`
  SELECT s.word_id, s.surface, s.kind, s.label, COALESCE(se.sense_no, 0) AS sense_no
  FROM surfaces s LEFT JOIN senses se ON se.id = s.sense_id AND se.word_id = s.word_id
`).all() as any[]) {
  if (!newUByWid.has(r.word_id)) newUByWid.set(r.word_id, []);
  newUByWid.get(r.word_id)!.push(r);
}

// ---------- 语句生成 ----------
const out: string[] = [];
const stats = { wUpdate: 0, wInsert: 0, wDelete: 0, sUpdate: 0, sInsert: 0, sDelete: 0, uInsert: 0, uDelete: 0, uUpdate: 0 };
const emit = (sql: string) => out.push(sql);

// word_id 子查询（lemma 定位，不依赖具体 id）
const widOf = (lemma: string) => `(SELECT word_id FROM words WHERE lemma = ${q(lemma)})`;

let fileIdx = 0, totalBytes = 0;
const flush = () => {
  if (!out.length) return;
  // 追加模式落盘，全局字节计数切片（每片 <6MB，防线上 >10MB 异步排队）
  let buf = "", bytes = 0;
  for (const line of out) {
    if (totalBytes + bytes > 6 * 1024 * 1024) {
      appendFileSync(join(OUT_DIR, `d1_inc_${String(fileIdx).padStart(2, "0")}.sql`), buf);
      fileIdx++;
      totalBytes = 0;
      buf = ""; bytes = 0;
    }
    buf += line;
    bytes += line.length;
  }
  appendFileSync(join(OUT_DIR, `d1_inc_${String(fileIdx).padStart(2, "0")}.sql`), buf);
  totalBytes += bytes;
  out.length = 0;
};

let nChanged = 0;
for (const [lemma, w] of newWByLemma) {
  const wid = w.id;
  const oldWid = oldWidByLemma.get(lemma);
  const newWordSig = sigOf([w.cefr, w.freq, w.phonetic_uk, w.phonetic_us, w.other_notes, w.etymology, oldHasKind ? w.kind : null]);
  const newSenses = newSByWid.get(wid) ?? [];
  const newSurf = newUByWid.get(wid) ?? [];
  const et = w.kind === "name" ? 1 : 0;

  // ---------- 新词：整词 INSERT OR REPLACE ----------
  if (oldWid === undefined) {
    emit(`INSERT OR REPLACE INTO words (word_id,lemma,entity_type,cefr,freq,phonetic_uk,phonetic_us,other_notes,etymology) VALUES (${wid},${q(w.lemma)},${et},${q(w.cefr)},${w.freq ?? "NULL"},${q(w.phonetic_uk)},${q(w.phonetic_us)},${q(w.other_notes)},${q(w.etymology)});\n`);
    stats.wInsert++;
    for (const s of newSenses) {
      emit(`INSERT OR REPLACE INTO senses (word_id,sense_no,pos,pattern,lang_id,def_en,def_zh,example_en,example_zh,register,usage_notes) VALUES (${wid},${s.sense_no},${q(s.pos)},${q(s.pattern)},0,${q(s.def_en)},${q(s.def_zh)},${q(s.example_en)},${q(s.example_zh)},${q(s.register)},${q(s.usage_notes)});\n`);
      stats.sInsert++;
    }
    for (const s of newSurf) {
      emit(`INSERT OR REPLACE INTO surfaces (surface,word_id,sense_id,kind,label,notes) VALUES (${q(s.surface)},${wid},${s.sense_no},${q(s.kind)},${q(s.label)},NULL);\n`);
      stats.uInsert++;
    }
    nChanged++;
    if (nChanged % 300 === 0) flush();
    continue;
  }

  let changed = false;

  // ---------- words：UPDATE（lemma 定位，全列赋值；顺带修复历史双行） ----------
  if (oldWSig.get(lemma) !== newWordSig) {
    emit(`UPDATE words SET entity_type=${et},cefr=${q(w.cefr)},freq=${w.freq ?? "NULL"},phonetic_uk=${q(w.phonetic_uk)},phonetic_us=${q(w.phonetic_us)},other_notes=${q(w.other_notes)},etymology=${q(w.etymology)} WHERE lemma = ${q(w.lemma)};\n`);
    stats.wUpdate++;
    changed = true;
  }

  // ---------- senses：删超范围 → 新增/内容变 ----------
  const oldS = oldWid !== undefined ? (oldSByWid.get(oldWid) ?? new Map<number, string>()) : new Map<number, string>();
  const newNos = new Set(newSenses.map((s) => s.sense_no));
  for (const n of oldS.keys()) {
    if (!newNos.has(n)) {
      emit(`DELETE FROM senses WHERE word_id IN ${widOf(lemma)} AND sense_no = ${n};\n`);
      emit(`DELETE FROM surfaces WHERE word_id IN ${widOf(lemma)} AND sense_id = ${n};\n`);
      stats.sDelete++;
      changed = true;
    }
  }
  for (const s of newSenses) {
    const sig = sigOf([s.pos, s.pattern, s.def_en, s.def_zh, s.example_en, s.example_zh, s.register, s.usage_notes]);
    const oldSig = oldS.get(s.sense_no);
    if (oldSig === undefined) {
      emit(`INSERT OR REPLACE INTO senses (word_id,sense_no,pos,pattern,lang_id,def_en,def_zh,example_en,example_zh,register,usage_notes) SELECT word_id,${s.sense_no},${q(s.pos)},${q(s.pattern)},0,${q(s.def_en)},${q(s.def_zh)},${q(s.example_en)},${q(s.example_zh)},${q(s.register)},${q(s.usage_notes)} FROM words WHERE lemma = ${q(w.lemma)};\n`);
      stats.sInsert++;
      changed = true;
    } else if (oldSig !== sig) {
      emit(`UPDATE senses SET pos=${q(s.pos)},pattern=${q(s.pattern)},lang_id=0,def_en=${q(s.def_en)},def_zh=${q(s.def_zh)},example_en=${q(s.example_en)},example_zh=${q(s.example_zh)},register=${q(s.register)},usage_notes=${q(s.usage_notes)} WHERE word_id IN ${widOf(lemma)} AND sense_no = ${s.sense_no};\n`);
      stats.sUpdate++;
      changed = true;
    }
  }

  // ---------- surfaces：被删 → 新增/label 变 ----------
  const newMap = new Map<string, any>();
  for (const s of newSurf) newMap.set(`${String(s.surface).toLowerCase()}|${s.kind}|${s.sense_no}`, s);
  const oldMap = oldUByLemma.get(lemma) ?? new Map<string, string>();
  for (const k of oldMap.keys()) {
    if (!newMap.has(k)) {
      const [surface, kind, senseNo] = k.split("|");
      emit(`DELETE FROM surfaces WHERE word_id IN ${widOf(lemma)} AND surface = ${q(surface)} AND kind = ${q(kind)} AND sense_id = ${senseNo};\n`);
      stats.uDelete++;
      changed = true;
    }
  }
  for (const [k, s] of newMap) {
    const oldLabel = oldMap.get(k);
    if (oldLabel === undefined) {
      emit(`INSERT OR REPLACE INTO surfaces (surface,word_id,sense_id,kind,label,notes) SELECT ${q(s.surface)},word_id,${s.sense_no},${q(s.kind)},${q(s.label)},NULL FROM words WHERE lemma = ${q(w.lemma)};\n`);
      stats.uInsert++;
      changed = true;
    } else if (oldLabel !== (s.label ?? "")) {
      const [surface, kind, senseNo] = k.split("|");
      emit(`UPDATE surfaces SET label = ${q(s.label)} WHERE word_id IN ${widOf(lemma)} AND surface = ${q(surface)} AND kind = ${q(kind)} AND sense_id = ${senseNo};\n`);
      stats.uUpdate++;
      changed = true;
    }
  }

  if (changed) nChanged++;
  if (nChanged % 300 === 0) flush();
}

flush();
// ---------- 词条删除：旧库有、新库无 → DELETE 块（surfaces→senses→words，按 lemma 定位） ----------
for (const [lemma, oldWid] of oldWidByLemma) {
  if (newWByLemma.has(lemma)) continue;
  const oldRow = oldDb.query(`SELECT entity_type FROM words WHERE ${oldIsD1 ? "word_id" : "id"} = ?`).get(oldWid) as any;
  // 占位行（entity_type=-1）与 on-demand 生成的词（旧库有、新库无）不自动删——保守跳过
  if (oldRow && oldRow.entity_type === -1) continue;
  emit(`DELETE FROM surfaces WHERE word_id IN ${widOf(lemma)};\n`);
  emit(`DELETE FROM senses WHERE word_id IN ${widOf(lemma)};\n`);
  emit(`DELETE FROM words WHERE lemma = ${q(lemma)};\n`);
  stats.wDelete++;
  nChanged++;
  if (nChanged % 300 === 0) flush();
}
flush();
oldDb.close(); newDb.close();
console.error(`增量统计: 变更词=${nChanged}  ${JSON.stringify(stats)}（已分片写入 tmp/d1_inc_*.sql）`);
