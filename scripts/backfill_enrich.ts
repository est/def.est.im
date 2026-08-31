// ============================================================
// 批量回填 enrich（scripts/backfill_enrich.ts）
//
// 目标词：音标双空 ∪ (freq>=10M 且单义项) ∪ 音标单空。
// 每个词一次 LLM 调用，同一 prompt 取回：音标 uk/us、完整义项、
// register、usage_notes、etymology（中文词源/助记）、同反义/搭配。
// 写入 dict_clean.db（覆盖式：words 更新 + senses 重插 + 同反义/搭配替换）。
//
// 断点续跑：data/enrich.live.json 记录已完成词；失败词不记录，重跑自动重试。
// 启动时若备份不存在则 cp dict_clean.db → dict_clean.db.pre-enrich.bak。
//
// 用法：
//   bun run scripts/backfill_enrich.ts --env .env.dev2 [--limit N] [--dry-run]
//   --limit N   只处理前 N 词（试跑）；--dry-run 只出统计不调 API
// ============================================================
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { loadEnv } from "../src/env.ts";

const DIR = import.meta.dir; // scripts/
const DATA_DIR = process.env.COLLECT_DATA_DIR ?? join(DIR, "..", "data");
const DB_PATH = join(DATA_DIR, "dict_clean.db");
const LIVE_PATH = join(DATA_DIR, "enrich.live.json");
const ENRICH_PATH = join(DATA_DIR, "enrich.json"); // 完整数据存档:未来 clean_migrate 重建后可 apply_enrich 恢复
const BAK_PATH = join(DATA_DIR, "dict_clean.db.pre-enrich.bak");

// ---------- env（默认 .env.dev2：批量补数据走 dev2 额度） ----------
const envIdx = process.argv.indexOf("--env");
const envFile = envIdx >= 0 ? process.argv[envIdx + 1] : ".env.dev2";
const env = loadEnv(envFile);
const API_ENTRY = env.API_ENTRY, API_TOKEN = env.API_TOKEN;
const MODEL = env.API_MODEL ?? "deepseek-v4-flash";
if (!API_ENTRY || !API_TOKEN) {
  console.error(`缺少 API_ENTRY / API_TOKEN（检查项目根 ${envFile}）`);
  process.exit(1);
}

const limitIdx = process.argv.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1], 10) : Infinity;
const DRY = process.argv.includes("--dry-run");
const CONC = 10;

if (!existsSync(DB_PATH)) throw new Error(`找不到 ${DB_PATH}`);
if (!existsSync(BAK_PATH)) {
  copyFileSync(DB_PATH, BAK_PATH);
  console.log(`备份 → ${BAK_PATH}`);
}

const db = new Database(DB_PATH);
db.run("PRAGMA busy_timeout = 5000");

// ---------- prompt：一次取回全部缺口 ----------
const ENRICH_PROMPT = `You are an English-Chinese learner's dictionary editor. Given the existing draft entry below, produce a COMPLETE, IMPROVED entry as STRICT raw JSON, no commentary, no code fences.

Schema:
{
  "word": "the word as given",
  "cefr": "A1/A2/B1/B2/C1/C2 (keep the draft value if present)",
  "phonetic_uk": "/IPA/", "phonetic_us": "/IPA/",   // REQUIRED: give both when determinable, at least one always
  "other_notes": "word-level notes — optional",
  "etymology": "short Chinese etymology or memory aid (词源或助记, 1-2 sentences) — REQUIRED",
  "entries": [
    {
      "pos": "noun|verb|adjective|adverb|preposition|conjunction|pronoun|interjection|article|phrase|idiom",
      "pattern": "required for phrase/idiom (e.g. run into [sb/sth])",
      "def_en": "simple English definition",
      "def_zh": "simple Chinese (mainland) definition",
      "example_en": "one simple example sentence (paired with example_zh)",
      "example_zh": "Chinese translation of the example",
      "register": "informal/formal/slang/technical… — optional but preferred",
      "usage_notes": "usage tips — optional but preferred",
      "synonyms": ["..."], "antonyms": ["..."], "collocations": ["..."]  // optional, word or phrase surfaces
    }
  ],
  "inflections": [ { "form": "plural|third_person_singular|present_participle|past|past_participle|comparative|superlative", "value": "..." } ]  // optional
}
Rules:
- KEEP every correct sense from the draft; EXPAND with missing common senses. For a common/high-frequency word list ALL major senses ordered by frequency of use — a learner must not miss major senses.
- Output at least as many entries as the draft has (never drop draft senses).
- Meanings most common first; entries at most 12; omit fields you are unsure about (no null/empty strings); example_en/example_zh always paired; definitions in simple learner language.`;

