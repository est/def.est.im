// ============================================================
// 变形补充：规则屈折推断（backfill_forms.ts）
//
// 必要性见 docs/data-cleaning-plan.md：高频词已全覆盖，缺口在
// 低频规则词。本脚本对「名词/动词/形容词 + 无变形行」的词做
// 本地规则屈折推断（零 API 成本）。
//
// 判定：
//   候选 = words 无 inflection surfaces 且 senses 含对应词性
//   防御① 词表该 lemma 有 formsOf 登记（不规则/已有形式）→ 跳过
//   防御② 推断出的 surface 已是别词条或已有 surface → 跳过该形式
//
// 用法：
//   bun run src/backfill_forms.ts            # dry-run：只看能补多少
//   bun run src/backfill_forms.ts --apply      # 写入 dict_clean.db（surfaces）
// ============================================================
import { join } from "node:path";
import { Database } from "bun:sqlite";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const DST_DB = join(DATA_DIR, "dict_clean.db");
const LIST_DB = join(DATA_DIR, "word_cefr_minified.db");
const APPLY = process.argv.includes("--apply");

const dst = new Database(DST_DB);
const list = new Database(LIST_DB, { readonly: true });

// ---------- 词表：lemma → 已有 forms（不规则/登记形式，防御①用） ----------
const lemmaForms = new Map<string, Set<string>>();
for (const r of list.query(`
  SELECT l.word AS lemma, w.word AS surface
  FROM word_pos p JOIN words w ON w.word_id=p.word_id
  JOIN words l ON l.word_id=p.lemma_word_id
  WHERE p.lemma_word_id IS NOT NULL`).all() as any[]) {
  const lemma = String(r.lemma).toLowerCase();
  const surface = String(r.surface).toLowerCase();
  if (surface === lemma) continue;
  if (!lemmaForms.has(lemma)) lemmaForms.set(lemma, new Set());
  lemmaForms.get(lemma)!.add(surface);
}
list.close();

// ---------- 规则屈折 ----------
// 单音节 CVC（辅-元-辅）双写规则（stop→stopped）；多音节太复杂不推
const CVC = (w: string) => /^[^aeiou][aeiou][^aeiou]$/.test(w);
const pl = (w: string) =>
  /(s|x|z|ch|sh)$/.test(w) ? w + "es" : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + "ies" : w + "s";
const past = (w: string) =>
  /e$/.test(w) ? w + "d" : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + "ied" : CVC(w) ? w + w.slice(-1) + "ed" : w + "ed";
const ing = (w: string) =>
  /e$/.test(w) ? (/(?:ee|ye|oe|ie)$/.test(w) ? w + "ing" : w.slice(0, -1) + "ing") : CVC(w) ? w + w.slice(-1) + "ing" : w + "ing";
const comp = (w: string) =>
  /[^aeiou]y$/.test(w) ? w.slice(0, -1) + "ier" : CVC(w) ? w + w.slice(-1) + "er" : w + "er";
const superl = (w: string) =>
  /[^aeiou]y$/.test(w) ? w.slice(0, -1) + "iest" : CVC(w) ? w + w.slice(-1) + "est" : w + "est";

// pos → 生成哪些形式（label 对齐 surfaces kinds 语义）
const RULES: Record<string, [label: string, fn: (w: string) => string][]> = {
  noun: [["plural", pl]],
  verb: [
    ["third_person_singular", pl],
    ["past", past],
    ["past_participle", past],
    ["present_participle", ing],
  ],
  adjective: [["comparative", comp], ["superlative", superl]],
};

// ---------- 候选词：无变形行 + senses 词性 ----------
const existing = new Set<string>(); // 全库已有 surface（防撞）
for (const r of dst.query("SELECT lower(surface) s FROM surfaces").all() as any[]) existing.add(r.s);

let tried = 0, skippedForms = 0, skippedAll = 0, skippedIrr = 0;
const added = new Map<string, number>(); // label → 新增 forms 数
// 防御：明显已是屈折/派生形态的词干不推断（abashed/a-levels/aas…）
// 形容词只对短词干（≤5 字母、无派生后缀）推比较级
const ALREADY_FLECTED = /(s|es|ed|ing|iest)$/i;
const DERIV_SUFFIX = /(able|ible|ful|ive|ous|less|al|ical|ish|like|ly|ic|ent|ant)$/i;
const SHORT_ADJ = (w: string) => w.length <= 5 && !DERIV_SUFFIX.test(w) && !/(e|est)$/.test(w);

const examples: string[] = [];
let candidates = 0;

for (const w of dst.query(`
  SELECT id, lemma FROM words w WHERE NOT EXISTS
  (SELECT 1 FROM surfaces s WHERE s.word_id=w.id AND s.kind='inflection')
`).all() as { id: number; lemma: string }[]) {
  const lemma = w.lemma.toLowerCase();
  // 该词可推断的词性（因词条可能有多个词性）
  const possOK = new Set<string>();
  for (const s of dst.query("SELECT DISTINCT pos FROM senses WHERE word_id=?").all(w.id) as any[])
    if (s.pos in RULES) possOK.add(s.pos);
  if (possOK.size === 0) continue;
  candidates++;

  // 词干已是屈折/派生形态 → 不整体推断（如 abashed、a-levels）
  if (ALREADY_FLECTED.test(lemma)) { skippedAll++; continue; }
  // 防御①：词表已登记该 lemma 的任何形式（不规则或已由 backfill 处理）
  if (lemmaForms.has(lemma)) { skippedIrr++; continue; }

  const forms: [string, string][] = [];
  for (const pos of possOK) for (const [label, fn] of RULES[pos]) {
    if (pos === "adjective" && !SHORT_ADJ(lemma)) continue; // 长形容词用 more/most
    forms.push([label, fn(lemma)]);
  }
  let any = false;
  for (const [label, surface] of forms) {
    const key = surface.toLowerCase();
    if (surface === lemma) continue;              // 推断出自身（如 -s 词根的复数）
    if (existing.has(key)) { skippedForms++; continue; } // 防御②：撞已有 surface
    existing.add(key);
    added[label] = (added[label] ?? 0) + 1;
    any = true;
    if (APPLY) dst.query("INSERT OR IGNORE INTO surfaces (surface, word_id, sense_id, kind, label) VALUES (?,?,?,?,?)")
      .run(surface, w.id, null, "inflection", label);
  }
  if (!any) skippedAll++;
  else if (examples.length < 12) examples.push(`${lemma} → ${forms.map(([l, s]) => `${s}(${l})`).join(", ")}`);
}

console.log(`候选词（noun/verb/adj 且无变形行）: ${candidates}`);
console.log(`跳过（词表已登记不规则/形式）: ${skippedIrr}`);
console.log(`推断后零新增（全撞面/自洽）: ${skippedAll}  撞形跳过: ${skippedForms}`);
console.log(`新增形式分布: ${Object.entries(added).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l}:${n}`).join("  ")}`);
console.log(`\n样例:`);
for (const e of examples) console.log("  " + e);
console.log(APPLY ? "\n已写入 dict_clean.db（--apply）" : "\n干跑完成（加 --apply 写入）");