// ============================================================
// 清洗 Step 4：验收审计（clean_audit.ts）
//
// 对比旧库 dict.db 与新库 dict_clean.db：
//   1. 规模对比（words/senses/surfaces ↔ terms）
//   2. 新库垃圾残留（撇号 / 单字母 / 词表外）
//   3. 变形覆盖（有 inflection surfaces 的词比例）
//   4. 自洽：senses 文本用词是否全被 surfaces 覆盖（closure）
//   5. clean_log 决策分布（迁移去向全记录）
//
// 用法：bun run src/clean_audit.ts
// ============================================================
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const SRC_DB = join(DATA_DIR, "dict.db");
const DST_DB = join(DATA_DIR, "dict_clean.db");
const LIST_DB = join(DATA_DIR, "word_cefr_minified.db");

if (!existsSync(DST_DB)) throw new Error(`找不到 ${DST_DB}（先跑 clean_migrate.ts）`);

const src = new Database(SRC_DB, { readonly: true });
const dst = new Database(DST_DB, { readonly: true });
const list = new Database(LIST_DB, { readonly: true });

console.log("=== 1. 规模对比 ===");
const cnt = (db: Database, sql: string) => (db.query(sql).get() as any)["COUNT(*)"];
console.log(`  旧库 words=${cnt(src, "SELECT COUNT(*) FROM words")}  senses=${cnt(src, "SELECT COUNT(*) FROM senses")}  terms=${cnt(src, "SELECT COUNT(*) FROM terms")}`);
console.log(`  新库 words=${cnt(dst, "SELECT COUNT(*) FROM words")}  senses=${cnt(dst, "SELECT COUNT(*) FROM senses")}  surfaces=${cnt(dst, "SELECT COUNT(*) FROM surfaces")}`);

console.log("\n=== 2. 新库垃圾残留 ===");
console.log(`  撇号词: ${cnt(dst, "SELECT COUNT(*) FROM words WHERE lemma LIKE '%''%'")}`);
console.log(`  单字母(非a/i): ${cnt(dst, "SELECT COUNT(*) FROM words WHERE length(lemma)=1 AND lemma NOT IN ('a','i')")}`);
console.log(`  全大写: ${cnt(dst, "SELECT COUNT(*) FROM words WHERE lemma=upper(lemma) AND lemma NOT IN (lower(lemma))")}`);

console.log("\n=== 3. 词表外占比（新库） ===");
const inList = new Set<string>();
for (const r of list.query("SELECT word FROM words").all() as any[]) inList.add(String(r.word).toLowerCase());
let out = 0;
for (const r of dst.query("SELECT lemma FROM words").all() as any[]) if (!inList.has(String(r.lemma).toLowerCase())) out++;
console.log(`  词表外: ${out}`);

console.log("\n=== 4. 变形覆盖 ===");
const inflRow = dst.query(`SELECT COUNT(*) c FROM (SELECT DISTINCT word_id FROM surfaces WHERE kind='inflection')`).get() as any;
const hasInfl = inflRow.c;
const total = cnt(dst, "SELECT COUNT(*) FROM words");
console.log(`  有变形行的词: ${hasInfl}/${total} (${(hasInfl / total * 100).toFixed(0)}%)`);

console.log("\n=== 5. clean_log 决策分布 ===");
for (const r of dst.query("SELECT decision, COUNT(*) c FROM clean_log GROUP BY decision ORDER BY c DESC").all() as any[]) {
  console.log(`  ${String(r.decision).padEnd(16)} ${r.c}`);
}

// ---------- 6. 自洽（closure）----------
console.log("\n=== 6. 自洽检查（新库 senses 用词 vs surfaces 覆盖） ===");
const covered = new Set<string>();
for (const r of dst.query("SELECT lower(surface) s FROM surfaces").all() as any[]) covered.add(r.s);
const STOPWORDS = new Set(["sb", "sth", "sb.", "sth.", "e.g.", "etc."]);
const tokensOf = (t: string): string[] =>
  (t.match(/[a-zA-Z][a-zA-Z'-]*/g) ?? [])
    .map((w) => w.toLowerCase().replace(/^['-]+|['-]+$/g, ""))
    .map((w) => (w.endsWith("'s") ? w.slice(0, -2) : w))
    .filter((w) => !w.includes("'") && w.length > 0 && !STOPWORDS.has(w) && !/^\d/.test(w));
const used = new Set<string>();
for (const r of dst.query("SELECT def_en, example_en, pattern FROM senses").all() as any[]) {
  for (const t of [r.def_en, r.example_en, r.pattern]) if (t) for (const w of tokensOf(t)) used.add(w);
}
let uncovered = 0;
for (const w of used) if (!covered.has(w)) uncovered++;
console.log(`  释义用词 ${used.size}，未覆盖 ${uncovered}（可查率 ${((1 - uncovered / used.size) * 100).toFixed(1)}%）`);

src.close(); dst.close(); list.close();