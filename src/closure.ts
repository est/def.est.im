// ============================================================
// 自洽（closure）共享逻辑：找出词典中"不可点击"的词
//
// 可查集合 = terms 表全部 surface（lemma + 变形 + 同反义 + 搭配），
// 命中任一即视为可查（点击会跳转到对应词条）。采集器与审计脚本共用。
// ============================================================
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parseYaml } from "./schema.ts";

const STOPWORDS = new Set(["sb", "sth", "sb.", "sth.", "e.g.", "etc."]);

function tokensOf(text: string): string[] {
  return (text.match(/[a-zA-Z][a-zA-Z'-]*/g) ?? [])
    .map((t) => t.toLowerCase().replace(/^['-]+|['-]+$/g, ""))
    .map((w) => (w.endsWith("'s") ? w.slice(0, -2) : w))
    .filter((w) => !w.includes("'") && w.length > 0 && !STOPWORDS.has(w) && !/^\d/.test(w));
}

// 扫描 wordsDir 下所有词条，返回未被 terms 覆盖的英文词（已排序）
export function findUncovered(db: Database, wordsDir: string): string[] {
  const covered = new Set<string>();
  for (const r of db.query("SELECT DISTINCT lower(surface) s FROM terms").all() as any[]) covered.add(r.s);
  const uncovered = new Set<string>();
  for (const file of readdirSync(wordsDir).filter((f) => f.endsWith(".yaml"))) {
    const p = parseYaml(readFileSync(join(wordsDir, file), "utf8"));
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
  return [...uncovered].sort();
}
