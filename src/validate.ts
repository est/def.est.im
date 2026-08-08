import { parseDocument } from "yaml";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDb, findFlow, ingest, parseYaml, validate } from "./schema.ts";

const SAMPLES = join(import.meta.dir, "samples");
const SCHEMA_DOC = join(import.meta.dir, "..", "docs", "ai-dictionary-schema.md");

let pass = 0, fail = 0, warn = 0;
const report = (ok: boolean, msg: string) => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`);
};

console.log("== 1. schema 文档自带的 YAML 示例可解析性 ==");
{
  const text = readFileSync(SCHEMA_DOC, "utf8");
  const blocks = [...text.matchAll(/```yaml\n([\s\S]*?)```/g)];
  report(blocks.length >= 3, `从 schema 文档提取到 ${blocks.length} 个 yaml 代码块`);
  blocks.forEach((b, i) => {
    const doc = parseDocument(b[1]);
    report(doc.errors.length === 0, `示例块 #${i + 1} 解析成功` + (doc.errors.length ? ` — ${doc.errors[0].message}` : ""));
  });
}

console.log("\n== 2. 样本校验（含失败路径与 flow 检测）==");
const expects: Record<string, "valid" | "invalid"> = {
  "run.yaml": "valid", "the.yaml": "valid", "tear.yaml": "valid", "tear-2.yaml": "valid",
  "walk.yaml": "valid", "talk.yaml": "valid", "lie.yaml": "valid",
  "sleep.yaml": "invalid", "fly.yaml": "invalid", "hop.yaml": "invalid", "quick.yaml": "invalid", "guess.yaml": "invalid",
};
const parsed: any[] = [];
for (const file of Object.keys(expects).sort()) {
  const p = parseYaml(readFileSync(join(SAMPLES, file), "utf8"));
  if (!p.ok) {
    report(expects[file] === "invalid", `${file}: 解析失败（${p.error}）`);
    continue;
  }
  const r = validate(file, p.doc);
  const ok = r.errors.length === 0;
  const expect = expects[file];
  report(ok === (expect === "valid"), `${file}: ${ok ? "通过" : r.errors.join("; ")}（期望 ${expect}）`);
  for (const w of r.warns) { warn++; console.log(`  WARN   ${file}: ${w}`); }
  for (const h of findFlow(p.doc.contents, p.text)) { warn++; console.log(`  NOTE   ${file}: 第${h}行 flow 风格（仅警告，不拒绝）`); }
  if (ok) parsed.push({ file, ...r });
}

console.log("\n== 3. SQLite：同形词冲突演示（旧 schema）==");
{
  const dbOld = new Database(":memory:");
  dbOld.run("CREATE TABLE words (id INTEGER PRIMARY KEY, lemma TEXT NOT NULL COLLATE NOCASE UNIQUE)");
  dbOld.run("INSERT INTO words (lemma) VALUES ('tear')");
  let collision = false;
  try { dbOld.run("INSERT INTO words (lemma) VALUES ('tear')"); } catch { collision = true; }
  report(collision, "旧 schema（UNIQUE lemma）插入第二个 tear 触发唯一约束冲突 → 证实同形词缺陷");
  dbOld.close();
}

console.log("\n== 4. SQLite：建库入库（修复版 UNIQUE(lemma, variant)）==");
const db = createDb(new Database(":memory:"));

for (const p of parsed) ingest(db, p.data, p.word, p.variant, "validate");
const wordCount = (db.query("SELECT COUNT(*) c FROM words").get() as any).c;
report(wordCount === 7, `words ${wordCount} 行（run/the/tear×2/walk/talk/lie）——同形词 tear 双行共存`);

console.log("\n== 5. 检索查询 ==");
function lookup(term: string): any[] {
  return db.query(`SELECT DISTINCT t.word_id, w.lemma, w.variant
    FROM terms t JOIN words w ON w.id = t.word_id
    WHERE t.surface = ? ORDER BY w.lemma, w.variant`).all(term);
}
function check(term: string, expected: string[]) {
  const got = lookup(term).map((r: any) => r.lemma + (r.variant ? `#${r.variant}` : ""));
  report(JSON.stringify(got) === JSON.stringify(expected), `${term} → [${got.join(", ")}]（期望 [${expected.join(", ")}]）`);
}
check("ran", ["run"]);
const ranRawCount = (db.query("SELECT COUNT(*) c FROM terms WHERE surface='ran'").get() as any).c;
report(ranRawCount === 1, `terms 表 surface='ran' 裸计数 ${ranRawCount}（应为 1，防 entry 循环内重复插入变形）`);
check("RUN", ["run"]);
check("sprint", ["run"]);
check("walk", ["run", "walk"]);
check("run a marathon", ["run"]);
check("tore", ["tear#2"]);
check("tear", ["tear", "tear#2"]);
check("the", ["the"]);
check("talk", ["talk"]);

const prefix = db.query(`SELECT DISTINCT surface FROM terms WHERE surface LIKE 'run%' ORDER BY surface`).all().map((r: any) => r.surface);
report(["run", "running", "runs"].every((s) => prefix.includes(s)), `前缀 run% → ${prefix.join(", ")}（含 run/running/runs）`);

function phraseSearch(phrase: string): any[] {
  const lower = phrase.toLowerCase();
  const first = lower.split(/\s+/)[0];
  const rest = lower.slice(first.length).trim();
  const out: any[] = [];
  for (const h of lookup(first)) {
    const rows = db.query(`SELECT pattern, def_zh FROM senses
      WHERE word_id=? AND pos IN ('idiom','phrase') AND pattern LIKE ?`)
      .all(h.word_id, `%${h.lemma}${rest ? " " + rest : ""}%`);
    for (const r of rows) out.push({ lemma: h.lemma, pattern: r.pattern, def_zh: r.def_zh });
  }
  return out;
}
const ph = phraseSearch("ran into");
report(ph.length === 1 && ph[0].pattern === "run into sb.", `'ran into' 两步链 → ${ph.map((p: any) => p.pattern).join(", ") || "无结果"}（期望 run into sb.）`);

console.log("\n== 6. 三步检索算法端到端 ==");
function search(q: string) {
  const exact = lookup(q);
  if (exact.length > 0) return { step: "exact", results: exact };
  const ph2 = phraseSearch(q);
  if (ph2.length > 0) return { step: "phrase", results: ph2 };
  const sugg = db.query(`SELECT DISTINCT surface FROM terms WHERE surface LIKE ? ORDER BY surface LIMIT 5`).all(`${q}%`).map((r: any) => r.surface);
  return { step: "suggest", results: sugg };
}
const s1 = search("ran");
report(s1.step === "exact" && s1.results.some((r: any) => r.lemma === "run"), `search("ran") → ${s1.step} 命中 run`);
const s2 = search("ran into");
report(s2.step === "phrase" && (s2.results as any)[0].pattern === "run into sb.", `search("ran into") → ${s2.step} → run into sb.`);
const s3 = search("runn");
report(s3.step === "suggest" && (s3.results as string[]).includes("running"), `search("runn") → ${s3.step} → ${(s3.results as string[]).join(", ")}`);
const s4 = search("TALK");
report(s4.step === "exact" && s4.results.some((r: any) => r.lemma === "talk"), `search("TALK") → ${s4.step} 命中 talk（大小写不敏感）`);

db.close();
console.log(`\n===== 汇总：通过 ${pass}，失败 ${fail}，警告 ${warn} =====`);
process.exit(fail > 0 ? 1 : 0);
