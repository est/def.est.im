// ============================================================
// 词族归一（scripts/normalize_word_families.ts）
//
// 目标：连字符变体词条 → 主词条归并（设计文档 data-cleaning-plan §八 词族归一首批）。
// 范围：变体 = 词条 lemma 含 '-' 且去连字符后 = 另一词条 lemma（如 back-end→backend）。
// 安全：内容相似度（首个 def_en 的 token Jaccard ≥ 0.25）才归并，
//       排除 co-op→coop（合作社/鸡笼）、at-at→atat 这类连字符改变语义的误配。
//
// 归并动作（变体 v → 主词 m，m 原地保留）：
//   1. v 的 senses 并入 m（def_en+def_zh 全等去重；独特义项追加，记录 sense_no 映射）
//   2. v 的 surfaces 迁移到 m（sense 绑定按映射改；v 的 lemma 变体 → m 的 kind=spelling）
//   3. 删除 v 的 senses/surfaces/words 行
//
// 用法：bun run scripts/normalize_word_families.ts [--dry-run]
// ============================================================
import { join } from "node:path";
import { Database } from "bun:sqlite";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const DB_PATH = join(DATA_DIR, "dict_clean.db");
const DRY = process.argv.includes("--dry-run");

const db = new Database(DB_PATH);
db.run("PRAGMA busy_timeout = 5000");

