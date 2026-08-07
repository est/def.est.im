// ============================================================
// 自洽审计（audit.ts）
//
// 目标：词典 closure —— 词条（释义/例句/同反义/搭配/pattern）里出现的
//       每个英文词都应当可查（要么已是条目/词形/关联词，要么还在队列里）。
//       检查范围 = terms 表的所有 surface（lemma + 变形 + 同反义 + 搭配），
//       命中任一即视为"可查"（点击会跳转到对应词条）。
//
// 用法：
//   bun run src/audit.ts             # 只报告缺口
//   bun run src/audit.ts --enqueue   # 把缺口词写回 state.json 队列（unknown 桶）
//
// 配合采集器形成闭环：跑一批 → audit --enqueue → 再跑 → … 直到缺口为零。
// ============================================================
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createDb, parseYaml } from "./schema.ts";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const WORDS_DIR = join(DATA_DIR, "words");
const STATE_PATH = join(DATA_DIR, "state.json");
const db = createDb(new Database(join(DATA_DIR, "dict.db")));

// 可查集合：DB 里所有 lemma + 变形 + 同反义 + 搭配
const covered = new Set<string>();
for (const r of db.query("SELECT DISTINCT lower(surface) s FROM terms").all() as any[]) covered.add(r.s);

// 占位符类不构成词条（sb./sth.）；数字剔除
const STOPWORDS = new Set(["sb", "sth", "sb.", "sth.", "e.g.", "etc."]);

function tokensOf(text: string): string[] {
  return (text.match(/[a-zA-Z][a-zA-Z'-]*/g) ?? [])
    .map((t) => t.toLowerCase().replace(/^['-]+|['-]+$/g, ""))
    .map((w) => (w.endsWith("'s") ? w.slice(0, -2) : w))
    .filter((w) => !w.includes("'") && w.length > 0 && !STOPWORDS.has(w) && !/^\d/.test(w));
}

// 汇总所有词条里出现的英文词，找未被覆盖的
const uncovered = new Set<string>();
for (const file of readdirSync(WORDS_DIR).filter((f) => f.endsWith(".yaml"))) {
  const p = parseYaml(readFileSync(join(WORDS_DIR, file), "utf8"));
  if (!p.ok) continue;
  const texts: string[] = [];
  for (const e of p.data.entries ?? []) {
    if (e.def_en) texts.push(e.def_en);
    if (e.example_en) texts.push(e.example_en);
    if (e.pattern) texts.push(e.pattern);
    for (const s of [...(e.synonyms ?? []), ...(e.antonyms ?? []), ...(e.collocations ?? [])]) texts.push(s);
  }
  for (const t of texts) for (const w of tokensOf(t)) if (!covered.has(w)) uncovered.add(w);
}

console.log(`已可查词数：${covered.size}，自洽缺口：${uncovered.size}`);
const sorted = [...uncovered].sort();
console.log(`缺口示例（前 80）：${sorted.slice(0, 80).join(", ")}`);

if (process.argv.includes("--enqueue")) {
  // 保留现有队列/断点，把缺口词加入 unknown 桶（等级未知，放末位由优先级自然处理）
  const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : { processed: 0 };
  const buckets: Record<string, string[]> = { A1: [], A2: [], B1: [], B2: [], C1: [], C2: [], unknown: [] };
  for (const k of Object.keys(buckets)) buckets[k] = state.buckets?.[k] ?? [];
  const visited = new Set<string>(state.visited ?? []);
  let added = 0;
  for (const w of sorted) {
    if (visited.has(w)) continue;
    visited.add(w);
    buckets.unknown.push(w);
    added++;
  }
  writeFileSync(STATE_PATH, JSON.stringify({ buckets, visited: [...visited], processed: state.processed ?? 0 }, null, 2));
  console.log(`已写回队列：${added} 词（unknown 桶），下次运行自动补齐`);
}
db.close();