const POS_WHITELIST = ["noun", "verb", "adjective", "adverb", "preposition", "conjunction", "pronoun", "interjection", "article", "phrase", "idiom"];
const INFLECT_LABELS = ["plural", "third_person_singular", "present_participle", "past", "past_participle", "comparative", "superlative"];

// ---------- 校验（仿 src/lib/gen.js validate） ----------
function validate(data: any, word: string): number {
  if (!data || typeof data.word !== "string" || !data.word.trim()) throw new Error("word missing");
  const entries = data.entries ?? [];
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("entries empty");
  entries.forEach((e: any, i: number) => {
    if (!POS_WHITELIST.includes(e.pos)) throw new Error(`entries[${i}].pos invalid: ${e.pos}`);
    if (typeof e.def_en !== "string" || !e.def_en.trim()) throw new Error(`entries[${i}].def_en missing`);
    if (typeof e.def_zh !== "string" || !e.def_zh.trim()) throw new Error(`entries[${i}].def_zh missing`);
    const en = typeof e.example_en === "string" && e.example_en.trim() !== "";
    const zh = typeof e.example_zh === "string" && e.example_zh.trim() !== "";
    if (en !== zh) throw new Error(`entries[${i}] example pair mismatch`);
    if ((e.pos === "phrase" || e.pos === "idiom") && !(e.pattern && e.pattern.trim())) throw new Error(`entries[${i}] phrase/idiom needs pattern`);
  });
  // 白名单外的 inflection form（模型常给 singular/base/positive 等）忽略不写，
  // 不整词失败——音标/义项照常入库（inflections 本就由词表权威维护，不入库）
  for (const f of data.inflections ?? []) {
    if (!INFLECT_LABELS.includes(f.form)) continue;
    if (typeof f.value !== "string" || !f.value.trim()) continue;
  }
  return entries.length;
}

// ---------- 现有词条摘要（注入 prompt，防义项回退） ----------
function existingSummary(word: string): string {
  const w = db.query("SELECT phonetic_uk, phonetic_us, etymology FROM words WHERE lemma=?").get(word) as any;
  const senses = db.query(
    "SELECT sense_no, pos, def_en, def_zh FROM senses WHERE word_id=(SELECT id FROM words WHERE lemma=?) ORDER BY sense_no"
  ).all(word) as any[];
  const lines: string[] = [];
  if (w?.phonetic_uk || w?.phonetic_us) lines.push(`phonetic_uk: ${w.phonetic_uk ?? "-"} / phonetic_us: ${w.phonetic_us ?? "-"}`);
  else lines.push("phonetic: none");
  lines.push(`etymology: ${w?.etymology || "none"}`);
  if (!senses.length) lines.push("entries: none");
  else for (const s of senses) lines.push(`${s.sense_no}. ${s.pos} — ${s.def_en} / ${s.def_zh}`);
  return lines.join("\n");
}

// ---------- 生成（注意:opencode.ai zen 网关不支持 stream,用一次性返回；网关间歇挂起,重试 2 次） ----------
async function generateOne(word: string, summary: string): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API_ENTRY, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${API_TOKEN}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: ENRICH_PROMPT },
            { role: "user", content: `Existing draft for "${word}":\n${summary}\n\nOutput the complete improved entry JSON.` },
          ],
          max_tokens: 20000,
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
      let data;
      try {
        data = JSON.parse(cleaned);
      } catch (e) {
        throw new Error(`JSON parse fail: ${cleaned.slice(0, 300)}`);
      }
      return data;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ---------- 写回 dict_clean.db（覆盖式；cefr/freq 权威词表不动） ----------
