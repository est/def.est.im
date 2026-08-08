// ============================================================
// 自洽（closure）共享逻辑：找出词典中"不可点击"的词
//
// 可查集合 = terms 表全部 surface（lemma + 变形 + 同反义 + 搭配），
// 命中任一即视为可查（点击会跳转到对应词条）。
// 已用词 = senses（def_en/example_en/pattern）+ associations（text）。
// 直接从数据库扫描，不依赖 YAML 文件（采集器默认不落盘 YAML）。
// ============================================================
import { Database } from "bun:sqlite";

const STOPWORDS = new Set(["sb", "sth", "sb.", "sth.", "e.g.", "etc."]);

function tokensOf(text: string): string[] {
  return (text.match(/[a-zA-Z][a-zA-Z'-]*/g) ?? [])
    .map((t) => t.toLowerCase().replace(/^['-]+|['-]+$/g, ""))
    .map((w) => (w.endsWith("'s") ? w.slice(0, -2) : w))
    .filter((w) => !w.includes("'") && w.length > 0 && !STOPWORDS.has(w) && !/^\d/.test(w));
}

// 扫描库内全部词条，返回未被 terms 覆盖的英文词（已排序）
export function findUncovered(db: Database): string[] {
  const covered = new Set<string>();
  for (const r of db.query("SELECT DISTINCT lower(surface) s FROM terms").all() as any[]) covered.add(r.s);
  const used = new Set<string>();
  const addText = (t: string | null | undefined) => {
    if (t) for (const w of tokensOf(t)) used.add(w);
  };
  for (const r of db.query("SELECT def_en, example_en, pattern FROM senses").all() as any[]) {
    addText(r.def_en);
    addText(r.example_en);
    addText(r.pattern);
  }
  for (const r of db.query("SELECT surface FROM terms WHERE kind IN ('synonym','antonym','collocation')").all() as any[]) addText(r.surface);
  const uncovered = new Set<string>();
  for (const w of used) if (!covered.has(w)) uncovered.add(w);
  return [...uncovered].sort();
}
