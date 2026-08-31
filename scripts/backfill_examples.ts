// ============================================================
// 例句补全（scripts/backfill_examples.ts）
//
// 目标：freq≥1M 且义项缺 example_en/example_zh 的词条（~1264 词）。
// 每词一次 LLM 调用：给出全部义项（含已有例句），模型只补缺例句的
// 义项（example_en/example_zh 成对）。写回 UPDATE（不重写整词）。
//
// 断点续跑：data/examples.live.json；失败词不记录自动重试。
// 用法：bun run scripts/backfill_examples.ts [--limit N]
//   env：.env.dev2（API_ENTRY/API_TOKEN/API_MODEL，同 backfill_enrich）
// ============================================================
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadEnv } from "../src/env.ts";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const DB_PATH = join(DATA_DIR, "dict_clean.db");
const LIVE_PATH = join(DATA_DIR, "examples.live.json");

const env = loadEnv(".env.dev2");
const API_ENTRY = env.API_ENTRY, API_TOKEN = env.API_TOKEN;
const MODEL = env.API_MODEL ?? "deepseek-v4-flash";
if (!API_ENTRY || !API_TOKEN) { console.error("缺少 API_ENTRY/API_TOKEN（.env.dev2）"); process.exit(1); }

const limitIdx = process.argv.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;
const CONC = 10;
const db = new Database(DB_PATH);
db.run("PRAGMA busy_timeout = 5000");

const PROMPT = `You are an English-Chinese learner's dictionary editor. Below is a word with its senses. Some senses are missing example sentences. For EVERY sense that lacks "example_en"/"example_zh", write ONE simple example sentence (English) with its Chinese translation. Keep existing examples unchanged.

Output STRICT raw JSON (no commentary, no code fences):
{"examples": {"<sense_no>": {"example_en": "...", "example_zh": "..."}}}
Only include senses that are missing examples. If none missing, output {"examples": {}}.

Rules: example_en and example_zh always paired; simple learner language; one sentence each.`;

// ---------- LLM 调用（非流式 + 重试，同 backfill_enrich） ----------
async function fetchExamples(word: string, sensesTxt: string): Promise<Map<number, { en: string; zh: string }>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API_ENTRY, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${API_TOKEN}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "system", content: PROMPT }, { role: "user", content: `word: ${word}\n${sensesTxt}` }],
          max_tokens: 4000,
          temperature: 0.3,
          stream: false,
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data0 = await res.json();
      const raw = data0.choices?.[0]?.message?.content ?? "";
      if (!raw) throw new Error("empty reply");
      const cleaned = raw.replace(/^\s*```json?\s*/, "").replace(/```\s*$/, "").trim();
      const parsed = JSON.parse(cleaned);
      const out = new Map<number, { en: string; zh: string }>();
      for (const [k, v] of Object.entries(parsed?.examples ?? {})) {
        const en = String((v as any)?.example_en ?? "").trim();
        const zh = String((v as any)?.example_zh ?? "").trim();
        if (en && zh && /^\d+$/.test(k)) out.set(parseInt(k, 10), { en, zh });
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ---------- 目标词集：freq≥1M 且至少一个义项缺例句 ----------
const targets = (db.query(`
  SELECT DISTINCT w.lemma FROM senses s JOIN words w ON w.id = s.word_id
  WHERE (s.example_en IS NULL OR s.example_en = '') AND w.freq >= 1000000
`).all() as any[]).map((r) => r.lemma as string);

const done = new Set<string>();
if (existsSync(LIVE_PATH)) {
  for (const w of Object.keys(JSON.parse(readFileSync(LIVE_PATH, "utf8")))) done.add(w);
}
let pending = targets.filter((w) => !done.has(w));
if (pending.length > limit) { console.log(`--limit ${limit}`); pending = pending.slice(0, limit); }
console.log(`目标词 ${targets.length}，已完成 ${done.size}，待处理 ${pending.length}`);

const queue = [...pending];
let ok = 0, failed = 0, doneCount = 0, examplesAdded = 0;
const failures: { word: string; err: string }[] = [];
const live: Record<string, string> = {};
for (const w of done) live[w] = "ok";
const saveLive = () => writeFileSync(LIVE_PATH, JSON.stringify(live, null, 2));

async function worker() {
  for (;;) {
    const word = queue.shift();
    if (!word) return;
    try {
      // 现有义项摘要（含已有例句，标注缺例句的）
      const senses = (db.query(
        "SELECT sense_no, pos, def_en, def_zh, example_en, example_zh FROM senses WHERE word_id=(SELECT id FROM words WHERE lemma=?) ORDER BY sense_no"
      ).all(word) as any[]);
      const lines = senses.map((s) =>
        `${s.sense_no}. [${s.pos}] ${s.def_en} / ${s.def_zh}` + (s.example_en ? `\n   ex: ${s.example_en} / ${s.example_zh}` : "（缺例句）")
      );
      const exMap = await fetchExamples(word, lines.join("\n"));
      let added = 0;
      for (const [senseNo, ex] of exMap) {
        const r = db.query("UPDATE senses SET example_en=?, example_zh=? WHERE word_id=(SELECT id FROM words WHERE lemma=?) AND sense_no=? AND (example_en IS NULL OR example_en='')")
          .run(ex.en, ex.zh, word, senseNo);
        added += r.changes;
      }
      examplesAdded += added;
      live[word] = "ok";
      ok++;
    } catch (e) {
      failed++;
      failures.push({ word, err: String(e).slice(0, 120) });
    }
    doneCount++;
    if (doneCount % 20 === 0) saveLive();
    if (doneCount % 20 === 0 || doneCount === pending.length) {
      console.log(`[进度] ${doneCount}/${pending.length} 成功 ${ok} 失败 ${failed} 补例句 ${examplesAdded}`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));
await saveLive();

const left = (db.query("SELECT COUNT(*) c FROM senses s JOIN words w ON w.id=s.word_id WHERE (s.example_en IS NULL OR s.example_en='') AND w.freq>=1000000").get() as any).c;
console.log(`\n完成：成功 ${ok} / 失败 ${failed}，本次补例句 ${examplesAdded}，剩余缺例句高频义项 ${left}`);
if (failures.length) console.log("失败样例:", failures.slice(0, 5).map((f) => `${f.word}: ${f.err}`).join(" | "));
db.close();