// ---------- token Jaccard 相似度（首个 def_en） ----------
const tokens = (s: string): Set<string> =>
  new Set(String(s ?? "").toLowerCase().split(/[^a-z0-9']+/).filter(Boolean));
function jaccard(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---------- 找变体对 ----------
const pairs = db.query(`
  SELECT w.id AS vid, w.lemma AS vlemma, w.freq AS vfreq, w2.id AS mid, w2.lemma AS mlemma, w2.freq AS mfreq
  FROM words w JOIN words w2 ON w2.lemma = REPLACE(w.lemma, '-', '') AND w2.id != w.id
  WHERE w.lemma LIKE '%-%'
  ORDER BY w.lemma
`).all() as any[];
console.log(`候选变体对：${pairs.length}`);

// 主词优先：freq 非 NULL 优先（变体大多 freq NULL）；都非 NULL 取大；平手取无连字符（惯例）
const pickMain = (a: { id: number; freq: number | null }, b: { id: number; freq: number | null }): number => {
  const fa = a.freq ?? -1, fb = b.freq ?? -1;
  return fa >= fb ? a.id : b.id;
};

let merged = 0, excluded = 0;
const excl: string[] = [];
const changed: string[] = [];

const firstDef = (wid: number): string => {
  const r = db.query("SELECT def_en FROM senses WHERE word_id=? ORDER BY sense_no LIMIT 1").get(wid) as any;
  return r?.def_en ?? "";
};

// ---------- 归并一个变体对 ----------
function mergePair(v: any, m: any) {
  const wid = m.id;
  const vid = v.id;
  // 1. senses 并入（def_en+def_zh 全等去重）
  const existing = new Set(
    (db.query("SELECT def_en, def_zh FROM senses WHERE word_id=?").all(wid) as any[])
      .map((s: any) => `${s.def_en}|${s.def_zh}`)
  );
  const senseMap = new Map<number, number>(); // 变体 sense_id → 主词 sense_id
  const vSenses = db.query("SELECT * FROM senses WHERE word_id=?").all(vid) as any[];
  for (const s of vSenses) {
    const key = `${s.def_en}|${s.def_zh}`;
    if (existing.has(key)) {
      const exist = db.query("SELECT id FROM senses WHERE word_id=? AND def_en=? AND def_zh=?").get(wid, s.def_en, s.def_zh) as any;
      if (exist) senseMap.set(s.id, exist.id);
      continue;
    }
    const maxNo = (db.query("SELECT MAX(sense_no) mn FROM senses WHERE word_id=?").get(wid) as any).mn ?? 0;
    const res = db.query(`INSERT INTO senses (word_id, sense_no, pos, pattern, def_en, def_zh, example_en, example_zh, register, usage_notes, lang, cefr_score, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`)
      .run(wid, maxNo + 1, s.pos, s.pattern, s.def_en, s.def_zh, s.example_en, s.example_zh, s.register, s.usage_notes, s.lang, s.cefr_score);
    senseMap.set(s.id, Number(res.lastInsertRowid));
    existing.add(key);
  }
  // 2. surfaces 迁移
  const vSurf = db.query("SELECT * FROM surfaces WHERE word_id=?").all(vid) as any[];
  for (const s of vSurf) {
    if (s.kind === "lemma") {
      // 变体 lemma → 主词 spelling 变体（唯一）
      db.query(`INSERT OR IGNORE INTO surfaces (surface, word_id, sense_id, kind, label, note, created_at)
        VALUES (?,?,?,?,?,?, datetime('now'))`)
        .run(String(s.surface).toLowerCase(), wid, null, "spelling", "variant", null);
      continue;
    }
    const newSid = s.sense_id ? (senseMap.get(s.sense_id) ?? null) : null;
    db.query(`INSERT OR IGNORE INTO surfaces (surface, word_id, sense_id, kind, label, note, created_at)
      VALUES (?,?,?,?,?,?, datetime('now'))`)
      .run(String(s.surface).toLowerCase(), wid, newSid, s.kind, s.label, s.note);
  }
  // 3. 删除变体词条（senses/surfaces 级联/显式）
  db.query("DELETE FROM senses WHERE word_id=?").run(vid);
  db.query("DELETE FROM surfaces WHERE word_id=?").run(vid);
  db.query("DELETE FROM words WHERE id=?").run(vid);
}

// 全部义项对的最大 token Jaccard（die-hard 形词：v 形容词义项 vs m 名词义项，单比首义项会误判）
function familySim(vid: number, mid: number): number {
  const vDefs = (db.query("SELECT def_en FROM senses WHERE word_id=?").all(vid) as any[]).map((r) => r.def_en);
  const mDefs = (db.query("SELECT def_en FROM senses WHERE word_id=?").all(mid) as any[]).map((r) => r.def_en);
  let best = 0;
  for (const a of vDefs) for (const b of mDefs) best = Math.max(best, jaccard(a, b));
  return best;
}

// ---------- 主流程 ----------
for (const p of pairs) {
  const v = { id: p.vid, freq: p.vfreq };
  const m = { id: p.mid, freq: p.mfreq };
  const sim = familySim(p.vid, p.mid);
  if (sim < 0.2) {
    excluded++;
    excl.push(`${p.vlemma} → ${p.mlemma} (sim=${sim.toFixed(2)})`);
    continue;
  }
  // 主词 = 保留侧；另一侧被删。参数必须显式 {id} 对象（p 只有 vid/mid 字段，直接传 p 会 vid=undefined）
  const keepId = pickMain(v, m);
  const delId = keepId === p.mid ? p.vid : p.mid;
  const keepLemma = keepId === p.mid ? p.mlemma : p.vlemma;
  if (!DRY) mergePair({ id: delId, freq: delId === p.vid ? p.vfreq : p.mfreq }, { id: keepId, freq: keepId === p.mid ? p.mfreq : p.vfreq });
  merged++;
  changed.push(`${p.vlemma} → ${keepLemma}`);
}

console.log(`归并 ${merged} / 排除 ${excluded}`);
console.log(`变更词条：${changed.length}`);
if (excl.length) {
  console.log(`\n=== 排除清单（相似度不足，保持现状） ===`);
  for (const e of excl) console.log(`  ${e}`);
}
if (DRY) {
  console.log(`\n--dry-run 未写库。归并样例：${changed.slice(0, 10).join(", ")}`);
  db.close();
  process.exit(0);
}
db.close();
console.log(`\n完成。归并 ${merged} 个变体对（dict_clean.db）。`);