// ============================================================
// 缺失字段补全（scripts/backfill_missing.ts）
//
// 目标：freq≥1M 且缺 etymology 或 other_notes 的词（~23k）。
// 每词一次 LLM 调用（YAML 交互，见 docs/ai-dictionary-schema.md）：
//   - 输入：词条关键摘要（lemma/freq/cefr/现有义项一行一个/现有 other_notes）
//     ——不呈完整 YAML，摘取关键信息，前缀缓存友好
//   - 输出：etymology（防幻觉：不确定写 unknown，不编造）、other_notes、
//     add_entries（补漏的义项/短语/习语/当代流行用法）
//   - 只补缺失字段 + 新增义项，不覆盖已有
//
// 断点续跑：data/missing.live.json；失败词不入 live 自动重试。
// 用法：bun run scripts/backfill_missing.ts [--limit N] [--min-freq 1000000]
//   env：.env.dev2（API_ENTRY/API_TOKEN/API_MODEL）
// ============================================================
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { parseDocument } from "../src/node_modules/yaml/dist/index.js"; // scripts/ 无 node_modules，直连 src 的 yaml 包
import { loadEnv } from "../src/env.ts";

const DIR = import.meta.dir;
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const DB_PATH = join(DATA_DIR, "dict_clean.db");
const LIVE_PATH = join(DATA_DIR, "missing.live.json");

const env = loadEnv(".env.dev2");
const API_ENTRY = env.API_ENTRY, API_TOKEN = env.API_TOKEN;
const MODEL = env.API_MODEL ?? "deepseek-v4-flash";
if (!API_ENTRY || !API_TOKEN) { console.error("缺少 API_ENTRY/API_TOKEN（.env.dev2）"); process.exit(1); }

const limitIdx = process.argv.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;
const mfIdx = process.argv.indexOf("--min-freq");
const MIN_FREQ = mfIdx >= 0 ? parseInt(process.argv[mfIdx + 1], 10) : 1000000;
const CONC = 10;

const db = new Database(DB_PATH);
db.run("PRAGMA busy_timeout = 5000");

const POS_WHITELIST = ["noun", "verb", "adjective", "adverb", "preposition", "conjunction", "pronoun", "interjection", "article", "phrase", "idiom"];

// system prompt 固定（前缀缓存命中最大化）
const SYSTEM = `You are an English-Chinese learner's dictionary editor, extending existing entries. The user gives a word's key info (its senses summarized one per line). Your job:
1. Add "etymology": short Chinese etymology or memory aid, 1-2 sentences. CRITICAL: if you are not certain about the origin, write exactly "unknown" — NEVER guess or fabricate.
2. Add "other_notes" only if there is genuinely useful word-level info not already covered (special pronunciation, weak forms, grammar quirks, spelling variants, usage pitfalls). Omit if nothing to add.
3. Add "add_entries": senses MISSING from the existing list — overlooked common senses, phrasal verbs, idioms, collocations-as-phrases, or current/popular usage (slang, internet usage). Do NOT repeat existing senses. Only add what a learner would genuinely need.

Output STRICT YAML, no code fences, no "---" header, no commentary:
etymology: |
  中文词源或助记（不确定写 unknown）
other_notes: |      # 可选，没有把握可整行省略
  词级说明
add_entries:        # 补漏义项，按常用度降序；没有可省略整个键
  - pos: verb       # noun|verb|adjective|adverb|preposition|conjunction|pronoun|interjection|article|phrase|idiom
    pattern: run into sb.   # 仅 idiom/phrase 必填
    def_en: one-line simple English definition
    def_zh: 中文释义
    example_en: sentence      # 例句必须与 example_zh 成对
    example_zh: 例句翻译
    register: informal       # 可选
    usage_notes: |           # 可选，出现冒号/引号时用块标量
      用法说明
    synonyms:               # 可选，逐条一行
      - word
Rules: block style only, never flow ([a, b] / {a: b}); one sense per entry; examples always paired; omit unsure fields (no null, no empty strings).`;