function ingestLocal(data: any, word: string, minSenses: number) {
  const wid = (db.query("SELECT id FROM words WHERE lemma=?").get(word) as any)?.id;
  if (!wid) throw new Error(`word not found: ${word}`);
  const entries = data.entries ?? [];
  // 防回退：允许模型合并相近义项（大词 14→12 合理），明显偷懒（<80%）才拒绝
  if (entries.length < Math.max(1, Math.ceil(minSenses * 0.8))) throw new Error(`senses regressed: ${entries.length} < ${Math.max(1, Math.ceil(minSenses * 0.8))}`);
  const ph = (v: unknown): string | null => (typeof v === "string" && v.trim()) ? v.trim() : null;
  const old = db.query("SELECT phonetic_uk, phonetic_us, other_notes FROM words WHERE id=?").get(wid) as any;
  db.query(`UPDATE words SET phonetic_uk=?, phonetic_us=?, other_notes=?, etymology=?, raw_yaml=?, model=?, updated_at=datetime('now') WHERE id=?`)
    .run(ph(data.phonetic_uk) ?? old.phonetic_uk, ph(data.phonetic_us) ?? old.phonetic_us,
      data.other_notes ?? old.other_notes, data.etymology ?? null,
      JSON.stringify(data), "backfill-enrich", wid);
  db.query("DELETE FROM senses WHERE word_id=?").run(wid);
  db.query("DELETE FROM surfaces WHERE word_id=? AND kind IN ('synonym','antonym','collocation')").run(wid);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const res = db.query(`INSERT INTO senses (word_id, sense_no, pos, pattern, def_en, def_zh, example_en, example_zh, register, usage_notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(wid, i + 1, e.pos, e.pattern ?? null, e.def_en, e.def_zh,
        e.example_en ?? null, e.example_zh ?? null, e.register ?? null, e.usage_notes ?? null);
    const sid = Number(res.lastInsertRowid);
    for (const [key, kind] of [["synonyms", "synonym"], ["antonyms", "antonym"], ["collocations", "collocation"]] as const) {
      for (const s of e[key] ?? []) {
        db.query("INSERT OR IGNORE INTO surfaces (surface, word_id, sense_id, kind) VALUES (?,?,?,?)")
          .run(String(s).toLowerCase(), wid, sid, kind);
      }
    }
  }
}

// ---------- 纯解析迁移：raw_yaml 含 phonetic 但迁移遗漏的词（零 API） ----------
function migrateFromRawYaml(): number {
  const rows = db.query(
    "SELECT lemma, raw_yaml FROM words WHERE phonetic_uk IS NULL AND phonetic_us IS NULL AND raw_yaml IS NOT NULL AND instr(raw_yaml,'phonetic')>0"
  ).all() as any[];
  let n = 0;
  for (const r of rows) {
    const uk = /phonetic_uk:\s*(.+)$/m.exec(r.raw_yaml)?.[1]?.trim();
    const us = /phonetic_us:\s*(.+)$/m.exec(r.raw_yaml)?.[1]?.trim();
    const norm = (s?: string) => (s && /[^\x00-\x7f]|\//.test(s) && !s.includes(":")) ? s : null; // 形如 /ipa/ 或含音标字符
    if (norm(uk) || norm(us)) {
      db.query("UPDATE words SET phonetic_uk=?, phonetic_us=?, model='backfill-enrich', updated_at=datetime('now') WHERE lemma=?")
        .run(norm(uk), norm(us), r.lemma);
      n++;
    }
  }
  return n;
}

// ---------- 词集 ----------
const targets = (db.query(`
  SELECT lemma FROM words WHERE
    (phonetic_uk IS NULL AND phonetic_us IS NULL)
    OR ((phonetic_uk IS NULL) <> (phonetic_us IS NULL))
    OR (freq >= 10000000 AND (SELECT COUNT(*) FROM senses s WHERE s.word_id = words.id) = 1)
`).all() as any[]).map((r) => r.lemma as string);

// 断点续跑：已完成词加载（但音标仍缺的"假成功"剔除，重跑重试）
const done = new Set<string>();
if (existsSync(LIVE_PATH)) {
  for (const w of Object.keys(JSON.parse(readFileSync(LIVE_PATH, "utf8")))) {
    const phon = db.query("SELECT phonetic_uk, phonetic_us FROM words WHERE lemma=?").get(w) as any;
    if (phon && (phon.phonetic_uk || phon.phonetic_us)) done.add(w);
  }
}
let pending = targets.filter((w) => !done.has(w));
if (pending.length > limit) {
  console.log(`--limit ${limit}: 本轮只处理前 ${limit} 词`);
  pending = pending.slice(0, limit);
}

if (DRY) {
  const migratable = (db.query("SELECT COUNT(*) c FROM words WHERE phonetic_uk IS NULL AND phonetic_us IS NULL AND raw_yaml IS NOT NULL AND instr(raw_yaml,'phonetic')>0").get() as any).c;
  console.log(`词集：${targets.length}（raw_yaml 可迁移 ${migratable}，已完成 ${done.size}，待处理 ${pending.length}）`);
  console.log(`--dry-run: 样例 ${pending.slice(0, 10).join(", ")}`);
  db.close();
  process.exit(0);
}
const migrated = migrateFromRawYaml();
console.log(`词集：${targets.length}（raw_yaml 迁移 ${migrated}，已完成 ${done.size}，待处理 ${pending.length}）`);

// ---------- 并发跑批 ----------
const queue = [...pending];
let ok = 0, failed = 0, doneCount = 0;
const failures: { word: string; err: string }[] = [];
const live: Record<string, string> = {};
const enrich: Record<string, any> = existsSync(ENRICH_PATH) ? JSON.parse(readFileSync(ENRICH_PATH, "utf8")) : {};
for (const w of done) live[w] = "ok";

const saveLive = () => {
  writeFileSync(LIVE_PATH, JSON.stringify(live, null, 2));
  writeFileSync(ENRICH_PATH, JSON.stringify(enrich, null, 2)); // 存档完整数据(可重放)
};

async function worker() {
  for (;;) {
    const word = queue.shift();
    if (!word) return;
    const oldCount = (db.query("SELECT COUNT(*) c FROM senses s JOIN words w ON w.id=s.word_id WHERE w.lemma=?").get(word) as any).c;
    const minSenses = oldCount >= 2 ? oldCount : 1;
    const needPhon = (db.query("SELECT (phonetic_uk IS NULL AND phonetic_us IS NULL) OR ((phonetic_uk IS NULL) <> (phonetic_us IS NULL)) AS np FROM words WHERE lemma=?").get(word) as any).np === 1;
    try {
      const data = await generateOne(word, existingSummary(word));
      const n = validate(data, word);
      // 音标缺失目标词必须拿到音标，否则视为失败重试（防"成功但缺口仍在"的假成功）
      if (needPhon && !(data.phonetic_uk || data.phonetic_us)) throw new Error("phonetic still missing");
      ingestLocal(data, word, minSenses);
      live[word] = "ok";
      enrich[word] = data;
      ok++;
    } catch (e) {
      failed++;
      failures.push({ word, err: String(e).slice(0, 160) });
    }
    doneCount++;
    if (doneCount % 20 === 0) saveLive();
    if (doneCount % 20 === 0 || doneCount === pending.length) {
      console.log(`[进度] ${doneCount}/${pending.length}  成功 ${ok}  失败 ${failed}  ${pending.length - doneCount} 剩余`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));
await saveLive();

// ---------- 汇总 ----------
const afterPhon = (db.query("SELECT COUNT(*) c FROM words WHERE phonetic_uk IS NULL AND phonetic_us IS NULL").get() as any).c;
const afterSingle = (db.query("SELECT COUNT(*) c FROM words w WHERE freq >= 10000000 AND (SELECT COUNT(*) FROM senses s WHERE s.word_id=w.id) = 1").get() as any).c;
console.log(`\n=== 回填完成 ===`);
console.log(`成功 ${ok} / 失败 ${failed}`);
console.log(`音标双空：${afterPhon}（目标 0）  高频单义项：${afterSingle}`);
if (failures.length) {
  console.log(`失败样例（前 10）：`);
  for (const f of failures.slice(0, 10)) console.log(`  ${f.word}: ${f.err}`);
  console.log(`（失败词未写入断点，重跑自动重试）`);
}
db.close();
