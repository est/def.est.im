// ============================================================
// 清洗 Step 1：规则分类（clean_classify.ts）
//
// 只读 dict.db + 权威词表，对每个词打规则标签，产物：
//   data/clean_tags.json —— 全量分类清单（词 → 标签/去向/原形），
//                            Step 2（AI 复核）只消费 ambiguous 类，
//                            Step 3（迁移）只按清单执行。
//
// 规则层（docs/data-cleaning-plan.md §二，标签优先级从高到低）：
//   inflection      词表 lemma 归原后 ≠ 自身 → 归并到原形（记 target）
//   apostrophe      含撇号 → 归档（成分词自动成条）
//   single_letter   单字母且非 a/i → 归档
//   outside         词表外普通词（长度≥5）→ AI 复核（外源词/人名/外语）
//   short_abbr      词表外且长度≤4 → AI 复核（缩写/真词/字母串）
//   hyphen_outside  词表外连字符词 → AI 复核（真复合词/临时组合）
//   keep            词表收录（含归化借词、词表内连字符词）
//
// 附加标记（不改变去向，随词记入 notes）：
//   phonetics_missing / inflection_missing —— 迁移时用 formsOf/on-demand 补
//
// 用法：bun run src/clean_classify.ts [--drop data/clean_tags.json]
// 注意：只读 dict.db，绝不写。
// ============================================================
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const DICT_DB = join(DATA_DIR, "dict.db");
const CEFR_DB = join(DATA_DIR, "word_cefr_minified.db");
const idx = process.argv.indexOf("--drop");
const OUT = idx >= 0 ? process.argv[idx + 1] : join(DATA_DIR, "clean_tags.json");

if (!existsSync(DICT_DB)) throw new Error(`找不到 ${DICT_DB}`);
if (!existsSync(CEFR_DB)) throw new Error(`找不到 ${CEFR_DB}`);

const dict = new Database(DICT_DB, { readonly: true });
const list = new Database(CEFR_DB, { readonly: true });

// 词表 lemma 链接：表面 → 原形（屈折归原，backfill/collect 同款逻辑）
const lemmaOf = new Map<string, string>();
for (const r of list.query(`
  SELECT w.word AS surface, l.word AS lemma
  FROM word_pos p
  JOIN words w ON w.word_id = p.word_id
  JOIN words l ON l.word_id = p.lemma_word_id
  WHERE p.lemma_word_id IS NOT NULL`).all() as any[]) {
  const surface = String(r.surface).toLowerCase();
  const lemma = String(r.lemma).toLowerCase();
  if (surface !== lemma) lemmaOf.set(surface, lemma);
}

// 词表全量集合
const inList = new Set<string>();
for (const r of list.query("SELECT word FROM words").all() as any[]) inList.add(String(r.word).toLowerCase());
// 权威等级：仅 word_pos 有行的词才算「有权威证据」（防词表噪声链接，如 a→um）
const hasLevel = new Set<string>();
for (const r of list.query("SELECT DISTINCT w.word FROM word_pos p JOIN words w ON w.word_id=p.word_id").all() as any[]) hasLevel.add(String(r.word).toLowerCase());
list.close();

// 统计辅助
const count = new Map<string, number>();
const bump = (k: string) => count.set(k, (count.get(k) ?? 0) + 1);

// 附加标记：音标缺失 / 无变形行的词集（变体 0 词级）
const phonMissing = new Set<number>();
for (const r of dict.query(`SELECT id FROM words WHERE variant=0 AND ((phonetic_uk IS NULL OR phonetic_uk='') AND (phonetic_us IS NULL OR phonetic_us=''))`).all() as any[]) phonMissing.add(r.id);
const inflMissing = new Set<number>();
for (const r of dict.query(`SELECT id FROM words WHERE variant=0`).all() as any[]) inflMissing.add(r.id);
for (const r of dict.query(`SELECT DISTINCT word_id FROM terms WHERE kind='inflection'`).all() as any[]) inflMissing.delete(r.word_id);

// 分类
type Tag = "keep" | "inflection" | "outside" | "short_abbr" | "hyphen_in_list" | "hyphen_outside" | "apostrophe" | "single_letter";
interface Entry { tag: Tag; target?: string; notes?: string[] }

const tags = new Map<string, Entry>();
const inDict = new Set<string>();
for (const r of dict.query("SELECT id, lemma FROM words WHERE variant=0").all() as { id: number; lemma: string }[]) {
  inDict.add(r.lemma.toLowerCase());
}
for (const r of dict.query("SELECT id, lemma FROM words WHERE variant=0").all() as { id: number; lemma: string }[]) {
  const w = r.lemma;
  const lower = w.toLowerCase();
  const lemma = lemmaOf.get(lower);
  const notes: string[] = [];
  if (phonMissing.has(r.id)) notes.push("phonetics_missing");
  if (inflMissing.has(r.id)) notes.push("inflection_missing");

  let tag: Tag;
  let target: string | undefined;
  if (lemma && lemma !== lower && lemma.length >= 3 && hasLevel.has(lemma)) {
    // 词表归原 ≠ 自身，且目标有权威证据 → 屈折形式，归并到原形。
    // 防线：目标长度≥3（滤 a→um 类单双字母噪声链）；目标有权威等级（滤无 level 的壳词）。
    // 目标在原库无词条时保留本词（notes 标 inflection_orphan），Step 3 不归并，
    // 等 on-demand 生成原形词条后再归并。
    tag = "inflection";
    target = lemma;
    if (!inDict.has(lemma)) notes.push("inflection_orphan"); // 原形无词条：保留本词待 on-demand
  } else if (w.includes("'")) {
    tag = "apostrophe";
  } else if (w.length === 1 && !["a", "i"].includes(w)) {
    tag = "single_letter";
  } else if (inList.has(lower)) {
    tag = w.includes("-") ? "hyphen_in_list" : "keep";
  } else if (w.includes("-")) {
    tag = "hyphen_outside";
  } else if (w.length <= 4) {
    tag = "short_abbr";
  } else {
    tag = "outside";
  }
  if (notes.length === 0) tags.set(lower, { tag, target });
  else tags.set(lower, { tag, target, notes });
  bump(tag);
}

// 输出统计
console.log("=== 规则分类（只读源库） ===");
for (const [tag, n] of [...count.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tag.padEnd(18)} ${n}`);
}
console.log(`  phonetics_missing   ${phonMissing.size}`);
console.log(`  inflection_missing  ${inflMissing.size}`);
console.log(`  总计                ${tags.size}`);

// 样例
const sample = (tag: Tag, n = 10) => {
  const hit = [...tags.entries()].filter(([, e]) => e.tag === tag).slice(0, n)
    .map(([w, e]) => e.target ? `${w}→${e.target}` : w);
  if (hit.length) console.log(`\n${tag} 样例: ${hit.join(", ")}`);
};
["inflection", "outside", "short_abbr", "hyphen_outside", "apostrophe", "single_letter", "keep"].forEach((t) => sample(t as Tag));

// 落盘全量清单
await Bun.write(OUT, JSON.stringify({ at: new Date().toISOString(), total: tags.size, tags: Object.fromEntries(tags) }, null, 2));
console.log(`\n清单已写 ${OUT}`);
dict.close();