function stripFence(raw: string): string {
  const m = raw.match(/^\s*```(?:yaml)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  return m ? m[1] : raw;
}

// ---------- LLM 调用（非流式 + 强重试：5 次，指数退避） ----------
async function callModel(word: string, summary: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(API_ENTRY, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${API_TOKEN}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: summary }],
          max_tokens: 8000,
          temperature: 0.3,
          stream: false,
        }),
        signal: AbortSignal.timeout(240000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data0 = await res.json();
      const raw = data0.choices?.[0]?.message?.content ?? "";
      if (!raw) throw new Error("empty reply");
      return raw;
    } catch (e) {
      lastErr = e;
      if (attempt < 4) await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ---------- 校验输出 YAML ----------
function parseOut(raw: string): { etymology?: string; other_notes?: string; add: any[] } {
  const text = stripFence(raw);
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`YAML parse fail: ${doc.errors[0].message}`);
  const data = doc.toJS() ?? {};
  const add = Array.isArray(data.add_entries) ? data.add_entries : [];
  for (let i = 0; i < add.length; i++) {
    const e = add[i];
    if (!e || typeof e !== "object") throw new Error(`add_entries[${i}] not object`);
    if (!POS_WHITELIST.includes(e.pos)) throw new Error(`add_entries[${i}].pos invalid: ${e.pos}`);
    if (typeof e.def_en !== "string" || !e.def_en.trim()) throw new Error(`add_entries[${i}].def_en missing`);
    if (typeof e.def_zh !== "string" || !e.def_zh.trim()) throw new Error(`add_entries[${i}].def_zh missing`);
    const en = typeof e.example_en === "string" && e.example_en.trim() !== "";
    const zh = typeof e.example_zh === "string" && e.example_zh.trim() !== "";
    if (en !== zh) throw new Error(`add_entries[${i}] example pair mismatch`);
    if ((e.pos === "idiom" || e.pos === "phrase") && !(e.pattern && e.pattern.trim())) throw new Error(`add_entries[${i}] idiom/phrase needs pattern`);
  }
  return {
    etymology: typeof data.etymology === "string" && data.etymology.trim() ? data.etymology.trim() : undefined,
    other_notes: typeof data.other_notes === "string" && data.other_notes.trim() ? data.other_notes.trim() : undefined,
    add,
  };
}

// ---------- 写回 ----------
function ingest(word: string, out: { etymology?: string; other_notes?: string; add: any[] }) {
  const w = db.query("SELECT id, etymology, other_notes FROM words WHERE lemma=?").get(word) as any;
  if (!w) throw new Error(`word not found: ${word}`);
  // 词级：只补缺失；etymology 输出为 unknown 视为不确定 → 保持空值（防幻觉）
  if ((!w.etymology || !w.etymology.trim()) && out.etymology && !/^unknown$/i.test(out.etymology)) {
    db.query("UPDATE words SET etymology=?, updated_at=datetime('now') WHERE id=?").run(out.etymology, w.id);
  }
  if ((!w.other_notes || !w.other_notes.trim()) && out.other_notes) {
    db.query("UPDATE words SET other_notes=?, updated_at=datetime('now') WHERE id=?").run(out.other_notes, w.id);
  }
  // 新增义项：与现有 def_en 去重后追加
  const existing = new Set((db.query("SELECT def_en FROM senses WHERE word_id=?").all(w.id) as any[]).map((s) => String(s.def_en).toLowerCase().trim()));
  let maxNo = (db.query("SELECT MAX(sense_no) mn FROM senses WHERE word_id=?").get(w.id) as any).mn ?? 0;
  for (const e of out.add) {
    if (existing.has(String(e.def_en).toLowerCase().trim())) continue;
    existing.add(String(e.def_en).toLowerCase().trim());
    maxNo++;
    const res = db.query(`INSERT INTO senses (word_id, sense_no, pos, pattern, def_en, def_zh, example_en, example_zh, register, usage_notes, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now'), datetime('now'))`)
      .run(w.id, maxNo, e.pos, e.pattern ?? null, e.def_en, e.def_zh,
        e.example_en ?? null, e.example_zh ?? null, e.register ?? null, e.usage_notes ?? null);
    const sid = Number(res.lastInsertRowid);
    for (const [key, kind] of [["synonyms", "synonym"], ["antonyms", "antonym"], ["collocations", "collocation"]] as const) {
      for (const s of e[key] ?? []) {
        if (typeof s !== "string" || !s.trim()) continue;
        db.query("INSERT OR IGNORE INTO surfaces (surface, word_id, sense_id, kind) VALUES (?,?,?,?)")
          .run(String(s).toLowerCase(), w.id, sid, kind);
      }
    }
  }
}

// ---------- 目标词集 ----------
const targets = (db.query(`
  SELECT lemma FROM words
  WHERE freq >= ${MIN_FREQ}
    AND ((etymology IS NULL OR etymology = '') OR (other_notes IS NULL OR other_notes = ''))
  ORDER BY freq DESC
`).all() as any[]).map((r) => r.lemma as string);

const done = new Set<string>();
if (existsSync(LIVE_PATH)) {
  for (const w of Object.keys(JSON.parse(readFileSync(LIVE_PATH, "utf8")))) done.add(w);
}
let pending = targets.filter((w) => !done.has(w));
if (pending.length > limit) { console.log(`--limit ${limit}`); pending = pending.slice(0, limit); }
console.log(`目标词 ${targets.length}（min-freq=${MIN_FREQ}），已完成 ${done.size}，待处理 ${pending.length}`);

const queue = [...pending];
let ok = 0, failed = 0, doneCount = 0, nEty = 0, nNotes = 0, nAdd = 0;
const failures: { word: string; err: string }[] = [];
const live: Record<string, string> = {};
for (const w of done) live[w] = "ok";
const saveLive = () => writeFileSync(LIVE_PATH, JSON.stringify(live, null, 2));

async function worker() {
  for (;;) {
    const word = queue.shift();
    if (!word) return;
    try {
      const w = db.query("SELECT cefr, freq, etymology, other_notes FROM words WHERE lemma=?").get(word) as any;
      const senses = (db.query(
        "SELECT sense_no, pos, pattern, def_en, def_zh FROM senses WHERE word_id=(SELECT id FROM words WHERE lemma=?) ORDER BY sense_no"
      ).all(word) as any[]);
      // 摘取关键信息（不呈完整 YAML，前缀缓存友好）：一行一个义项
      const lines = [
        `word: ${word}  freq: ${w.freq ?? "-"}  cefr: ${w.cefr ?? "-"}`,
        `existing etymology: ${w.etymology ? "yes" : "no"}  existing other_notes: ${w.other_notes ? "yes" : "no"}`,
        "existing senses:",
      ];
      for (const s of senses) {
        lines.push(`  ${s.sense_no}. [${s.pos}] ${s.def_en} / ${s.def_zh}${s.pattern ? ` (pattern: ${s.pattern})` : ""}`);
      }
      if (w.other_notes) lines.push(`existing other_notes: ${String(w.other_notes).slice(0, 200)}`);
      const raw = await callModel(word, lines.join("\n"));
      const out = parseOut(raw);
      ingest(word, out);
      if (out.etymology && !/^unknown$/i.test(out.etymology)) nEty++;
      if (out.other_notes) nNotes++;
      nAdd += out.add.length;
      live[word] = "ok";
      ok++;
    } catch (e) {
      failed++;
      failures.push({ word, err: String(e).slice(0, 120) });
    }
    doneCount++;
    if (doneCount % 20 === 0) saveLive();
    if (doneCount % 20 === 0 || doneCount === pending.length) {
      console.log(`[进度] ${doneCount}/${pending.length} 成功 ${ok} 失败 ${failed} 词源 ${nEty} 备注 ${nNotes} 新增义项 ${nAdd}`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));
await saveLive();

const afterEty = (db.query("SELECT COUNT(*) c FROM words WHERE etymology IS NOT NULL AND etymology != ''").get() as any).c;
const afterNotes = (db.query("SELECT COUNT(*) c FROM words WHERE other_notes IS NOT NULL AND other_notes != ''").get() as any).c;
console.log(`\n完成：成功 ${ok} / 失败 ${failed}，词源 +${nEty} 备注 +${nNotes} 新增义项 +${nAdd}`);
console.log(`词源覆盖 ${afterEty}/44863，备注覆盖 ${afterNotes}/44863`);
if (failures.length) console.log("失败样例:", failures.slice(0, 5).map((f) => `${f.word}: ${f.err}`).join(" | "));
db.close();